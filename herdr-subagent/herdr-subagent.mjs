#!/usr/bin/env node
// herdr-subagent: run pi subagents as visible Herdr panes, controlled from a bash tool.
// Zero dependencies: node builtins + the `herdr` binary. Herdr owns process lifetime,
// naming, liveness and lifecycle state; this CLI only glues them together.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "sa-";
export const CHILD_ENV = "HERDR_SUBAGENT"; // set in every child pane: blocks nested spawning
const INDEX_DIR = process.env.HERDR_SUBAGENT_STATE_DIR || join(homedir(), ".local", "state", "herdr-subagent");
const DEFAULT_WAIT_S = 1800;
const TRUST_FILE = process.env.HERDR_SUBAGENT_TRUST_FILE || join(homedir(), ".pi", "agent", "trust.json");

/**
 * Environment every child pane gets.
 *  - HERDR_SUBAGENT: marks the pane as a child (blocks nesting).
 *  - PI_SKIP_VERSION_CHECK: update-checker.ts opens a select whose default is "Update and restart now";
 *    our prompt's Enter would pick it and start a global npm install inside the child.
 */
export const CHILD_ENV_VARS = [`${CHILD_ENV}=1`, "PI_SKIP_VERSION_CHECK=1"];

/**
 * pi asks "trust this folder?" when a cwd has project-local .pi resources and no saved decision;
 * our prompt's Enter would silently answer yes. Unless the folder (or a parent) is already trusted,
 * start the child with --no-approve so nothing is asked and nothing project-local is executed.
 */
