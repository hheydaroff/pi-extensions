/**
 * Spool — keep oversized tool output out of context, retrieve on demand.
 *
 * Two mechanisms:
 *
 *   1. Transparent interceptor (tool_result hook). When any tool returns a
 *      large, line-oriented text result, the full output is spooled to disk +
 *      indexed into FTS5, and what the model sees is replaced with a compact
 *      pointer (head + tail + ref). Zero behaviour change required from the
 *      agent. Fail-open: on any error the original output passes through
 *      untouched.
 *
 *   2. Opt-in tools:
 *        - spool_run    execute a script, return only stdout/tail/summary/ref
 *        - spool_index  index a file or pasted text for later search
 *        - spool_search BM25 search over captured/indexed output
 *        - spool_get    read a slice of a captured result by ref
 *
 * Storage: ~/.pi/agent/spool/
 *   - <session>/<ref>.out   full captured outputs (per session, 24h TTL)
 *   - index.db              node:sqlite FTS5 index (global, BM25 ranked)
 *   If node:sqlite is unavailable, search degrades to ripgrep over the
 *   capture files (fail-soft).
 *
 * Interceptor policy:
 *   - default ON in interactive (tui) and rpc modes
 *   - default OFF in print (-p) / json (non-interactive) modes, because
 *     autonomous loops (Ralph) often need full output for downstream parsing
 *     and cannot recover from a silent truncation. Override with
 *     SPOOL_INTERCEPT=1 (force on) or SPOOL_INTERCEPT=0 (force off), or at
 *     runtime with the /spool command (/spool enable|disable|auto). A /spool
 *     choice persists across restarts (state.json) and wins over env/mode.
 *
 * Usage: pi -e extensions/spool.ts
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────

const ROOT = join(homedir(), ".pi", "agent", "spool");
const DB_PATH = join(ROOT, "index.db");

const TRIGGER_BYTES = 6 * 1024; // 6 KB
const TRIGGER_LINES = 80; // must also be line-oriented
const HEAD_LINES = 20;
const TAIL_LINES = 20;
const CHUNK_BYTES = 1500;
const TTL_MS = 24 * 60 * 60 * 1000; // prune capture dirs older than 24h
const RUN_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MB cap on a single run's output

// ─── Module state ──────────────────────────────────────────────────────────

const STATE_PATH = join(ROOT, "state.json");

let currentSession = freshSessionId();
// null = follow mode/env default; true/false = explicit user override (/spool).
let runtimeOverride: boolean | null = loadInterceptPref();

function freshSessionId(): string {
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function loadInterceptPref(): boolean | null {
  try {
    if (!existsSync(STATE_PATH)) return null;
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    if (typeof raw?.intercept === "boolean") return raw.intercept;
  } catch {}
  return null;
}

function saveInterceptPref(v: boolean | null): void {
  try {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ intercept: v }));
  } catch {}
}

function updateSpoolStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus("spool", runtimeOverride === false ? "\u{1F9F5} off" : "");
  } catch {}
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function captureStats(): {
  sessionCount: number;
  sessionBytes: number;
  totalCount: number;
  totalBytes: number;
} {
  let sessionCount = 0;
  let sessionBytes = 0;
  let totalCount = 0;
  let totalBytes = 0;
  try {
    const cur = join(ROOT, currentSession);
    for (const entry of readdirSync(ROOT)) {
      const dir = join(ROOT, entry);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".out")) continue;
        let fst;
        try {
          fst = statSync(join(dir, f));
        } catch {
          continue;
        }
        totalCount++;
        totalBytes += fst.size;
        if (dir === cur) {
          sessionCount++;
          sessionBytes += fst.size;
        }
      }
    }
  } catch {}
  return { sessionCount, sessionBytes, totalCount, totalBytes };
}

function sessionDir(): string {
  const dir = join(ROOT, currentSession);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newRef(): string {
  return `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Storage: SQLite FTS5 with ripgrep fallback ──────────────────────────────

interface CaptureMeta {
  ref: string;
  session: string;
  tool: string;
  label: string;
  bytes: number;
  lines: number;
  path: string;
  created: number;
}

let db: any = null;
let sqliteOk = false;

function silenceSqliteWarning(): void {
  // node:sqlite emits a one-time ExperimentalWarning. Swallow only that one
  // so it doesn't clutter pi's stderr; pass everything else through.
  const orig = process.emitWarning.bind(process);
  (process as any).emitWarning = (warning: any, ...rest: any[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message || "";
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return (orig as any)(warning, ...rest);
  };
}

function initDb(): void {
  try {
    // node:sqlite is built in on Node 22.5+. Bundled pi runtime may differ —
    // if the import or FTS5 creation throws, we fall back to ripgrep search.
    silenceSqliteWarning();
    const sqlite = require("node:sqlite");
    mkdirSync(ROOT, { recursive: true });
    db = new sqlite.DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS captures(
        ref TEXT PRIMARY KEY,
        session TEXT, tool TEXT, label TEXT,
        bytes INTEGER, lines INTEGER, path TEXT, created INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks
        USING fts5(ref UNINDEXED, label, source, body);
    `);
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
}

function chunkText(text: string, maxBytes = CHUNK_BYTES): string[] {
  // Keep fenced code blocks intact; window prose by byte budget.
  const parts = text.split(/(```[\s\S]*?```)/g);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf);
    buf = "";
  };
  for (const part of parts) {
    if (part.startsWith("```")) {
      flush();
      chunks.push(part);
      continue;
    }
    for (const line of part.split("\n")) {
      if (buf && Buffer.byteLength(buf) + Buffer.byteLength(line) + 1 > maxBytes) {
        flush();
      }
      buf += (buf ? "\n" : "") + line;
    }
  }
  flush();
  return chunks.filter((c) => c.trim());
}

/** Persist full text to disk and (optionally) index it. Returns metadata. */
function capture(
  text: string,
  opts: { tool: string; label?: string; index: boolean },
): CaptureMeta {
  const ref = newRef();
  const bytes = Buffer.byteLength(text);
  const lines = text.split("\n").length;
  const path = join(sessionDir(), `${ref}.out`);
  writeFileSync(path, text, "utf-8");

  const meta: CaptureMeta = {
    ref,
    session: currentSession,
    tool: opts.tool,
    label: opts.label || opts.tool,
    bytes,
    lines,
    path,
    created: Date.now(),
  };

  if (sqliteOk && opts.index) {
    try {
      db.prepare(
        `INSERT OR REPLACE INTO captures
         (ref, session, tool, label, bytes, lines, path, created)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(ref, meta.session, meta.tool, meta.label, bytes, lines, path, meta.created);
      const ins = db.prepare(
        `INSERT INTO chunks(ref, label, source, body) VALUES (?,?,?,?)`,
      );
      for (const c of chunkText(text)) ins.run(ref, meta.label, opts.tool, c);
    } catch {
      /* indexing is best-effort */
    }
  }
  return meta;
}

interface SearchHit {
  ref: string;
  label: string;
  source: string;
  snippet: string;
  score: number;
}

function search(query: string, label: string | undefined, limit: number): SearchHit[] {
  if (sqliteOk) {
    try {
      const sql = label
        ? `SELECT ref, label, source,
                  snippet(chunks, 3, '《', '》', ' … ', 16) AS snip,
                  bm25(chunks) AS score
             FROM chunks WHERE chunks MATCH ? AND label = ?
             ORDER BY score LIMIT ?`
        : `SELECT ref, label, source,
                  snippet(chunks, 3, '《', '》', ' … ', 16) AS snip,
                  bm25(chunks) AS score
             FROM chunks WHERE chunks MATCH ?
             ORDER BY score LIMIT ?`;
      const stmt = db.prepare(sql);
      const rows = label ? stmt.all(query, label, limit) : stmt.all(query, limit);
      return rows.map((r: any) => ({
        ref: r.ref,
        label: r.label,
        source: r.source,
        snippet: String(r.snip).replace(/\s+/g, " ").trim(),
        score: r.score,
      }));
    } catch {
      /* fall through to ripgrep */
    }
  }
  // Fallback: ripgrep over capture files.
  try {
    const res = spawnSync(
      "rg",
      ["--no-heading", "--with-filename", "--max-count", "3", "-i", query, ROOT],
      { encoding: "utf-8", maxBuffer: MAX_BUFFER },
    );
    const lines = (res.stdout || "").split("\n").filter(Boolean).slice(0, limit);
    return lines.map((line) => {
      const idx = line.indexOf(":");
      const file = line.slice(0, idx);
      const body = line.slice(idx + 1);
      const ref = file.split("/").pop()?.replace(/\.out$/, "") || file;
      return { ref, label: "(rg)", source: "file", snippet: body.trim(), score: 0 };
    });
  } catch {
    return [];
  }
}

function getCapture(ref: string): CaptureMeta | null {
  if (sqliteOk) {
    try {
      const row = db.prepare(`SELECT * FROM captures WHERE ref = ?`).get(ref);
      if (row) return row as CaptureMeta;
    } catch {
      /* fall through */
    }
  }
  // Fallback: locate <ref>.out under any session dir.
  try {
    for (const s of readdirSync(ROOT)) {
      const p = join(ROOT, s, `${ref}.out`);
      if (existsSync(p)) {
        const text = readFileSync(p, "utf-8");
        return {
          ref,
          session: s,
          tool: "?",
          label: "?",
          bytes: Buffer.byteLength(text),
          lines: text.split("\n").length,
          path: p,
          created: statSync(p).mtimeMs,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ─── Lifecycle helpers ──────────────────────────────────────────────────────

function pruneOldCaptures(): void {
  try {
    if (!existsSync(ROOT)) return;
    const now = Date.now();
    for (const entry of readdirSync(ROOT)) {
      if (!entry.startsWith("s_")) continue; // only session capture dirs
      const dir = join(ROOT, entry);
      try {
        const st = statSync(dir);
        if (st.isDirectory() && now - st.mtimeMs > TTL_MS) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* ignore individual dir errors */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Should the transparent interceptor run in this mode? */
function interceptEnabled(ctx: ExtensionContext): boolean {
  // Explicit /spool toggle wins over everything for this/future sessions.
  if (runtimeOverride !== null) return runtimeOverride;
  const env = process.env.SPOOL_INTERCEPT;
  if (env === "1") return true;
  if (env === "0") return false;
  const mode = (ctx as any).mode as string | undefined;
  // Default: on for interactive (tui) and rpc; off for print/json.
  return mode === "tui" || mode === "rpc" || mode === undefined;
}

function textOf(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function headTail(text: string): string {
  const lines = text.split("\n");
  const head = lines.slice(0, HEAD_LINES).join("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return `──── head (${HEAD_LINES} lines) ────\n${head}\n\n──── tail (${TAIL_LINES} lines) ────\n${tail}`;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  initDb();

  // ── Soft routing guidance ────────────────────────────────────────────────
  pi.on("before_agent_start", async (event) => {
    const injection = `
## Spool (context-saving output capture)

Large tool/command output is automatically spooled out of context and replaced
with a pointer (ref) plus head/tail. To work with spooled or large data:

- Use **spool_run** to execute a script and return only the result you need
  (stdout/tail/summary), instead of running a command whose full output floods
  context. Think in code: compute the answer in the script and print only that.
- Use **spool_search** to BM25-search captured/indexed output by keyword.
- Use **spool_get** with a ref to read a slice of a captured result.
- Use **spool_index** to index a large file or pasted text for later search.
`;
    return { systemPrompt: event.systemPrompt + injection };
  });

  // ── Session lifecycle ──────────────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "reload" || event.reason === "startup") {
      currentSession = freshSessionId();
    }
    pruneOldCaptures();
    updateSpoolStatus(ctx);
  });

  // ── /spool runtime toggle ───────────────────────────────────────────────
  pi.registerCommand("spool", {
    description:
      "Toggle the context-saving interceptor. /spool, /spool enable, /spool disable, /spool auto",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "enable" || arg === "on") {
        runtimeOverride = true;
        saveInterceptPref(true);
        updateSpoolStatus(ctx);
        ctx.ui.notify("\u{1F9F5} Spool interceptor enabled", "success");
        return;
      }
      if (arg === "disable" || arg === "off") {
        runtimeOverride = false;
        saveInterceptPref(false);
        updateSpoolStatus(ctx);
        ctx.ui.notify(
          "\u{1F9F5} Spool interceptor disabled \u2014 large output passes through untouched. Manual tools (spool_run/search/get/index) still work.",
          "info",
        );
        return;
      }
      if (arg === "auto" || arg === "reset" || arg === "default") {
        runtimeOverride = null;
        saveInterceptPref(null);
        updateSpoolStatus(ctx);
        ctx.ui.notify("\u{1F9F5} Spool interceptor reset to mode default (on for tui/rpc)", "info");
        return;
      }

      // No arg / status
      const on = interceptEnabled(ctx);
      const env = process.env.SPOOL_INTERCEPT;
      const src =
        runtimeOverride !== null
          ? "set via /spool"
          : env === "0" || env === "1"
            ? "set via SPOOL_INTERCEPT env"
            : "mode default";
      const s = captureStats();
      ctx.ui.notify(
        `\u{1F9F5} Spool interceptor: ${on ? "ON" : "OFF"} (${src}).\n` +
          `Captures \u2014 this session: ${s.sessionCount} (${fmtBytes(s.sessionBytes)}) \u00b7 ` +
          `all sessions: ${s.totalCount} (${fmtBytes(s.totalBytes)}).\n` +
          `Manual tools are always available. Use /spool enable | disable | auto`,
        "info",
      );
    },
  });

  // ── Transparent interceptor ────────────────────────────────────────────────
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    try {
      if (!interceptEnabled(ctx)) return;
      if (event.isError) return; // never truncate error output
      const blocks = event.content as { type: string; text?: string }[];
      const text = textOf(blocks);
      if (!text) return;

      const bytes = Buffer.byteLength(text);
      const lineCount = text.split("\n").length;
      // Gate: large AND line-oriented.
      if (bytes < TRIGGER_BYTES || lineCount < TRIGGER_LINES) return;
      // Conservative JSON guard: leave structured payloads intact.
      const t = text.trimStart();
      if (t.startsWith("{") || t.startsWith("[")) return;

      const meta = capture(text, {
        tool: event.toolName,
        label: event.toolName,
        index: true,
      });

      const pointer =
        `[spool] ${event.toolName} output: ${(bytes / 1024).toFixed(1)} KB, ${lineCount} lines — ` +
        `truncated to keep context lean.\n` +
        `ref: ${meta.ref}  (spool_get ref:"${meta.ref}" for slices · spool_search query:"…")\n\n` +
        headTail(text);

      // Preserve any non-text (image) blocks; replace the text with the pointer.
      const kept = blocks.filter((b) => b.type !== "text");
      return {
        content: [...(kept as any), { type: "text", text: pointer }],
      };
    } catch {
      // Fail-open: never lose data because of the interceptor.
      return;
    }
  });

  // ── spool_run ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "spool_run",
    label: "Spool Run",
    description:
      "Execute a script (bash/javascript/python) and return only the result you ask for, " +
      "keeping full output out of context. Compute the answer in the script and print only that.",
    promptSnippet: "Run a script and return only stdout/tail/summary (context-saving)",
    promptGuidelines: [
      "Prefer spool_run over bash when a command may produce large output and you only need a computed result.",
      "Print only the answer from your script (think in code) instead of dumping raw data.",
      "Use return:'summary' for logs/build output, return:'tail' for the last N lines, return:'ref' to defer to spool_search.",
    ],
    parameters: Type.Object({
      lang: Type.Union([Type.Literal("bash"), Type.Literal("javascript"), Type.Literal("python")], {
        description: "Interpreter for the script.",
      }),
      code: Type.String({ description: "Script source to execute." }),
      return: Type.Optional(
        Type.Union(
          [
            Type.Literal("stdout"),
            Type.Literal("tail"),
            Type.Literal("summary"),
            Type.Literal("ref"),
          ],
          { description: "What to return. Default 'stdout' (auto head+tail+ref if large)." },
        ),
      ),
      tail_lines: Type.Optional(Type.Number({ description: "Lines for return:'tail' (default 40)." })),
      label: Type.Optional(Type.String({ description: "Human tag for the captured output." })),
      index: Type.Optional(Type.Boolean({ description: "Index output for spool_search (default true if large)." })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { lang, code } = params;
      const mode = params.return || "stdout";
      const tailN = params.tail_lines ?? 40;

      const cmd =
        lang === "bash"
          ? { bin: "bash", args: ["-c", code] }
          : lang === "javascript"
            ? { bin: "node", args: ["--input-type=module", "-e", code] }
            : { bin: "python3", args: ["-c", code] };

      const res = spawnSync(cmd.bin, cmd.args, {
        encoding: "utf-8",
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });

      const stdout = res.stdout || "";
      const stderr = res.stderr || "";
      const combined = stdout + (stderr ? `\n──── stderr ────\n${stderr}` : "");
      const timedOut = (res as any).signal === "SIGTERM" && res.status === null;
      const exit = res.status ?? -1;

      const bytes = Buffer.byteLength(combined);
      const lineCount = combined.split("\n").length;
      const large = bytes >= TRIGGER_BYTES;
      const doIndex = params.index ?? large;

      const meta = capture(combined, {
        tool: `spool_run:${lang}`,
        label: params.label,
        index: doIndex,
      });

      const header =
        `exit=${exit}${timedOut ? " (TIMEOUT)" : ""} · ${(bytes / 1024).toFixed(1)} KB · ${lineCount} lines · ref=${meta.ref}`;

      let body: string;
      switch (mode) {
        case "ref":
          body = `${header}\n(use spool_get ref:"${meta.ref}" or spool_search)`;
          break;
        case "tail":
          body = `${header}\n──── tail (${tailN}) ────\n${combined.split("\n").slice(-tailN).join("\n")}`;
          break;
        case "summary": {
          const errs = (combined.match(/\berror\b/gi) || []).length;
          const warns = (combined.match(/\bwarn(ing)?\b/gi) || []).length;
          body =
            `${header}\nerrors≈${errs} warnings≈${warns}\n` +
            headTail(combined);
          break;
        }
        default: // stdout
          body = large ? `${header}\n${headTail(combined)}` : `${header}\n${combined}`;
      }

      return {
        content: [{ type: "text", text: body }],
        details: { ref: meta.ref, exit, bytes, lines: lineCount, timedOut, indexed: doIndex },
        isError: exit !== 0 && exit !== -1 ? false : timedOut, // surface timeout as error
      };
    },
  });

  // ── spool_index ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "spool_index",
    label: "Spool Index",
    description: "Index a local file or pasted text into the searchable store for later spool_search.",
    promptSnippet: "Index a file or text for later keyword search",
    promptGuidelines: [
      "Index large docs/payloads instead of reading them fully into context, then spool_search on demand.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "File to index (mutually exclusive with text)." })),
      text: Type.Optional(Type.String({ description: "Raw text to index (mutually exclusive with path)." })),
      label: Type.String({ description: "Label to tag and later filter by." }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { path, text, label } = params;
      let content = "";
      if (path) {
        try {
          content = readFileSync(path, "utf-8");
        } catch (e: any) {
          return { content: [{ type: "text", text: `Error reading ${path}: ${e.message}` }], details: {}, isError: true };
        }
      } else if (text) {
        content = text;
      } else {
        return { content: [{ type: "text", text: "Error: provide 'path' or 'text'." }], details: {}, isError: true };
      }
      const meta = capture(content, { tool: "spool_index", label, index: true });
      return {
        content: [{ type: "text", text: `Indexed ${(meta.bytes / 1024).toFixed(1)} KB under label "${label}" (ref ${meta.ref}). Search with spool_search.` }],
        details: { ref: meta.ref, bytes: meta.bytes, sqlite: sqliteOk },
      };
    },
  });

  // ── spool_search ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "spool_search",
    label: "Spool Search",
    description: "Search captured/indexed output by keyword (BM25 ranked). Returns top matching chunks with refs.",
    promptSnippet: "Search spooled/indexed output by keyword",
    promptGuidelines: [
      "When a tool result was spooled (you saw a [spool] pointer), search it here instead of re-running the command.",
      "Use the returned ref with spool_get to read the surrounding slice.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "FTS5 / keyword query." }),
      label: Type.Optional(Type.String({ description: "Restrict to a label." })),
      limit: Type.Optional(Type.Number({ description: "Max hits (default 5)." })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const hits = search(params.query, params.label, params.limit ?? 5);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${params.query}".` }], details: { hits: 0, sqlite: sqliteOk } };
      }
      const out = hits
        .map((h, i) => `${i + 1}. [${h.label}] ref=${h.ref}\n   ${h.snippet}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `## ${hits.length} match(es)\n${out}\n\n(spool_get ref:"…" to read more)` }],
        details: { hits: hits.length, refs: hits.map((h) => h.ref), sqlite: sqliteOk },
      };
    },
  });

  // ── spool_get ─────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "spool_get",
    label: "Spool Get",
    description: "Read a captured output by ref. Optionally a line range, e.g. lines:'1-200'.",
    promptSnippet: "Read a slice of a captured output by ref",
    promptGuidelines: [
      "Use the ref from a [spool] pointer or from spool_search results.",
      "Prefer a line range to keep context lean; read the whole thing only when necessary.",
    ],
    parameters: Type.Object({
      ref: Type.String({ description: "Capture ref, e.g. 'sp_abc123'." }),
      lines: Type.Optional(Type.String({ description: "Line range 'start-end' (1-indexed). Omit for whole file (capped)." })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const meta = getCapture(params.ref);
      if (!meta || !existsSync(meta.path)) {
        return { content: [{ type: "text", text: `Ref "${params.ref}" not found (may have expired after 24h).` }], details: {}, isError: true };
      }
      const all = readFileSync(meta.path, "utf-8").split("\n");
      let slice = all;
      let rangeNote = `lines 1-${all.length}`;
      if (params.lines) {
        const m = params.lines.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
          const a = Math.max(1, parseInt(m[1], 10));
          const b = Math.min(all.length, parseInt(m[2], 10));
          slice = all.slice(a - 1, b);
          rangeNote = `lines ${a}-${b} of ${all.length}`;
        }
      }
      // Safety cap on a single read back into context.
      const MAX_LINES = 600;
      let capped = false;
      if (slice.length > MAX_LINES) {
        slice = slice.slice(0, MAX_LINES);
        capped = true;
      }
      const txt = `ref=${params.ref} · ${rangeNote}${capped ? ` (capped to ${MAX_LINES})` : ""}\n\n${slice.join("\n")}`;
      return { content: [{ type: "text", text: txt }], details: { ref: params.ref, totalLines: all.length, capped } };
    },
  });
}
