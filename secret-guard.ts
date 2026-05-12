/**
 * Secret Guard Extension
 *
 * Keeps secret values out of the LLM's context by combining two defences:
 *
 *   1. BLOCK  — Intercepts tool calls (bash, read, write, edit, ls, grep, find)
 *               that try to access a .pi/.secrets/ directory and rejects them
 *               before they execute.
 *
 *   2. REDACT — Scans every tool result after execution and replaces any known
 *               secret value with [REDACTED:<name>] before the LLM sees it.
 *               This is the safety net for anything that slips past the block.
 *
 * Secret locations (both are loaded at session start):
 *
 *   Global:  ~/.pi/.secrets/      shared across all projects
 *   Project: <cwd>/.pi/.secrets/  per-project, resolved from ctx.cwd
 *
 * Each file in those directories is one secret. The filename is the label used
 * in redaction messages. If the same filename exists in both locations, both
 * values are redacted independently under the same label.
 *
 * Setup:
 *   mkdir -p ~/.pi/.secrets
 *   echo "sk-abc123" > ~/.pi/.secrets/api_key && chmod 600 ~/.pi/.secrets/api_key
 *
 *   # Per-project (add .pi/.secrets/ to .gitignore, not the whole .pi/ dir):
 *   mkdir -p .pi/.secrets
 *   echo "sk-xyz789" > .pi/.secrets/stripe_key && chmod 600 .pi/.secrets/stripe_key
 *
 * Skill scripts read from the file directly — the block only intercepts commands
 * the pi bash tool sees at its top level, not what runs inside a script:
 *
 *   API_KEY=$(cat ~/.pi/.secrets/api_key)
 *
 * Commands:
 *   /secrets-reload  — Reload from both locations without restarting pi.
 *   /secrets-status  — Show loaded secret names per location (no values shown).
 *
 * Limitations:
 *   The block is string-based. A bash command that builds the secrets path
 *   dynamically (e.g. via variable concatenation) can bypass it. The redact
 *   step handles that case as long as the value appears in the output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const GLOBAL_SECRETS_DIR = join(homedir(), ".pi", ".secrets");

type Secret = { name: string; value: string; source: "global" | "project" };

/** Returns the project-level secrets dir for the given cwd. */
function projectSecretsDir(cwd: string): string {
	return join(cwd, ".pi", ".secrets");
}

/** Bash command patterns that indicate access to a secrets directory. */
function bashPatterns(cwd: string): string[] {
	const projectDir = projectSecretsDir(cwd);
	return [
		// global
		GLOBAL_SECRETS_DIR,
		"~/.pi/.secrets",
		"$HOME/.pi/.secrets",
		"${HOME}/.pi/.secrets",
		// project (absolute + relative forms)
		projectDir,
		".pi/.secrets",
	];
}

/** Returns true if the given path resolves inside any of the secrets directories. */
function isInsideAnySecretsDir(inputPath: string, cwd: string): boolean {
	const expanded = inputPath.startsWith("~")
		? join(homedir(), inputPath.slice(1))
		: inputPath;
	const resolved = resolve(cwd, expanded);
	const dirs = [GLOBAL_SECRETS_DIR, projectSecretsDir(cwd)];
	return dirs.some((dir) => resolved === dir || resolved.startsWith(dir + "/"));
}