export function trustArgs(cwd, trustFile = TRUST_FILE) {
	let saved = {};
	try {
		saved = JSON.parse(readFileSync(trustFile, "utf8"));
	} catch {}
	let dir;
	try {
		dir = realpathSync(cwd);
	} catch {
		dir = cwd;
	}
	for (;;) {
		if (Object.hasOwn(saved, dir)) return saved[dir] === true ? [] : ["--no-approve"];
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return ["--no-approve"];
}

export class CliError extends Error {
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}
const die = (msg, code = 1) => {
	throw new CliError(msg, code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- herdr plumbing -------------------------------------------------------
function herdr(args, { allowFail = false, raw = false } = {}) {
	const r = spawnSync("herdr", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (r.error) die(`cannot run herdr: ${r.error.message}`);
	if (raw && r.status === 0) return r.stdout;
	let json;
	try {
		json = JSON.parse((r.stdout || "").trim() || (r.stderr || "").trim() || "null");
	} catch {
		json = null;
	}
	if (r.status !== 0 || json?.error) {
		const error = json?.error ?? { code: "exit_" + r.status, message: (r.stderr || "").trim() };
		if (allowFail) return { error };
		die(`herdr ${args.slice(0, 2).join(" ")}: ${error.code}: ${error.message}`);
	}
	return json?.result ?? json;
}

const getAgent = (name) => {
	const r = herdr(["agent", "get", name], { allowFail: true });
	return r.error ? null : r.agent;
};

function requireParent() {
	if (process.env.HERDR_ENV !== "1") die("not inside a Herdr pane (HERDR_ENV!=1); refusing to act");
}

// ---- names, text ----------------------------------------------------------
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Normalise user input to a full, validated agent name ("t1" -> "sa-t1"). */
export function resolveName(raw) {
	if (!raw || raw.startsWith("--")) die("missing <name>");
	const name = raw.startsWith(PREFIX) ? raw : PREFIX + raw;
	if (name === PREFIX || !NAME_RE.test(name)) die(`invalid name "${raw}" (lowercase a-z 0-9 _ -, max 32 chars including "${PREFIX}", must start with a letter)`);
	return name;
}

/**
 * pi's TUI treats a leading "/" as a slash command and a leading "!" as a direct bash
 * execution. A delegated prompt must never be interpreted that way. A leading "-" is
 * neutralised too so it can never be mistaken for a CLI flag by any layer.
 */
export function sanitizeText(text) {
	return /^[\/!\-]/.test(text) ? `Task: ${text}` : text;
}

// ---- index (so `result` works after the child has exited) -----------------
const indexFile = (name) => join(INDEX_DIR, `${name}.json`);
function saveIndex(name, data) {
	mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(indexFile(name), JSON.stringify(data, null, 2), { mode: 0o600 });
}
function loadIndex(name) {
	try {
		return JSON.parse(readFileSync(indexFile(name), "utf8"));
	} catch {
		return null;
	}
}

// ---- transcript -----------------------------------------------------------
/**
 * Inspect a pi session JSONL and describe the child's latest reply.
 * Returns { text, stopReason, errorMessage, pending, users } or null if the file has no assistant message.
 *  - users: number of user messages recorded so far.
 *  - pending: a user message arrived after the last assistant message (not answered yet).
 *  - tolerates a partially written final line and non-message entries.
 */
export function readLatestReply(sessionFile) {
	if (!sessionFile || !existsSync(sessionFile)) return null;
	let users = 0;
	let last = null;
	let pending = false;
	for (const raw of readFileSync(sessionFile, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role === "user") {
			users++;
			pending = true;
		} else if (role === "assistant") {
			last = e.message;
			pending = false;
		}
	}
	if (!last) return null;
	const text = (Array.isArray(last.content) ? last.content : [])
		.filter((c) => c?.type === "text")
		.map((c) => c.text)
		.join("");
	return { text, stopReason: last.stopReason ?? null, errorMessage: last.errorMessage ?? null, pending, users };
}

function bumpSent(name) {
	const idx = loadIndex(name);
	if (idx) saveIndex(name, { ...idx, sent: (idx.sent ?? 0) + 1 });
}

function sessionOf(name) {
	return getAgent(name)?.agent_session?.value ?? loadIndex(name)?.sessionFile ?? null;
}

/** Print the reply, or fail loudly if the child errored/aborted/never answered. */
function emitReply(name, reply, out = process.stdout) {
	if (!reply) die(`no assistant message found for ${name}`);
	if (reply.pending) die(`${name} has not answered its latest message (it was interrupted or never started)`);
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		const why = reply.errorMessage || (reply.stopReason === "aborted" ? "run was aborted" : "run failed");
		die(`${name} failed (${reply.stopReason}): ${why}${reply.text ? `\n${reply.text}` : ""}`);
	}
	if (reply.stopReason === "toolUse") die(`${name}'s run ended mid-task (last message was a tool call, no final answer); it was interrupted or killed`);
	if (reply.stopReason === "length") process.stderr.write(`warning: ${name}'s reply was cut off (max output tokens)\n`);
	out.write((reply.text || "(assistant reply was empty)") + "\n");
}

// ---- arg parsing ----------------------------------------------------------
export function parse(argv, spec) {
	const opts = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--") && a.length > 2) {
			const key = a.slice(2);
			if (!Object.hasOwn(spec, key)) die(`unknown option --${key}`);
			if (spec[key] === "bool") opts[key] = true;
			else {
				if (i + 1 >= argv.length) die(`--${key} needs a value`);
				opts[key] = argv[++i];
			}
		} else rest.push(a);
	}
	return { opts, rest };
}

function readPrompt(rest) {
	if (rest.length === 1 && rest[0] === "-") return readFileSync(0, "utf8").trim();
	return rest.join(" ").trim();
}

// ---- layout: all children live in one dedicated tab ------------------------
export const DEFAULT_TAB = "subagents";

/** Cross-process mutex (mkdir is atomic). Held while a pane is created AND claimed by its agent name. */
async function withLayoutLock(fn) {
	mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
	const lock = join(INDEX_DIR, "layout.lock");
	const deadline = Date.now() + 90000;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 60000) rmdirSync(lock); // holder died; steal
			} catch {}
			if (Date.now() > deadline) die("timed out waiting for the layout lock (another spawn is stuck?)");
			await sleep(100);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			rmdirSync(lock);
		} catch {}
	}
}

