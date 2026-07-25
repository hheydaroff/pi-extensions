/**
 * cost-tracker — logs per-project AI spend over time.
 *
 * Every assistant (and usage-bearing tool) message is appended as one JSON line
 * to ~/.pi/agent/cost-log.jsonl, tagged with the project (cwd). The log is the
 * feature: it persists across sessions and projects. `/costs` reads it back and
 * shows spend grouped by project.
 *
 * Log line shape:
 *   {ts, cwd, project, provider, model, cost, input, output,
 *    cacheRead, cacheWrite, totalTokens, sessionId, role}
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const LOG_PATH = join(homedir(), ".pi", "agent", "cost-log.jsonl");
const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

type Row = {
	ts: number;
	cwd: string;
	project: string;
	provider?: string;
	model?: string;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	sessionId?: string;
	role: string;
};

function logEvent(row: Row): void {
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		appendFileSync(LOG_PATH, JSON.stringify(row) + "\n");
	} catch {
		/* never let logging break the agent */
	}
}

// Content fingerprint for dedup — deliberately excludes sessionId so forked/cloned
// sessions (same message, new session id) collapse to one entry.
function fpOf(r: {
	ts: number;
	provider?: string;
	model?: string;
	input: number;
	output: number;
	cost: number;
}): string {
	return `${r.ts}|${r.provider ?? ""}|${r.model ?? ""}|${r.input}|${r.output}|${r.cost}`;
}

function readRows(): Row[] {
	let text: string;
	try {
		text = readFileSync(LOG_PATH, "utf8");
	} catch {
		return [];
	}
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			/* skip corrupt line */
		}
	}
	return rows;
}

const money = (n: number) => "$" + n.toFixed(n < 1 ? 4 : 2);
const ktok = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

function windowStart(arg: string): number {
	const now = new Date();
	switch (arg) {
		case "today":
			return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		case "week":
			return now.getTime() - 7 * 864e5;
		case "month":
			return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
		default:
			return 0; // all
	}
}

function buildReport(rows: Row[], win: string, byModel: boolean): string[] {
	const start = windowStart(win);
	const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

	type Agg = { cost: number; month: number; tokens: number; msgs: number; last: number; name: string; detail: string };
	const groups = new Map<string, Agg>();
	let total = 0;
	let totalMonth = 0;

	for (const r of rows) {
		if (r.ts < start) continue;
		total += r.cost;
		if (r.ts >= monthStart) totalMonth += r.cost;
		const key = byModel ? `${r.provider ?? "?"}/${r.model ?? "?"}` : r.cwd;
		let a = groups.get(key);
		if (!a) {
			a = {
				cost: 0,
				month: 0,
				tokens: 0,
				msgs: 0,
				last: 0,
				name: byModel ? r.model ?? "?" : r.project || basename(r.cwd),
				detail: byModel ? r.provider ?? "" : r.cwd,
			};
			groups.set(key, a);
		}
		a.cost += r.cost;
		if (r.ts >= monthStart) a.month += r.cost;
		a.tokens += r.totalTokens;
		a.msgs += 1;
		if (r.ts > a.last) a.last = r.ts;
	}

	const label = win === "all" ? "all time" : win;
	const dim = byModel ? "by model" : "by project";
	const lines: string[] = [];
	lines.push(`  AI spend ${dim} — ${label}`);
	lines.push(`  total ${money(total)}   this month ${money(totalMonth)}   (log: ${LOG_PATH})`);
	lines.push("");

	if (groups.size === 0) {
		lines.push("  No cost data logged yet.");
		return lines;
	}

	const sorted = [...groups.values()].sort((a, b) => b.cost - a.cost);
	const col = byModel ? "MODEL" : "PROJECT";
	const w = 30;
	lines.push(`  ${col.padEnd(w)} SPEND        MONTH       TOKENS     MSGS   LAST`);
	lines.push("  " + "-".repeat(80));
	for (const a of sorted) {
		const name = a.name.length > w ? a.name.slice(0, w - 1) + "…" : a.name.padEnd(w);
		const last = new Date(a.last).toISOString().slice(0, 10);
		lines.push(
			"  " +
				name +
				" " +
				money(a.cost).padStart(9) +
				"  " +
				money(a.month).padStart(9) +
				"  " +
				ktok(a.tokens).padStart(9) +
				"  " +
				String(a.msgs).padStart(5) +
				"  " +
				last +
				"   " +
				a.detail,
		);
	}
	lines.push("");
	lines.push("  /costs [models] [today|week|month|all]   ·   press any key to close");
	return lines;
}

