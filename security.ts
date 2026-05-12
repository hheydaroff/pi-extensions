/**
 * Security Extension
 *
 * Enforces configurable security rules loaded from JSON config files.
 * Rules live in ~/.pi/agent/security.json (global) and .pi/security.json (project).
 * Both files are merged — global is baseline, project appends on top.
 *
 * Features:
 *   - Pattern compilation: regexes compiled once at load, not per-call
 *   - Allowed patterns (exceptions): rules can have allowedPatterns for surgical exceptions
 *   - Session-scoped grants: "allow for session" on ask-category rules
 *   - Fast-path bypass: bash.allowed list skips all rule checks for known-safe commands
 *   - onlyIfExists: path rules can optionally only fire if the file exists on disk
 *   - Protection hierarchy: strongest rule wins when multiple match
 *   - Position-aware matching: bash rules use word-boundary heuristics to reduce false positives
 *   - CWD boundary mode: optional workspace boundary enforcement
 *   - Event emission: emits security:blocked events for extension interop
 *
 * Each rule can have an optional `guidance` field that tells the LLM what to
 * do instead when blocked or when the user denies a confirmation prompt.
 *
 * Config schema:
 *   {
 *     "bash": {
 *       "allowed": ["^git (status|log|diff)"],   // fast-path bypass (optional)
 *       "prohibit": [{ pattern, description, guidance?, allowedPatterns? }],
 *       "ask": [{ pattern, description, guidance?, allowedPatterns? }]
 *     },
 *     "paths": {
 *       "zeroAccess": [{ pattern, description, guidance?, allowedPatterns?, onlyIfExists? }],
 *       "readOnly":   [{ ... }],
 *       "noDelete":   [{ ... }],
 *       "askOnWrite": [{ ... }]
 *     },
 *     "boundary": {             // optional CWD boundary enforcement
 *       "enabled": false,
 *       "mode": "ask",          // "ask" | "block"
 *       "allowedPaths": []      // paths always allowed outside cwd (trailing / = dir)
 *     }
 *   }
 *
 * Use natural language to manage rules:
 *   "prohibit running sudo commands"
 *   "ask me before git push"
 *   "add zero-access protection for .env files"
 *
 * Slash commands:
 *   /security         — list all active rules
 *   /security reload  — reload config files without restarting
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

interface Rule {
	pattern: string;
	description: string;
	guidance?: string;
	allowedPatterns?: string[];  // exceptions — if input matches any, skip the rule
	onlyIfExists?: boolean;     // for path rules — only enforce if file exists on disk
}

/** Compiled rule with pre-built regex for fast matching */
interface CompiledRule {
	pattern: string;
	description: string;
	guidance?: string;
	regex: RegExp | null;          // null if invalid regex (falls back to includes)
	allowedRegexes: RegExp[];      // compiled allowedPatterns
	onlyIfExists: boolean;
}

interface BoundaryConfig {
	enabled: boolean;
	mode: "ask" | "block";
	allowedPaths: string[];  // trailing / = directory grant, otherwise exact file
}

interface SecurityConfig {
	bash: {
		allowed?: string[];   // fast-path bypass patterns
		prohibit: Rule[];
		ask: Rule[];
	};
	paths: {
		zeroAccess: Rule[];
		readOnly: Rule[];
		noDelete: Rule[];
		askOnWrite: Rule[];
	};
	boundary?: BoundaryConfig;
}

interface CompiledConfig {
	bash: {
		allowed: RegExp[];
		prohibit: CompiledRule[];
		ask: CompiledRule[];
	};
	paths: {
		zeroAccess: CompiledRule[];
		readOnly: CompiledRule[];
		noDelete: CompiledRule[];
		askOnWrite: CompiledRule[];
	};
	boundary: {
		enabled: boolean;
		mode: "ask" | "block";
		allowedPaths: string[];  // resolved absolute paths
	};
}

interface AuditEntry {
	tool: string;
	input: string;
	rule: string;
	category: string;
	action: "blocked" | "blocked_by_user" | "approved_by_user";
}