/**
 * Find or create the child tab and return a pane to host the next child:
 * a free shell pane left in it, or a new split of the last child pane (alternating right/down).
 * Called under the layout lock.
 */
function allocatePane({ tabLabel, here, direction, cwd }) {
	const env = CHILD_ENV_VARS.flatMap((kv) => ["--env", kv]);
	if (here) {
		const r = herdr(["pane", "split", "--current", "--direction", direction ?? "right", "--cwd", cwd, ...env, "--no-focus"]);
		return { pane: r.pane.pane_id, tab: null, createdTab: false };
	}
	const workspace = process.env.HERDR_WORKSPACE_ID;
	if (!workspace) die("HERDR_WORKSPACE_ID is not set; cannot locate the workspace");
	const tabs = herdr(["tab", "list", "--workspace", workspace]).tabs ?? [];
	const tab = tabs.find((t) => t.label === tabLabel);
	if (!tab) {
		const r = herdr(["tab", "create", "--workspace", workspace, "--label", tabLabel, "--cwd", cwd, ...env, "--no-focus"]);
		return { pane: r.root_pane.pane_id, tab: r.tab.tab_id, createdTab: true };
	}
	const inTab = (herdr(["pane", "list", "--workspace", workspace]).panes ?? []).filter((p) => p.tab_id === tab.tab_id);
	const agents = new Map((herdr(["agent", "list"]).agents ?? []).map((a) => [a.pane_id, a]));
	// Reuse a bare shell pane (nothing running but the shell, no agent) before splitting.
	for (const p of inTab) {
		if (agents.has(p.pane_id)) continue;
		const info = herdr(["pane", "process-info", "--pane", p.pane_id], { allowFail: true }).process_info;
		const fg = info?.foreground_processes ?? [];
		if (info && fg.length === 1 && fg[0].pid === info.shell_pid) return { pane: p.pane_id, tab: tab.tab_id, createdTab: false, reused: true };
	}
	const kids = inTab.filter((p) => agents.get(p.pane_id)?.name?.startsWith(PREFIX));
	const target = (kids.length ? kids[kids.length - 1] : inTab[inTab.length - 1])?.pane_id;
	if (!target) die(`tab "${tabLabel}" has no panes`);
	const dir = direction ?? (kids.length % 2 === 1 ? "right" : "down");
	const r = herdr(["pane", "split", target, "--direction", dir, "--cwd", cwd, ...env, "--no-focus"]);
	return { pane: r.pane.pane_id, tab: tab.tab_id, createdTab: false };
}

/** `agent prompt` can return a beat before the lifecycle flips; wait until a state change was observed. */
async function untilActed(name, seqBefore, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const a = getAgent(name);
		if (!a) return false;
		if (a.state_change_seq > seqBefore || (a.agent_status !== "idle" && a.agent_status !== "done")) return true;
		await sleep(150);
	}
	return false;
}

function positiveNumber(raw, label) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) die(`${label} must be a positive number, got "${raw}"`);
	return n;
}