// Scan pi session files and replay their per-message usage into the log,
// deduped by content fingerprint so re-runs, live-logged rows, and forked
// sessions never double-count. Returns a report.
function runBackfill(): string[] {
	const existing = readRows();
	const seen = new Set(existing.map(fpOf));

	let sessionDirs: string[];
	try {
		sessionDirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(SESSIONS_ROOT, d.name));
	} catch {
		return ["  No pi sessions directory found at " + SESSIONS_ROOT];
	}

	let files = 0;
	let added = 0;
	let skipped = 0;
	const newByProject = new Map<string, number>();

	for (const dir of sessionDirs) {
		let jsonls: string[];
		try {
			jsonls = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of jsonls) {
			files++;
			let text: string;
			try {
				text = readFileSync(join(dir, f), "utf8");
			} catch {
				continue;
			}
			let cwd = "";
			let sessionId: string | undefined;
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				let e: any;
				try {
					e = JSON.parse(line);
				} catch {
					continue;
				}
				if (e.type === "session") {
					cwd = e.cwd ?? "";
					sessionId = e.id;
					continue;
				}

				// message entries: assistant / toolResult carry usage on the message
				let usage: any;
				let provider: string | undefined;
				let model: string | undefined;
				let ts: number | undefined;
				let role = e.type;
				if (e.type === "message" && e.message) {
					usage = e.message.usage;
					provider = e.message.provider;
					model = e.message.model;
					ts = e.message.timestamp;
					role = e.message.role;
				} else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
					// summary-generation cost; no provider/model recorded
					usage = e.usage;
					ts = Date.parse(e.timestamp) || undefined;
				}
				if (!usage || !usage.cost) continue;
				const cost = usage.cost.total ?? 0;
				const tokens = usage.totalTokens ?? 0;
				if (cost <= 0 && tokens <= 0) continue;
				if (ts == null) ts = Date.parse(e.timestamp) || Date.now();

				const row: Row = {
					ts,
					cwd,
					project: cwd ? basename(cwd) : "(unknown)",
					provider,
					model,
					cost,
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
					totalTokens: tokens,
					sessionId,
					role,
				};
				const fp = fpOf(row);
				if (seen.has(fp)) {
					skipped++;
					continue;
				}
				seen.add(fp);
				logEvent(row);
				added++;
				newByProject.set(cwd, (newByProject.get(cwd) ?? 0) + cost);
			}
		}
	}

	const lines: string[] = [];
	lines.push("  Backfill complete.");
	lines.push(`  scanned ${files} session files   ·   added ${added} rows   ·   skipped ${skipped} (already logged)`);
	if (newByProject.size) {
		lines.push("");
		lines.push("  newly added spend by project:");
		for (const [cwd, c] of [...newByProject.entries()].sort((a, b) => b[1] - a[1])) {
			lines.push("  " + money(c).padStart(9) + "   " + (cwd ? basename(cwd) : "(unknown)") + "   " + cwd);
		}
	}
	lines.push("");
	lines.push("  run /costs to view · press any key to close");
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event, ctx) => {
		const m: any = event.message;
		const u = m?.usage;
		if (!u || !u.cost) return;
		const cost = u.cost.total ?? 0;
		if (cost <= 0 && (u.totalTokens ?? 0) <= 0) return; // nothing to record

		logEvent({
			ts: m.timestamp ?? Date.now(),
			cwd: ctx.cwd,
			project: basename(ctx.cwd),
			provider: m.provider,
			model: m.model,
			cost,
			input: u.input ?? 0,
			output: u.output ?? 0,
			cacheRead: u.cacheRead ?? 0,
			cacheWrite: u.cacheWrite ?? 0,
			totalTokens: u.totalTokens ?? 0,
			sessionId: ctx.sessionManager.getSessionId?.(),
			role: m.role,
		});
	});

	pi.registerCommand("costs", {
		description: "AI spend per project/model (args: [models] [today|week|month|all] | backfill)",
		handler: async (args, ctx) => {
			const toks = (args || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			const lines = toks.includes("backfill")
				? runBackfill()
				: buildReport(
						readRows(),
						toks.find((t) => ["today", "week", "month", "all"].includes(t)) || "all",
						toks.includes("models") || toks.includes("model"),
				  );

			if (ctx.mode !== "tui") {
				console.log(lines.join("\n"));
				return;
			}
			await ctx.ui.custom<null>(
				(_tui, _theme, _kb, done) => ({
					render: (width: number) => lines.map((l) => truncateToWidth(l, width)),
					handleInput: () => done(null),
					invalidate: () => {},
				}),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
			);
		},
	});
}
