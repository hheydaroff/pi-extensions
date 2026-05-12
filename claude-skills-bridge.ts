/**
 * Claude Skills Bridge
 *
 * Automatically discovers and loads skills from Claude Code's skill directories:
 *   - ~/.claude/skills/       global skills (all sessions)
 *   - .claude/skills/         project-local (walks from cwd up to git root)
 *
 * Pi-native skills always take priority. Any skill whose name already exists in
 * pi's default discovery paths (~/.pi/agent/skills/, ~/.agents/skills/,
 * .pi/skills/, .agents/skills/ ancestors) is silently skipped. This prevents
 * collision warnings on startup and /reload.
 *
 * Install: place this file in ~/.pi/agent/extensions/
 *
 * Notes:
 *   - /reload re-discovers skills, picks up newly added ones
 *   - SKILL.md files must follow the Agent Skills spec (name + description frontmatter)
 *   - --no-skills: extension skills still load (consistent with --skill <path> behavior)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Safety cap: max ancestor levels to walk when there is no git root. */
const MAX_ANCESTOR_DEPTH = 20;

/**
 * Walk up the directory tree looking for a .git entry.
 * Returns the git repo root, or null if not inside a git repo.
 */
function findGitRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null; // reached filesystem root
		dir = parent;
	}
	return null;
}

/**
 * Returns true only if the path exists AND is a directory.
 * Swallows permission errors and other fs exceptions.
 */
function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Collect skill names already known in a single pi skill directory.
 * A name is either a subdirectory name (skill package) or an .md basename (flat skill file).
 */
function collectNamesFromDir(dir: string): Set<string> {
	const names = new Set<string>();
	if (!isDirectory(dir)) return names;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				names.add(entry.name);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				names.add(entry.name.slice(0, -3));
			}
		}
	} catch {
		// Ignore permission errors
	}
	return names;
}

/**
 * Build the full set of skill names that pi's default discovery will load.
 * Covers: global ~/.pi/agent/skills/, ~/.agents/skills/,
 *         project .pi/skills/ (at git root), and .agents/skills/ ancestors.
 */
function getPiNativeSkillNames(cwd: string, gitRoot: string | null): Set<string> {
	const allNames = new Set<string>();

	const add = (dir: string) => {
		for (const name of collectNamesFromDir(dir)) allNames.add(name);
	};

	// Global
	add(join(homedir(), ".pi", "agent", "skills"));
	add(join(homedir(), ".agents", "skills"));

	// Project .pi/skills — Claude Code puts .claude at git root; mirror that assumption
	const projectRoot = gitRoot ?? resolve(cwd);
	add(join(projectRoot, ".pi", "skills"));

	// Project .agents/skills — pi walks ancestors up to git root
	let dir = resolve(cwd);
	for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
		add(join(dir, ".agents", "skills"));
		if (gitRoot !== null && dir === gitRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return allNames;
}

/**
 * Scan a .claude/skills/ directory and return individual skill paths
 * (subdirectories or flat .md files) whose names are NOT already in piNames.
 * Returns paths to individual skill entries, not the parent directory,
 * so that pi never sees a collision — it only loads what we explicitly pass.
 */
function filterNewClaudeSkills(claudeSkillsDir: string, piNames: Set<string>): string[] {
	const paths: string[] = [];
	try {
		for (const entry of readdirSync(claudeSkillsDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				// Only include if it contains a SKILL.md and name is not taken by pi
				if (
					!piNames.has(entry.name) &&
					existsSync(join(claudeSkillsDir, entry.name, "SKILL.md"))
				) {
					paths.push(join(claudeSkillsDir, entry.name));
				}
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const name = entry.name.slice(0, -3);
				if (!piNames.has(name)) {
					paths.push(join(claudeSkillsDir, entry.name));
				}
			}
		}
	} catch {
		// Ignore permission / read errors
	}
	return paths;
}

/** Replace the home directory prefix with ~ for compact display. */
function toDisplayPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", (event, ctx) => {
		const gitRoot = findGitRoot(event.cwd);
		const piNames = getPiNativeSkillNames(event.cwd, gitRoot);

		const skillPaths: string[] = [];
		const seenDirs = new Set<string>(); // deduplicate source directories

		// Dirs that actually contributed ≥1 new skill, with their counts
		type Contribution = { displayPath: string; added: number; skipped: number };
		const contributing: Contribution[] = [];

		/**
		 * Process one .claude/skills/ directory: filter new skills and accumulate paths.
		 * Only directories that contribute at least one new skill appear in the notification.
		 */
		function processClaudeSkillsDir(dir: string): void {
			const resolved = resolve(dir);
			if (seenDirs.has(resolved)) return; // already handled (e.g. cwd === gitRoot)
			seenDirs.add(resolved);

			if (!isDirectory(resolved)) return;

			const newPaths = filterNewClaudeSkills(resolved, piNames);
			skillPaths.push(...newPaths);

			// Count how many were silently skipped due to pi having the same name
			let skipped = 0;
			try {
				for (const entry of readdirSync(resolved, { withFileTypes: true })) {
					const name = entry.isDirectory()
						? entry.name
						: entry.isFile() && entry.name.endsWith(".md")
							? entry.name.slice(0, -3)
							: null;
					if (name !== null && piNames.has(name)) skipped++;
				}
			} catch { /* ignore */ }

			if (newPaths.length > 0) {
				contributing.push({
					displayPath: toDisplayPath(resolved),
					added: newPaths.length,
					skipped,
				});
			}
		}

		// ── 1. Global: ~/.claude/skills ─────────────────────────────────────────
		processClaudeSkillsDir(join(homedir(), ".claude", "skills"));

		// ── 2. Project-local: walk from cwd up to git root ──────────────────────
		// Claude Code places .claude/ at the git root, but walking up ensures we
		// find it even when pi is started from a subdirectory.
		let dir = resolve(event.cwd);
		for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
			processClaudeSkillsDir(join(dir, ".claude", "skills"));
			if (gitRoot !== null && dir === gitRoot) break;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		// ── Notify ───────────────────────────────────────────────────────────────
		if (contributing.length > 0) {
			const totalAdded = contributing.reduce((s, c) => s + c.added, 0);
			const totalSkipped = contributing.reduce((s, c) => s + c.skipped, 0);
			const dirSummary = contributing
				.map((c) => `${c.displayPath} (+${c.added})`)
				.join(", ");
			const skippedNote =
				totalSkipped > 0 ? ` — ${totalSkipped} skipped (already in pi)` : "";
			ctx.ui.notify(
				`claude-skills-bridge: ${totalAdded} new skill${totalAdded !== 1 ? "s" : ""} from ${dirSummary}${skippedNote}`,
				"info",
			);
		}

		return skillPaths.length > 0 ? { skillPaths } : undefined;
	});
}