// ---- commands -------------------------------------------------------------
async function spawnCmd(argv, io) {
	requireParent();
	if (process.env[CHILD_ENV]) die("nested subagents are disabled (this pane is itself a subagent)");
	const { opts, rest } = parse(argv, {
		name: "str", tools: "str", model: "str", provider: "str", thinking: "str",
		direction: "str", cwd: "str", tab: "str", here: "bool", "no-prompt": "bool",
	});
	const prompt = readPrompt(rest);
	if (!prompt && !opts["no-prompt"]) die('usage: spawn [--name n] [--tools a,b] [--direction right|down] "<prompt>"  (or "-" for stdin)');
	if (opts.direction && !["right", "down"].includes(opts.direction)) die(`--direction must be right or down, got "${opts.direction}"`);

	const name = resolveName(opts.name ?? randomBytes(3).toString("hex"));
	if (getAgent(name)) die(`${name} already exists; pick another --name or stop it first`);

	const provider = opts.provider ?? process.env.PI_PROVIDER;
	const model = opts.model ?? process.env.PI_MODEL;
	const thinking = opts.thinking ?? process.env.PI_REASONING_LEVEL ?? "medium";
	if (!provider || !model) die("no provider/model: pass --provider and --model (PI_PROVIDER/PI_MODEL unset)");
	const piArgs = ["--provider", provider, "--model", model, "--thinking", thinking];
	if (opts.tools) piArgs.push("--tools", opts.tools);

	const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) die(`--cwd is not a directory: ${cwd}`);
	piArgs.push(...trustArgs(cwd));

	// Everything from pane creation to claiming the pane with an agent name runs under a lock,
	// so parallel spawns neither create several child tabs nor grab each other's pane.
	const pane = await withLayoutLock(async () => {
		if (getAgent(name)) die(`${name} already exists; pick another --name or stop it first`);
		const slot = allocatePane({ tabLabel: opts.tab ?? DEFAULT_TAB, here: !!opts.here, direction: opts.direction, cwd });
		const pane = slot.pane;
		const abort = (msg) => {
			herdr(["pane", "close", pane], { allowFail: true });
			die(msg);
		};
		// A recycled shell was not created with the child marker; set it so nesting stays blocked.
		if (slot.reused) herdr(["pane", "run", pane, `export ${CHILD_ENV_VARS.join(" ")}; clear`]);

		// A fresh pane's shell may not be at its prompt yet; retry.
		let started;
		for (let attempt = 0; attempt < 3; attempt++) {
			started = herdr(["agent", "start", name, "--kind", "pi", "--pane", pane, "--", ...piArgs], { allowFail: true });
			if (!started.error) break;
			if (started.error.code === "agent_name_taken") abort(`${name} was taken by another spawn; pick another --name`);
			await sleep(1500);
		}
		if (started.error) abort(`could not start pi in pane ${pane}: ${started.error.code}: ${started.error.message}`);

		const sessionFile = started.agent?.agent_session?.value ?? null;
		saveIndex(name, { name, pane, tab: slot.tab, sessionFile, cwd, provider, model, thinking, tools: opts.tools ?? null, sent: 0, created: new Date().toISOString() });
		return pane;
	});

	if (prompt) {
		const seq = getAgent(name)?.state_change_seq ?? 0;
		const p = herdr(["agent", "prompt", name, sanitizeText(prompt)], { allowFail: true });
		if (p.error) abort(`started ${name} but could not prompt it (${p.error.code}: ${p.error.message}); pane closed`);
		bumpSent(name);
		if (!(await untilActed(name, seq))) io.err.write("warning: no lifecycle change observed after prompting; check 'peek'\n");
	}
	io.out.write(`Spawned ${name}\nPane: ${pane}\nState: ${prompt ? "working" : "idle"}\nNext: herdr-subagent wait ${name}\n`);
}

function listCmd(argv, io) {
	requireParent();
	const agents = (herdr(["agent", "list"]).agents ?? []).filter((a) => a.name?.startsWith(PREFIX));
	if (!agents.length) return io.out.write("No subagents.\n");
	for (const a of agents) io.out.write(`${a.name}\t${a.agent_status}\t${a.pane_id}\t${a.cwd}\n`);
}

function statusCmd(argv, io) {
	requireParent();
	const name = resolveName(argv[0]);
	const a = getAgent(name);
	if (!a) return io.out.write(`${name}: exited (${loadIndex(name) ? "transcript kept, use result" : "unknown"})\n`);
	io.out.write(`${name}: ${a.agent_status} (pane ${a.pane_id})\n`);
}