// Protection strength ranking for hierarchy
const PROTECTION_RANK: Record<string, number> = {
	zeroAccess: 4,
	readOnly: 3,
	noDelete: 2,
	askOnWrite: 1,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_CONFIG = (): SecurityConfig => ({
	bash: { prohibit: [], ask: [] },
	paths: { zeroAccess: [], readOnly: [], noDelete: [], askOnWrite: [] },
});

const BLOCK_SUFFIX =
	"\n\nDO NOT attempt to work around this restriction. " +
	"DO NOT retry with alternative commands, paths, or approaches that achieve the same result. " +
	"Report this block to the user and ask how they'd like to proceed.";

function blockReason(description: string, guidance?: string): string {
	const guidanceSection = guidance ? `\n\n${guidance}` : "";
	return `🛑 BLOCKED by security: ${description}${guidanceSection}${BLOCK_SUFFIX}`;
}

function confirmBody(command: string, guidance?: string): string {
	const guidanceSection = guidance
		? `\n\nIf denied, the agent will be told:\n${guidance}`
		: "";
	return `Allow this command?\n\n${command}${guidanceSection}`;
}

function confirmPathBody(filePath: string, guidance?: string): string {
	const guidanceSection = guidance
		? `\n\nIf denied, the agent will be told:\n${guidance}`
		: "";
	return `Allow write to:\n${filePath}${guidanceSection}`;
}

/** Compile a single regex pattern safely */
function compileRegex(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

/** Compile a rule into a CompiledRule with pre-built regexes */
function compileRule(rule: Rule): CompiledRule {
	return {
		pattern: rule.pattern,
		description: rule.description,
		guidance: rule.guidance,
		regex: compileRegex(rule.pattern),
		allowedRegexes: (rule.allowedPatterns ?? [])
			.map(compileRegex)
			.filter((r): r is RegExp => r !== null),
		onlyIfExists: rule.onlyIfExists ?? false,
	};
}

/** Test if input matches a compiled rule's pattern */
function matchesCompiled(input: string, rule: CompiledRule): boolean {
	if (rule.regex) {
		return rule.regex.test(input);
	}
	// Fallback for invalid regex — substring match
	return input.includes(rule.pattern);
}

/** Check if input is excluded by allowedPatterns */
function isExcepted(input: string, rule: CompiledRule): boolean {
	return rule.allowedRegexes.some(re => re.test(input));
}

/** Full match check: matches pattern AND not excepted */
function ruleApplies(input: string, rule: CompiledRule): boolean {
	return matchesCompiled(input, rule) && !isExcepted(input, rule);
}

/** Check if a file path matches a path rule (with resolution) */
function matchesPathRule(targetPath: string, rule: CompiledRule, cwd: string): boolean {
	const pattern = rule.pattern;
	const expanded = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : pattern;
	const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
	const relative = path.relative(cwd, resolved);

	let matches = false;
	if (rule.regex) {
		matches = rule.regex.test(resolved) || rule.regex.test(relative) || rule.regex.test(targetPath);
	} else {
		// Fallback: glob-like (* wildcard) and substring matching
		try {
			const escaped = expanded.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
			const fallbackRegex = new RegExp(escaped);
			matches = fallbackRegex.test(resolved) || fallbackRegex.test(relative) || fallbackRegex.test(targetPath);
		} catch {
			matches = resolved.includes(expanded) || relative.includes(expanded) || targetPath.includes(expanded);
		}
	}

	if (!matches) return false;

	// Check allowed exceptions
	if (rule.allowedRegexes.length > 0) {
		const isAllowed = rule.allowedRegexes.some(re =>
			re.test(resolved) || re.test(relative) || re.test(targetPath)
		);
		if (isAllowed) return false;
	}

	return true;
}

/** Check onlyIfExists — returns true if the rule should be enforced */
function shouldEnforce(rule: CompiledRule, targetPath: string, cwd: string): boolean {
	if (!rule.onlyIfExists) return true;
	const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
	return fs.existsSync(resolved);
}

function isWriteOperation(command: string): boolean {
	return (
		/>/.test(command) ||
		/\btee\b/.test(command) ||
		/\bsed\s+-i\b/.test(command) ||
		/\bcp\b/.test(command) ||
		/\bmv\b/.test(command) ||
		/\btouch\b/.test(command) ||
		/\bchmod\b/.test(command) ||
		/\bchown\b/.test(command)
	);
}

function isDeleteOperation(command: string): boolean {
	return /\brm\b/.test(command) || /\bmv\b/.test(command);
}

function totalRulesRaw(config: SecurityConfig): number {
	return (
		config.bash.prohibit.length +
		config.bash.ask.length +
		config.paths.zeroAccess.length +
		config.paths.readOnly.length +
		config.paths.noDelete.length +
		config.paths.askOnWrite.length
	);
}

function totalRulesCompiled(config: CompiledConfig): number {
	return (
		config.bash.prohibit.length +
		config.bash.ask.length +
		config.paths.zeroAccess.length +
		config.paths.readOnly.length +
		config.paths.noDelete.length +
		config.paths.askOnWrite.length
	);
}

/** Check if a path is within the workspace boundary */
function isWithinBoundary(absPath: string, cwd: string): boolean {
	const normalizedPath = path.resolve(absPath);
	const normalizedCwd = path.resolve(cwd);
	return normalizedPath === normalizedCwd || normalizedPath.startsWith(normalizedCwd + path.sep);
}

/** Check if a path is covered by the boundary allowedPaths */
function isPathAllowedByBoundary(absPath: string, allowedPaths: string[]): boolean {
	for (const entry of allowedPaths) {
		if (entry.endsWith("/") || entry.endsWith(path.sep)) {
			// Directory grant: check prefix
			const dirPath = entry.slice(0, -1);
			if (isWithinBoundary(absPath, dirPath)) return true;
		} else {
			// Exact file grant
			if (path.resolve(absPath) === path.resolve(entry)) return true;
		}
	}
	return false;
}

/** Resolve boundary allowedPaths to absolute */
function resolveBoundaryPaths(paths: string[]): string[] {
	return paths.map(p => {
		const isDir = p.endsWith("/");
		const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
		const base = isDir ? expanded.slice(0, -1) : expanded;
		const resolved = path.resolve(base);
		return isDir ? resolved + "/" : resolved;
	});
}

// ── Config I/O ───────────────────────────────────────────────────────────────

function readConfigFile(filePath: string): SecurityConfig {
	if (!fs.existsSync(filePath)) return EMPTY_CONFIG();
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as any;
		return {
			bash: {
				allowed:  parsed.bash?.allowed  ?? [],
				prohibit: parsed.bash?.prohibit ?? [],
				ask:      parsed.bash?.ask      ?? [],
			},
			paths: {
				zeroAccess: parsed.paths?.zeroAccess ?? [],
				readOnly:   parsed.paths?.readOnly   ?? [],
				noDelete:   parsed.paths?.noDelete   ?? [],
				askOnWrite: parsed.paths?.askOnWrite ?? [],
			},
			boundary: parsed.boundary ?? undefined,
		};
	} catch {
		return EMPTY_CONFIG();
	}
}

function writeConfigFile(filePath: string, config: SecurityConfig): void {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Compile a raw SecurityConfig into a CompiledConfig with pre-built regexes */
function compileConfig(raw: SecurityConfig): CompiledConfig {
	return {
		bash: {
			allowed: (raw.bash.allowed ?? [])
				.map(compileRegex)
				.filter((r): r is RegExp => r !== null),
			prohibit: raw.bash.prohibit.map(compileRule),
			ask: raw.bash.ask.map(compileRule),
		},
		paths: {
			zeroAccess: raw.paths.zeroAccess.map(compileRule),
			readOnly: raw.paths.readOnly.map(compileRule),
			noDelete: raw.paths.noDelete.map(compileRule),
			askOnWrite: raw.paths.askOnWrite.map(compileRule),
		},
		boundary: {
			enabled: raw.boundary?.enabled ?? false,
			mode: raw.boundary?.mode ?? "ask",
			allowedPaths: resolveBoundaryPaths(raw.boundary?.allowedPaths ?? []),
		},
	};
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "security.json");
	let projectConfigPath = "";
	let rawMerged: SecurityConfig = EMPTY_CONFIG();
	let compiled: CompiledConfig = compileConfig(rawMerged);

	// Session-scoped grants — patterns approved "for this session" (cleared on reload)
	const sessionGrants = new Set<string>();
	// Session-scoped boundary grants — paths approved for this session
	const sessionBoundaryGrants = new Set<string>();

	function loadAndMerge(cwd: string): SecurityConfig {
		projectConfigPath = path.join(cwd, ".pi", "security.json");
		const g = readConfigFile(globalConfigPath);
		const p = readConfigFile(projectConfigPath);

		// Merge boundary: project overrides global
		const boundary: BoundaryConfig = {
			enabled: p.boundary?.enabled ?? g.boundary?.enabled ?? false,
			mode: p.boundary?.mode ?? g.boundary?.mode ?? "ask",
			allowedPaths: [
				...(g.boundary?.allowedPaths ?? []),
				...(p.boundary?.allowedPaths ?? []),
			],
		};

		return {
			bash: {
				allowed:  [...(g.bash.allowed ?? []), ...(p.bash.allowed ?? [])],
				prohibit: [...g.bash.prohibit, ...p.bash.prohibit],
				ask:      [...g.bash.ask,      ...p.bash.ask],
			},
			paths: {
				zeroAccess: [...g.paths.zeroAccess, ...p.paths.zeroAccess],
				readOnly:   [...g.paths.readOnly,   ...p.paths.readOnly],
				noDelete:   [...g.paths.noDelete,   ...p.paths.noDelete],
				askOnWrite: [...g.paths.askOnWrite, ...p.paths.askOnWrite],
			},
			boundary,
		};
	}

	function reload(cwd: string) {
		rawMerged = loadAndMerge(cwd);
		compiled = compileConfig(rawMerged);
		sessionGrants.clear();
		sessionBoundaryGrants.clear();
	}

	function log(entry: AuditEntry) {
		pi.appendEntry("security-log", entry);
	}

	function emitBlocked(tool: string, input: string, rule: string, category: string) {
		try {
			(pi as any).events?.emit?.("security:blocked", { tool, input, rule, category });
		} catch { /* events API may not exist */ }
	}

	// ── Find strongest matching path rule (protection hierarchy) ──────────────

	function findStrongestPathMatch(
		filePath: string,
		cwd: string,
		categories: { key: string; rules: CompiledRule[] }[],
	): { rule: CompiledRule; category: string } | null {
		let best: { rule: CompiledRule; category: string; rank: number } | null = null;

		for (const { key, rules } of categories) {
			const rank = PROTECTION_RANK[key] ?? 0;
			for (const rule of rules) {
				if (matchesPathRule(filePath, rule, cwd) && shouldEnforce(rule, filePath, cwd)) {
					if (!best || rank > best.rank) {
						best = { rule, category: key, rank };
					}
				}
			}
		}

		return best ? { rule: best.rule, category: best.category } : null;
	}

	// ── CWD Boundary Check ────────────────────────────────────────────────────

	async function checkBoundary(
		toolName: string,
		filePath: string,
		cwd: string,
		ctx: any,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!compiled.boundary.enabled) return undefined;

		const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);

		// Within workspace — always allowed
		if (isWithinBoundary(resolved, cwd)) return undefined;

		// Check configured allowed paths
		if (isPathAllowedByBoundary(resolved, compiled.boundary.allowedPaths)) return undefined;

		// Check session grants
		if (sessionBoundaryGrants.has(resolved)) return undefined;
		// Check directory grants
		for (const grant of sessionBoundaryGrants) {
			if (grant.endsWith("/") && resolved.startsWith(grant)) return undefined;
		}

		const displayPath = filePath.startsWith("~") ? filePath : path.relative(cwd, resolved) || resolved;

		if (compiled.boundary.mode === "block") {
			const reason = `Access to ${displayPath} is blocked (outside working directory).`;
			log({ tool: toolName, input: filePath, rule: "cwd-boundary", category: "boundary", action: "blocked" });
			emitBlocked(toolName, filePath, "cwd-boundary", "boundary");
			return { block: true, reason: blockReason(reason) };
		}

		// mode === "ask"
		if (!ctx.hasUI) {
			const reason = `Access to ${displayPath} is blocked (outside working directory, no UI to confirm).`;
			log({ tool: toolName, input: filePath, rule: "cwd-boundary", category: "boundary", action: "blocked" });
			return { block: true, reason: blockReason(reason) };
		}

		const ok = await ctx.ui.confirm(
			"⚠️ Outside workspace access",
			`\`${toolName}\` targets a path outside the working directory:\n\n  Path: ${displayPath}\n  CWD:  ${cwd}\n\nAllow access?`,
			{ timeout: 30000 },
		);

		if (!ok) {
			log({ tool: toolName, input: filePath, rule: "cwd-boundary", category: "boundary", action: "blocked_by_user" });
			return { block: true, reason: "User denied access outside working directory." };
		}

		// Grant for session — grant the directory
		const parentDir = path.dirname(resolved) + "/";
		sessionBoundaryGrants.add(parentDir);
		log({ tool: toolName, input: filePath, rule: "cwd-boundary", category: "boundary", action: "approved_by_user" });
		return undefined;
	}

	// ── Session Start ─────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx.cwd);
		const count = totalRulesCompiled(compiled);
		const boundaryStatus = compiled.boundary.enabled ? " + boundary" : "";
		if (count === 0 && !compiled.boundary.enabled) {
			ctx.ui.notify(
				"🛡️ Security: No rules loaded.\n" +
				"Add rules to ~/.pi/agent/security.json or .pi/security.json",
				"info",
			);
		} else {
			ctx.ui.notify(`🛡️ Security: ${count} rules active${boundaryStatus}`, "info");
		}
		ctx.ui.setStatus("security", `🛡️ ${count} rules${boundaryStatus}`);
	});

	// ── Tool Call Interceptor ─────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {

		// ── SECURITY_MANAGE — intercept rule removals with mandatory terminal confirmation ──
		if (event.toolName === "security_manage") {
			const input = event.input as any;
			if (input?.action === "remove") {
				const ruleName = input.description || input.pattern || "unknown rule";
				const confirmMsg = `Rule: ${ruleName}\nPattern: ${input.pattern || "?"}\nScope: ${input.target || "?"} ${input.scope || "?"}.${input.category || "?"}\n\nThis weakens your security. Are you sure?`;

				if (!ctx.hasUI) {
					return { block: true, reason: `🛑 Cannot remove security rule "${ruleName}" — no UI available. Rules can only be removed with terminal approval.` };
				}
				const ok = await ctx.ui.confirm("🛡️ Remove security rule?", confirmMsg, { timeout: 60000 });
				if (!ok) {
					log({ tool: "security_manage", input: `remove: ${ruleName}`, rule: ruleName, category: `${input.scope}.${input.category}`, action: "blocked_by_user" });
					return { block: true, reason: `🚫 User denied removal of security rule "${ruleName}". The rule remains active. Do NOT retry or attempt to work around this.` };
				}
				log({ tool: "security_manage", input: `remove: ${ruleName}`, rule: ruleName, category: `${input.scope}.${input.category}`, action: "approved_by_user" });
				return undefined;
			}
			return undefined;
		}

		// ── BASH ─────────────────────────────────────────────────────────────────
		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command as string;

			// Fast-path bypass: if command matches any allowed pattern, skip all checks
			if (compiled.bash.allowed.some(re => re.test(cmd))) {
				return undefined;
			}

			// Check session grants first
			if (sessionGrants.has(cmd)) {
				return undefined;
			}

			// CWD boundary check for bash — extract path-like tokens
			if (compiled.boundary.enabled) {
				// Simple heuristic: extract tokens that look like paths
				const tokens = cmd.match(/"([^"]+)"|'([^']+)'|([^\s"'`<>|;&]+)/g) ?? [];
				for (const raw of tokens) {
					const token = raw.replace(/^["']|["']$/g, "");
					if (!token || token.startsWith("-") || !looksLikePath(token)) continue;
					const result = await checkBoundary("bash", token, ctx.cwd, ctx);
					if (result) return result;
				}
			}

			// paths.zeroAccess — no bash touching this path at all
			for (const rule of compiled.paths.zeroAccess) {
				if (ruleApplies(cmd, rule)) {
					ctx.ui.notify(`🛑 Security: Blocked access to zero-access path (${rule.description})`, "error");
					ctx.ui.setStatus("security", `⚠️ ${rule.description}`);
					log({ tool: "bash", input: cmd, rule: rule.description, category: "paths.zeroAccess", action: "blocked" });
					emitBlocked("bash", cmd, rule.description, "paths.zeroAccess");
					ctx.abort();
					return { block: true, reason: blockReason(rule.description, rule.guidance) };
				}
			}

			// paths.readOnly — block bash commands that write to this path
			for (const rule of compiled.paths.readOnly) {
				if (ruleApplies(cmd, rule) && isWriteOperation(cmd)) {
					ctx.ui.notify(`🛑 Security: Blocked write to read-only path (${rule.description})`, "error");
					ctx.ui.setStatus("security", `⚠️ ${rule.description}`);
					log({ tool: "bash", input: cmd, rule: rule.description, category: "paths.readOnly", action: "blocked" });
					emitBlocked("bash", cmd, rule.description, "paths.readOnly");
					ctx.abort();
					return { block: true, reason: blockReason(rule.description, rule.guidance) };
				}
			}

			// paths.noDelete — block bash commands that delete/move this path
			for (const rule of compiled.paths.noDelete) {
				if (ruleApplies(cmd, rule) && isDeleteOperation(cmd)) {
					ctx.ui.notify(`🛑 Security: Blocked deletion of protected path (${rule.description})`, "error");
					ctx.ui.setStatus("security", `⚠️ ${rule.description}`);
					log({ tool: "bash", input: cmd, rule: rule.description, category: "paths.noDelete", action: "blocked" });
					emitBlocked("bash", cmd, rule.description, "paths.noDelete");
					ctx.abort();
					return { block: true, reason: blockReason(rule.description, rule.guidance) };
				}
			}

			// bash.prohibit — hard block, no prompt
			for (const rule of compiled.bash.prohibit) {
				if (ruleApplies(cmd, rule)) {
					ctx.ui.notify(`🛑 Security: Prohibited — ${rule.description}`, "error");
					ctx.ui.setStatus("security", `⚠️ ${rule.description}`);
					log({ tool: "bash", input: cmd, rule: rule.description, category: "bash.prohibit", action: "blocked" });
					emitBlocked("bash", cmd, rule.description, "bash.prohibit");
					ctx.abort();
					return { block: true, reason: blockReason(rule.description, rule.guidance) };
				}
			}

			// bash.ask — confirm before running
			for (const rule of compiled.bash.ask) {
				if (ruleApplies(cmd, rule)) {
					// Check session grants for this rule's pattern
					if (sessionGrants.has(rule.pattern)) {
						return undefined;
					}

					if (!ctx.hasUI) {
						log({ tool: "bash", input: cmd, rule: rule.description, category: "bash.ask", action: "blocked" });
						emitBlocked("bash", cmd, rule.description, "bash.ask");
						ctx.abort();
						return { block: true, reason: blockReason(`${rule.description} (no UI to confirm)`, rule.guidance) };
					}
					const ok = await ctx.ui.confirm(
						`⚠️ Security: ${rule.description}`,
						confirmBody(cmd, rule.guidance),
						{ timeout: 30000 },
					);
					if (!ok) {
						ctx.ui.setStatus("security", `⚠️ Denied: ${rule.description}`);
						log({ tool: "bash", input: cmd, rule: rule.description, category: "bash.ask", action: "blocked_by_user" });
						emitBlocked("bash", cmd, rule.description, "bash.ask");
						return { block: true, reason: blockReason(rule.description, rule.guidance) };
					}
					// Grant for session — approve this rule pattern for the rest of the session
					sessionGrants.add(rule.pattern);
					log({ tool: "bash", input: cmd, rule: rule.description, category: "bash.ask", action: "approved_by_user" });
					return undefined;
				}
			}

			return undefined;
		}

		// ── WRITE / EDIT ──────────────────────────────────────────────────────────
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const filePath = event.input.path as string;

			// CWD boundary check
			const boundaryResult = await checkBoundary(event.toolName, filePath, ctx.cwd, ctx);
			if (boundaryResult) return boundaryResult;

			// Protection hierarchy: find strongest matching rule
			const strongest = findStrongestPathMatch(filePath, ctx.cwd, [
				{ key: "zeroAccess", rules: compiled.paths.zeroAccess },
				{ key: "readOnly", rules: compiled.paths.readOnly },
				{ key: "askOnWrite", rules: compiled.paths.askOnWrite },
			]);

			if (strongest) {
				const { rule, category } = strongest;

				if (category === "zeroAccess" || category === "readOnly") {
					const label = category === "zeroAccess" ? "zero-access" : "read-only";
					ctx.ui.notify(`🛑 Security: Blocked write to ${label} path (${rule.description})`, "error");
					ctx.ui.setStatus("security", `⚠️ ${rule.description}`);
					log({ tool: event.toolName, input: filePath, rule: rule.description, category: `paths.${category}`, action: "blocked" });
					emitBlocked(event.toolName, filePath, rule.description, `paths.${category}`);
					ctx.abort();
					return { block: true, reason: blockReason(rule.description, rule.guidance) };
				}

				if (category === "askOnWrite") {
					// Check session grants
					if (sessionGrants.has(rule.pattern)) return undefined;

					if (!ctx.hasUI) {
						log({ tool: event.toolName, input: filePath, rule: rule.description, category: "paths.askOnWrite", action: "blocked" });
						emitBlocked(event.toolName, filePath, rule.description, "paths.askOnWrite");
						ctx.abort();
						return { block: true, reason: blockReason(`${rule.description} (no UI to confirm)`, rule.guidance) };
					}
					const ok = await ctx.ui.confirm(
						`⚠️ Security: Modifying ${rule.description}`,
						confirmPathBody(filePath, rule.guidance),
						{ timeout: 30000 },
					);
					if (!ok) {
						ctx.ui.setStatus("security", `⚠️ Denied: ${rule.description}`);
						log({ tool: event.toolName, input: filePath, rule: rule.description, category: "paths.askOnWrite", action: "blocked_by_user" });
						emitBlocked(event.toolName, filePath, rule.description, "paths.askOnWrite");
						return { block: true, reason: blockReason(rule.description, rule.guidance) };
					}
					sessionGrants.add(rule.pattern);
					log({ tool: event.toolName, input: filePath, rule: rule.description, category: "paths.askOnWrite", action: "approved_by_user" });
					return undefined;
				}
			}

			return undefined;
		}

		// ── READ / GREP / FIND / LS ───────────────────────────────────────────────
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("ls", event)
		) {
			const filePath = (event.input.path || event.input.glob || ".") as string;

			// CWD boundary check
			const boundaryResult = await checkBoundary(event.toolName, filePath, ctx.cwd, ctx);
			if (boundaryResult) return boundaryResult;

			for (const rule of compiled.paths.zeroAccess) {
				if (matchesPathRule(filePath, rule, ctx.cwd) && shouldEnforce(rule, filePath, ctx.cwd)) {
					ctx.ui.notify(`🛑 Security: Blocked read of zero-access path (${rule.description})`, "error");
					ctx.ui.setStatus("security", `⚠️ ${rule.description}`);
					log({ tool: event.toolName, input: filePath, rule: rule.description, category: "paths.zeroAccess", action: "blocked" });
					emitBlocked(event.toolName, filePath, rule.description, "paths.zeroAccess");
					ctx.abort();
					return { block: true, reason: blockReason(rule.description, rule.guidance) };
				}
			}

			return undefined;
		}

		return undefined;
	});

	// ── security_manage Tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: "security_manage",
		label: "Security Manage",
		description:
			"Manage security rules. Call this when the user asks to add, remove, edit, list, or test security rules in natural language. " +
			"You generate the correct regex pattern from their description. " +
			"Always use action=test to verify a pattern matches the intended input before saving with action=add. " +
			"For scope=bash use category=prohibit or ask. For scope=paths use category=zeroAccess, readOnly, noDelete, or askOnWrite. " +
			"Include a guidance field when adding rules — it tells the LLM what to do instead when blocked or when the user denies.",
		parameters: Type.Object({
			action:      StringEnum(["add", "remove", "list", "test"] as const),
			scope:       Type.Optional(StringEnum(["bash", "paths"] as const)),
			category:    Type.Optional(StringEnum(["prohibit", "ask", "zeroAccess", "readOnly", "noDelete", "askOnWrite"] as const)),
			target:      Type.Optional(StringEnum(["project", "global"] as const)),
			pattern:     Type.Optional(Type.String({ description: "Regex pattern string" })),
			description: Type.Optional(Type.String({ description: "Human-readable label shown on block/prompt" })),
			guidance:    Type.Optional(Type.String({ description: "What the LLM should do instead when this rule blocks or is denied" })),
			testInput:   Type.Optional(Type.String({ description: "For action=test: the command or path to test against" })),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {

			// LIST ──────────────────────────────────────────────────────────────
			if (params.action === "list") {
				const g = readConfigFile(globalConfigPath);
				const p = readConfigFile(projectConfigPath || path.join(ctx.cwd, ".pi", "security.json"));
				const lines: string[] = ["=== Security Rules ==="];

				const section = (title: string, globalRules: Rule[], projRules: Rule[]) => {
					if (globalRules.length === 0 && projRules.length === 0) return;
					lines.push(`\n${title}`);
					globalRules.forEach((r) => {
						lines.push(`  [global]  ${r.description}  →  ${r.pattern}`);
						if (r.guidance) lines.push(`            guidance: ${r.guidance}`);
						if (r.allowedPatterns?.length) lines.push(`            exceptions: ${r.allowedPatterns.join(", ")}`);
					});
					projRules.forEach((r) => {
						lines.push(`  [project] ${r.description}  →  ${r.pattern}`);
						if (r.guidance) lines.push(`            guidance: ${r.guidance}`);
						if (r.allowedPatterns?.length) lines.push(`            exceptions: ${r.allowedPatterns.join(", ")}`);
					});
				};

				lines.push("\n── Bash Commands ──");
				if (g.bash.allowed?.length || p.bash.allowed?.length) {
					lines.push(`\nAllowed (bypass):`);
					(g.bash.allowed ?? []).forEach(a => lines.push(`  [global]  ${a}`));
					(p.bash.allowed ?? []).forEach(a => lines.push(`  [project] ${a}`));
				}
				section("Prohibit (hard block):", g.bash.prohibit, p.bash.prohibit);
				section("Ask (confirm prompt):",  g.bash.ask,      p.bash.ask);
				lines.push("\n── File Paths ──");
				section("Zero Access (no read or write):", g.paths.zeroAccess, p.paths.zeroAccess);
				section("Read Only (no modifications):",   g.paths.readOnly,   p.paths.readOnly);
				section("No Delete (no rm/mv):",           g.paths.noDelete,   p.paths.noDelete);
				section("Ask on Write (confirm prompt):",  g.paths.askOnWrite, p.paths.askOnWrite);

				// Boundary info
				const boundary = rawMerged.boundary;
				if (boundary?.enabled) {
					lines.push(`\n── CWD Boundary ──`);
					lines.push(`  Mode: ${boundary.mode}`);
					if (boundary.allowedPaths.length > 0) {
						lines.push(`  Allowed paths: ${boundary.allowedPaths.join(", ")}`);
					}
				}

				// Session grants
				if (sessionGrants.size > 0) {
					lines.push(`\n── Session Grants (${sessionGrants.size}) ──`);
					for (const grant of sessionGrants) {
						lines.push(`  ${grant}`);
					}
				}

				const count = totalRulesRaw(g) + totalRulesRaw(p);
				if (count === 0) lines.push("\nNo rules configured.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { global: g, project: p, totalRules: count, sessionGrants: sessionGrants.size },
				};
			}

			// TEST ──────────────────────────────────────────────────────────────
			if (params.action === "test") {
				if (!params.pattern || !params.testInput) {
					throw new Error("pattern and testInput are required for action=test");
				}
				let matches = false;
				let errorMsg = "";
				try {
					matches = new RegExp(params.pattern).test(params.testInput);
				} catch (e) {
					errorMsg = e instanceof Error ? e.message : String(e);
				}
				const text = errorMsg
					? `❌ Invalid regex: ${errorMsg}`
					: matches
						? `✅ Pattern MATCHES: "${params.testInput}"`
						: `❌ Pattern does NOT match: "${params.testInput}"`;
				return {
					content: [{ type: "text", text }],
					details: { matches, pattern: params.pattern, testInput: params.testInput, error: errorMsg || null },
				};
			}

			// ADD / REMOVE — validate required params ───────────────────────────
			if (!params.scope || !params.category || !params.target) {
				throw new Error("scope, category, and target are required for action=add/remove");
			}
			if (!params.pattern || !params.description) {
				throw new Error("pattern and description are required for action=add/remove");
			}

			const configPath = params.target === "project"
				? (projectConfigPath || path.join(ctx.cwd, ".pi", "security.json"))
				: globalConfigPath;

			const cfg = readConfigFile(configPath);

			// Resolve the correct rule list
			let ruleList: Rule[];
			if (params.scope === "bash") {
				if (params.category !== "prohibit" && params.category !== "ask") {
					throw new Error(`For scope=bash, category must be "prohibit" or "ask", got "${params.category}"`);
				}
				ruleList = cfg.bash[params.category];
			} else {
				if (
					params.category !== "zeroAccess" &&
					params.category !== "readOnly" &&
					params.category !== "noDelete" &&
					params.category !== "askOnWrite"
				) {
					throw new Error(
						`For scope=paths, category must be "zeroAccess", "readOnly", "noDelete", or "askOnWrite", got "${params.category}"`,
					);
				}
				ruleList = cfg.paths[params.category];
			}

			// ADD ───────────────────────────────────────────────────────────────
			if (params.action === "add") {
				const exists = ruleList.some((r) => r.pattern === params.pattern);
				if (exists) {
					return {
						content: [{ type: "text", text: `⚠️ Rule already exists: ${params.description}` }],
						details: { added: false },
					};
				}
				const newRule: Rule = { pattern: params.pattern, description: params.description };
				if (params.guidance) newRule.guidance = params.guidance;
				ruleList.push(newRule);
				writeConfigFile(configPath, cfg);
				reload(ctx.cwd);
				ctx.ui.setStatus("security", `🛡️ ${totalRulesCompiled(compiled)} rules`);
				return {
					content: [{
						type: "text",
						text: `✅ Added rule "${params.description}" to ${params.target} ${params.scope}.${params.category}`,
					}],
					details: { added: true, rule: newRule },
				};
			}

			// REMOVE ────────────────────────────────────────────────────────────
			if (params.action === "remove") {
				const idx = ruleList.findIndex(
					(r) => r.description === params.description || r.pattern === params.pattern,
				);
				if (idx === -1) {
					return {
						content: [{ type: "text", text: `⚠️ No rule found matching: ${params.description || params.pattern}` }],
						details: { removed: false },
					};
				}
				const [removed] = ruleList.splice(idx, 1);
				writeConfigFile(configPath, cfg);
				reload(ctx.cwd);
				ctx.ui.setStatus("security", `🛡️ ${totalRulesCompiled(compiled)} rules`);
				return {
					content: [{
						type: "text",
						text: `✅ Removed rule "${removed.description}" from ${params.target} ${params.scope}.${params.category}`,
					}],
					details: { removed: true, rule: removed },
				};
			}

			throw new Error(`Unknown action: ${params.action}`);
		},
	});

	// ── Slash Commands ────────────────────────────────────────────────────────

	pi.registerCommand("security", {
		description: "List active security rules or reload config. Usage: /security [reload]",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "reload") {
				reload(ctx.cwd);
				const count = totalRulesCompiled(compiled);
				const boundaryStatus = compiled.boundary.enabled ? " + boundary" : "";
				ctx.ui.setStatus("security", `🛡️ ${count} rules${boundaryStatus}`);
				ctx.ui.notify(`🛡️ Security: Reloaded — ${count} rules active${boundaryStatus}`, "info");
				return;
			}

			const g = readConfigFile(globalConfigPath);
			const p = readConfigFile(projectConfigPath || path.join(ctx.cwd, ".pi", "security.json"));
			const lines: string[] = ["🛡️  Security Rules", ""];

			const section = (title: string, globalRules: Rule[], projRules: Rule[]) => {
				if (globalRules.length === 0 && projRules.length === 0) return;
				lines.push(`  ${title}`);
				globalRules.forEach((r) => lines.push(`    [global]  ${r.description}`));
				projRules.forEach((r) => lines.push(`    [project] ${r.description}`));
				lines.push("");
			};

			lines.push("Bash Commands:");
			if (compiled.bash.allowed.length > 0) {
				lines.push(`  Bypass (${compiled.bash.allowed.length} patterns)`);
				lines.push("");
			}
			section("Prohibit:", g.bash.prohibit, p.bash.prohibit);
			section("Ask:",      g.bash.ask,      p.bash.ask);
			lines.push("File Paths:");
			section("Zero Access:",  g.paths.zeroAccess, p.paths.zeroAccess);
			section("Read Only:",    g.paths.readOnly,   p.paths.readOnly);
			section("No Delete:",    g.paths.noDelete,   p.paths.noDelete);
			section("Ask on Write:", g.paths.askOnWrite, p.paths.askOnWrite);

			if (compiled.boundary.enabled) {
				lines.push(`CWD Boundary: ${compiled.boundary.mode} mode`);
				lines.push("");
			}

			if (sessionGrants.size > 0) {
				lines.push(`Session Grants: ${sessionGrants.size} active`);
				lines.push("");
			}

			if (totalRulesRaw(g) + totalRulesRaw(p) === 0) lines.push("  No rules configured.");

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// ── Utility ──────────────────────────────────────────────────────────────────

/** Simple heuristic: does this token look like a file path? */
function looksLikePath(token: string): boolean {
	if (token.startsWith("/") || token.startsWith("~/") || token.startsWith("./") || token.startsWith("../")) return true;
	if (token.includes("/") && !token.startsWith("http")) return true;
	if (/\.\w{1,10}$/.test(token) && !token.includes("=")) return true;
	return false;
}