/** Loads secrets from a single directory, tagged with their source. */
function loadFromDir(dir: string, source: "global" | "project"): Secret[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => !f.startsWith("."))
			.flatMap((filename) => {
				try {
					const value = readFileSync(join(dir, filename), "utf-8").trim();
					return value ? [{ name: filename, value, source }] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/** Loads secrets from both global and project locations. */
function loadSecrets(cwd: string): Secret[] {
	return [
		...loadFromDir(GLOBAL_SECRETS_DIR, "global"),
		...loadFromDir(projectSecretsDir(cwd), "project"),
	];
}

function redactSecrets(text: string, secrets: Secret[]): string {
	let result = text;
	for (const { name, value } of secrets) {
		const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(escaped, "g"), `[REDACTED:${name}]`);
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	let secrets: Secret[] = [];

	// ── Load secrets on session start ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		secrets = loadSecrets(ctx.cwd);
		if (ctx.hasUI && secrets.length > 0) {
			const globalCount = secrets.filter((s) => s.source === "global").length;
			const projectCount = secrets.filter((s) => s.source === "project").length;
			const parts = [];
			if (globalCount > 0) parts.push(`${globalCount} global`);
			if (projectCount > 0) parts.push(`${projectCount} project`);
			ctx.ui.notify(
				`Secret guard: protecting ${secrets.length} secret(s) (${parts.join(", ")})`,
				"info",
			);
		}
	});

	// ── Block tool calls that access either secrets directory ─────────────────

	pi.on("tool_call", async (event, ctx) => {
		const cwd = ctx.cwd;

		// bash: scan the command string for known secrets-directory patterns
		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command ?? "";
			const hit = bashPatterns(cwd).find((p) => cmd.includes(p));
			if (hit) {
				ctx.ui.notify(
					"Secret guard: blocked bash command accessing a .pi/.secrets/ directory",
					"warning",
				);
				return { block: true, reason: "Direct access to .pi/.secrets/ is not allowed." };
			}
			return undefined;
		}

		// read / write / edit: check the path argument
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event)
		) {
			if (isInsideAnySecretsDir(event.input.path, cwd)) {
				ctx.ui.notify(
					`Secret guard: blocked ${event.toolName} on ${event.input.path}`,
					"warning",
				);
				return { block: true, reason: "Direct access to .pi/.secrets/ is not allowed." };
			}
			return undefined;
		}

		// ls / grep / find: cast to any since their input types vary
		if (event.toolName === "ls" || event.toolName === "grep" || event.toolName === "find") {
			const input = event.input as Record<string, unknown>;
			const candidatePaths = [input["path"], input["directory"]].filter(
				(v): v is string => typeof v === "string",
			);
			if (candidatePaths.some((p) => isInsideAnySecretsDir(p, cwd))) {
				ctx.ui.notify(
					`Secret guard: blocked ${event.toolName} on a .pi/.secrets/ directory`,
					"warning",
				);
				return { block: true, reason: "Direct access to .pi/.secrets/ is not allowed." };
			}
		}

		return undefined;
	});

	// ── Redact secret values from all tool results ────────────────────────────

	pi.on("tool_result", async (event, _ctx) => {
		if (secrets.length === 0) return undefined;

		const redactedContent = event.content.map((item) => {
			if (item.type !== "text") return item;
			const redacted = redactSecrets(item.text, secrets);
			return redacted === item.text ? item : { ...item, text: redacted };
		});

		const changed = redactedContent.some((item, i) => item !== event.content[i]);
		if (!changed) return undefined;

		return { content: redactedContent };
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("secrets-reload", {
		description: "Reload secrets from global (~/.pi/.secrets/) and project (.pi/.secrets/)",
		handler: async (_args, ctx) => {
			secrets = loadSecrets(ctx.cwd);
			ctx.ui.notify(
				`Secret guard: loaded ${secrets.length} secret(s) from global and project locations`,
				"success",
			);
		},
	});

	pi.registerCommand("secrets-status", {
		description: "Show loaded secret names per location (no values shown)",
		handler: async (_args, ctx) => {
			if (secrets.length === 0) {
				ctx.ui.notify(
					`Secret guard: no secrets loaded.\n` +
					`  Global:  ~/.pi/.secrets/<name>\n` +
					`  Project: .pi/.secrets/<name>`,
					"info",
				);
				return;
			}

			const globalSecrets = secrets.filter((s) => s.source === "global");
			const projectSecrets = secrets.filter((s) => s.source === "project");
			const lines: string[] = [`Secret guard: ${secrets.length} secret(s) loaded`];

			if (globalSecrets.length > 0) {
				lines.push(`  Global  (${globalSecrets.length}): ${globalSecrets.map((s) => s.name).join(", ")}`);
			} else {
				lines.push(`  Global  (0): none`);
			}

			if (projectSecrets.length > 0) {
				lines.push(`  Project (${projectSecrets.length}): ${projectSecrets.map((s) => s.name).join(", ")}`);
			} else {
				lines.push(`  Project (0): none`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