async function sendCmd(argv, io) {
	requireParent();
	const { opts, rest } = parse(argv, { "follow-up": "bool" });
	const name = resolveName(rest.shift());
	const text = readPrompt(rest);
	if (!text) die('usage: send <name> [--follow-up] "<message>"|-');
	const a = getAgent(name);
	if (!a) die(`${name} is not running`);
	if (a.agent_status === "blocked") die(`${name} is blocked on an approval/question dialog; run 'peek ${name}' and ask the user`, 3);
	const safe = sanitizeText(text);
	if (opts["follow-up"] && a.agent_status === "working") {
		// pi queues alt+enter as a follow-up: delivered after the current run finishes.
		herdr(["pane", "send-text", a.pane_id, safe]);
		herdr(["pane", "send-keys", a.pane_id, "alt+enter"]);
		bumpSent(name);
		return io.out.write("Queued follow-up\n");
	}
	const r = herdr(["agent", "prompt", name, safe], { allowFail: true }); // idle -> new turn; working -> steer
	if (r.error) die(`send ${name}: ${r.error.code}: ${r.error.message}`, r.error.code === "agent_blocked" ? 3 : 1);
	bumpSent(name);
	if (a.agent_status !== "working") await untilActed(name, a.state_change_seq);
	io.out.write(a.agent_status === "working" ? "Steered\n" : "Prompted\n");
}

/** Read the pane until two consecutive reads agree (a dialog is drawn after the state flips). */
async function settledScreen(name, lines) {
	let prev = null;
	for (let i = 0; i < 8; i++) {
		const cur = herdr(["agent", "read", name, "--source", "visible", "--lines", String(lines)], { raw: true, allowFail: true });
		if (typeof cur !== "string") return "";
		if (cur === prev) return cur.replace(/\n{3,}/g, "\n\n");
		prev = cur;
		await sleep(400);
	}
	return (prev ?? "").replace(/\n{3,}/g, "\n\n");
}

const LOST_PROMPT_GRACE_MS = 30000;
// pi's security extension can remove an ask-dialog by itself (AI review takes up to 10 s). Only report
// BLOCKED to the caller if the dialog is still there after this grace period; no false alarms for the user.
const BLOCK_GRACE_MS = Number(process.env.HERDR_SUBAGENT_BLOCK_GRACE_MS ?? 12000);

async function stillBlocked(name) {
	const end = Date.now() + BLOCK_GRACE_MS;
	while (Date.now() < end) {
		const st = getAgent(name)?.agent_status;
		if (st !== "blocked") return false;
		await sleep(500);
	}
	return getAgent(name)?.agent_status === "blocked";
}

async function waitCmd(argv, io) {
	requireParent();
	const { opts, rest } = parse(argv, { timeout: "str" });
	const name = resolveName(rest[0]);
	const secs = positiveNumber(opts.timeout ?? DEFAULT_WAIT_S, "--timeout");
	if (!getAgent(name)) die(`${name} is not running (try 'result ${name}')`);
	const deadline = Date.now() + secs * 1000;
	let behindSince = null;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) die(`timed out after ${secs}s; ${name} is still running (not stopped)`, 124);
		const t0 = Date.now();
		const w = herdr(["agent", "wait", name, "--timeout", String(Math.max(500, Math.round(remaining)))], { allowFail: true });
		if (w.error) {
			if (w.error.code === "timeout") die(`timed out after ${secs}s; ${name} is still running (not stopped)`, 124);
			die(`wait ${name}: ${w.error.code}: ${w.error.message}`);
		}
		if (Date.now() - t0 > 2000) behindSince = null; // we really waited; earlier lag observations are stale
		const a = getAgent(name);
		if (!a) die(`${name} exited while waiting; try 'result ${name}'`);
		if (a.agent_status === "blocked") {
			if (!(await stillBlocked(name))) continue; // dialog resolved itself; wait again
			const screen = await settledScreen(name, 25);
			io.err.write(`${name} is BLOCKED (approval/question dialog). Ask the user; do not answer it yourself.\n${screen}\n`);
			throw new CliError("", 3);
		}
		if (a.agent_status !== "idle" && a.agent_status !== "done") die(`${name} settled in unexpected state "${a.agent_status}"`);

		// Herdr can report idle a beat before pi has recorded our latest prompt. Only trust the
		// transcript once it contains every prompt we sent and ends in an answer.
		const sent = loadIndex(name)?.sent ?? 0;
		const reply = readLatestReply(sessionOf(name));
		if (sent === 0 || (reply && !reply.pending && reply.users >= sent)) return emitReply(name, reply, io.out);
		behindSince ??= Date.now();
		if (Date.now() - behindSince > LOST_PROMPT_GRACE_MS)
			die(`${name} is idle but its transcript never recorded our latest prompt (sent ${sent}, recorded ${reply?.users ?? 0}); the prompt was probably lost. Send it again.`);
		await sleep(300);
	}
}

function resultCmd(argv, io) {
	requireParent();
	const name = resolveName(argv[0]);
	const a = getAgent(name);
	if (a && (a.agent_status === "working" || a.agent_status === "blocked"))
		io.err.write(`warning: ${name} is ${a.agent_status}; showing its last completed reply (use 'wait' to block until it finishes)\n`);
	const reply = readLatestReply(sessionOf(name));
	const sent = loadIndex(name)?.sent ?? 0;
	if (reply && !a && reply.users < sent) io.err.write(`warning: ${name} exited before recording ${sent - reply.users} prompt(s) we sent\n`);
	emitReply(name, reply, io.out);
}

function peekCmd(argv, io) {
	requireParent();
	const { opts, rest } = parse(argv, { lines: "str" });
	const name = resolveName(rest[0]);
	const lines = Math.floor(positiveNumber(opts.lines ?? 40, "--lines"));
	if (!getAgent(name)) die(`${name} is not running`);
	io.out.write(herdr(["agent", "read", name, "--source", "visible", "--lines", String(lines)], { raw: true }));
}

function stopCmd(argv, io) {
	requireParent();
	const name = resolveName(argv[0]);
	const a = getAgent(name);
	if (!a) return io.out.write(`${name} already gone\n`);
	herdr(["pane", "close", a.pane_id]);
	io.out.write(`Stopped ${name} (transcript kept: ${a.agent_session?.value ?? "n/a"})\n`);
}

const HELP = `herdr-subagent <command>
  spawn [--name n] [--tools a,b] [--model m] [--provider p] [--thinking t] [--cwd dir] [--tab label=${DEFAULT_TAB}] [--here] [--direction right|down] "<prompt>"|-
                          children open in their own "${DEFAULT_TAB}" tab (focus stays with you); --here splits beside the caller instead
  list
  status <name>
  send <name> [--follow-up] "<message>"|-
  wait <name> [--timeout seconds=${DEFAULT_WAIT_S}]     prints the last reply; exit 1 = child failed, 3 = blocked, 124 = timeout
  result <name>                                        last reply (works after the child exited)
  peek <name> [--lines N]                              visible pane text (diagnose blocked/stuck children)
  stop <name>                                          closes the pane; transcript is kept
Names get the "${PREFIX}" prefix automatically. Must run inside a Herdr pane (HERDR_ENV=1).
`;

const COMMANDS = { spawn: spawnCmd, list: listCmd, status: statusCmd, send: sendCmd, wait: waitCmd, result: resultCmd, peek: peekCmd, stop: stopCmd };

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
	const [cmd, ...args] = argv;
	try {
		if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") io.out.write(HELP);
		else if (Object.hasOwn(COMMANDS, cmd)) await COMMANDS[cmd](args, io);
		else die(`unknown command ${cmd}; try --help`, 2);
		return 0;
	} catch (e) {
		if (!(e instanceof CliError)) throw e;
		if (e.message) io.err.write(`herdr-subagent: ${e.message}\n`);
		return e.code;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
