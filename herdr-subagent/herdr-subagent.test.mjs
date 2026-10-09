// Integration + unit tests for herdr-subagent. Zero deps: node:test + the real herdr + real pi children.
// Run inside a Herdr pane:  node --test herdr-subagent/herdr-subagent.test.mjs
// Live tests use a cheap model (override with HS_TEST_MODEL) and always clean their panes up.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NAME_RE, parse, readLatestReply, resolveName, sanitizeText, trustArgs, CHILD_ENV_VARS, CliError } from "./herdr-subagent.mjs";

const CLI = fileURLToPath(new URL("./herdr-subagent.mjs", import.meta.url));
const LIVE = process.env.HERDR_ENV === "1" && !process.env.HERDR_SUBAGENT;
const MODEL = process.env.HS_TEST_MODEL || "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const STATE = mkdtempSync(join(tmpdir(), "hs-state-"));
const FIX = mkdtempSync(join(tmpdir(), "hs-fix-"));
const tok = () => "TOK" + randomBytes(4).toString("hex").toUpperCase();

function mkEnv(env = {}) {
	const e = { ...process.env, HERDR_SUBAGENT_STATE_DIR: STATE, HERDR_SUBAGENT_BLOCK_GRACE_MS: "1500" };
	for (const [k, v] of Object.entries(env)) v === null ? delete e[k] : (e[k] = v);
	return e;
}
function hs(args, { env, input, timeout = 150000 } = {}) {
	const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: mkEnv(env), input, timeout });
	return { code: r.status, out: r.stdout, err: r.stderr };
}
function hsAsync(args, { env } = {}) {
	return new Promise((res) => {
		const t0 = Date.now();
		const p = spawn("node", [CLI, ...args], { env: mkEnv(env) });
		let out = "", err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => res({ code, out, err, ms: Date.now() - t0 }));
	});
}
const herdr = (a) => spawnSync("herdr", a, { encoding: "utf8" });
const panes = () => new Set(JSON.parse(herdr(["pane", "list", "--workspace", process.env.HERDR_WORKSPACE_ID]).stdout).result.panes.map((p) => p.pane_id));
const tabs = () => JSON.parse(herdr(["tab", "list", "--workspace", process.env.HERDR_WORKSPACE_ID]).stdout).result.tabs;
const tabOfPane = (pane) => JSON.parse(herdr(["pane", "get", pane]).stdout).result.pane.tab_id;
const agentOf = (n) => { const r = JSON.parse(herdr(["agent", "get", n]).stdout || herdr(["agent", "get", n]).stderr); return r.result?.agent ?? null; };
const sessionOf = (name) => JSON.parse(readFileSync(join(STATE, `${name}.json`), "utf8")).sessionFile;
const transcript = (name) => readFileSync(sessionOf(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const flat = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text ?? x.type).join("") : "");
const userTexts = (name) => transcript(name).filter((e) => e.message?.role === "user").map((e) => flat(e.message.content));
const BASE = ["--model", MODEL, "--thinking", "off"];
const created = new Set();
const full = (n) => (n.startsWith("sa-") ? n : "sa-" + n);
function spawnChild(tag, prompt, extra = ["--tools", "read"]) {
	const name = `xt${tag}`;
	created.add(full(name));
	const r = hs(["spawn", "--name", name, ...BASE, ...extra, prompt]);
	assert.equal(r.code, 0, `spawn failed: ${r.err}`);
	return full(name);
}
const stopQuiet = (n) => hs(["stop", n]);
const say = (t) => `Reply with exactly this token and nothing else: ${t}`;

let initialPanes, initialTabs;
before(() => { if (LIVE) { initialPanes = panes(); initialTabs = tabs().map((x) => x.tab_id).sort(); } });
// A failing test must never leave children behind to poison the next test.
afterEach(() => {
	if (!LIVE) return;
	for (const n of created) stopQuiet(n);
	for (const a of JSON.parse(herdr(["agent", "list"]).stdout).result.agents ?? []) if (a.name?.startsWith("sa-xt")) herdr(["pane", "close", a.pane_id]);
	created.clear();
});
after(() => {
	if (LIVE) {
		for (const n of created) stopQuiet(n);
		for (const a of JSON.parse(herdr(["agent", "list"]).stdout).result.agents ?? []) if (a.name?.startsWith("sa-xt")) herdr(["pane", "close", a.pane_id]);
	}
	for (const dir of [STATE, FIX]) { for (const f of readdirSync(dir)) unlinkSync(join(dir, f)); rmdirSync(dir); }
});

// ============================ UNIT ============================
describe("unit: resolveName", () => {
	test("adds prefix, keeps existing prefix", () => {
		assert.equal(resolveName("t1"), "sa-t1");
		assert.equal(resolveName("sa-t1"), "sa-t1");
		assert.equal(resolveName("1a"), "sa-1a"); // prefix makes a leading digit legal
	});
	test("length boundary: 32 ok, 33 rejected", () => {
		assert.equal(resolveName("a".repeat(29)).length, 32);
		assert.throws(() => resolveName("a".repeat(30)), CliError);
	});
	for (const bad of [undefined, "", "T1", "a b", "../x", "x/y", "a.b", "a\nb", "--flag", "é", "sa-", "x;rm"]) {
		test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => resolveName(bad), CliError));
	}
	test("every accepted name satisfies herdr's name regex", () => {
		for (const n of ["a", "a-b_c9", "x".repeat(29)]) assert.match(resolveName(n), NAME_RE);
	});
});

describe("unit: sanitizeText", () => {
	for (const t of ["/quit", "/reload", "!rm x", "!echo hi", "-x", "--foo", "- item"]) test(`neutralises ${JSON.stringify(t)}`, () => assert.ok(sanitizeText(t).startsWith("Task: ")));
	for (const t of ["hello", "a/b", "say !", "x - y", "ünïcode", "multi\nline"]) test(`leaves ${JSON.stringify(t)}`, () => assert.equal(sanitizeText(t), t));
});

describe("unit: parse", () => {
	const spec = { name: "str", flag: "bool" };
	test("options and rest", () => assert.deepEqual(parse(["--name", "x", "--flag", "a", "b"], spec), { opts: { name: "x", flag: true }, rest: ["a", "b"] }));
	test("-- ends options", () => assert.deepEqual(parse(["--", "--name", "x"], spec).rest, ["--name", "x"]));
	test("lone dash is text (stdin marker)", () => assert.deepEqual(parse(["-"], spec).rest, ["-"]));
	test("unknown option", () => assert.throws(() => parse(["--nope"], spec), /unknown option/));
	test("missing value", () => assert.throws(() => parse(["--name"], spec), /needs a value/));
	test("prototype keys are not options", () => { for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.throws(() => parse([`--${k}`, "x"], spec), /unknown option/); });
	test("empty", () => assert.deepEqual(parse([], spec), { opts: {}, rest: [] }));
});

describe("unit: trustArgs (never let the prompt's Enter answer a trust dialog)", () => {
	const tf = join(FIX, "trust.json");
	const write = (o) => writeFileSync(tf, JSON.stringify(o));
	test("no file / garbage file / unknown dir -> --no-approve", () => {
		assert.deepEqual(trustArgs("/tmp", join(FIX, "missing.json")), ["--no-approve"]);
		writeFileSync(tf, "{not json"); assert.deepEqual(trustArgs("/tmp", tf), ["--no-approve"]);
		write({}); assert.deepEqual(trustArgs("/tmp", tf), ["--no-approve"]);
	});
	test("trusted dir or trusted ancestor -> no flag; closest decision wins", () => {
		write({ "/a": true }); assert.deepEqual(trustArgs("/a", tf), []);
		write({ "/a": true }); assert.deepEqual(trustArgs("/a", tf), []);
		write({ "/": true, "/a/b": false }); assert.deepEqual(trustArgs("/a/b/c", tf), ["--no-approve"]);
		write({ "/a": false, "/a/b": true }); assert.deepEqual(trustArgs("/a/b", tf), []);
	});
	test("a saved 'false' is never treated as trust; non-boolean truthy values are not trust", () => {
		write({ "/a": false }); assert.deepEqual(trustArgs("/a", tf), ["--no-approve"]);
		write({ "/a": "yes" }); assert.deepEqual(trustArgs("/a", tf), ["--no-approve"]);
	});
	test("symlinked cwd resolves to the real path before lookup", () => {
		const real = mkdtempSync(join(tmpdir(), "hs-real-")); const link = join(FIX, "lnk");
		symlinkSync(real, link);
		write({ [realpathSync(real)]: true }); assert.deepEqual(trustArgs(link, tf), []);
		unlinkSync(link); rmdirSync(real);
	});
	test("children always get the update-check skip and the nesting marker", () => {
		assert.ok(CHILD_ENV_VARS.includes("PI_SKIP_VERSION_CHECK=1")); assert.ok(CHILD_ENV_VARS.includes("HERDR_SUBAGENT=1"));
	});
});

describe("unit: readLatestReply", () => {
	const wr = (name, lines) => { const p = join(FIX, name); writeFileSync(p, lines.join("\n")); return p; };
	const m = (role, content, extra = {}) => JSON.stringify({ type: "message", message: { role, content, ...extra } });
	const T = (text) => [{ type: "text", text }];
	test("missing / empty / no assistant", () => {
		assert.equal(readLatestReply(null), null);
		assert.equal(readLatestReply(join(FIX, "nope.jsonl")), null);
		assert.equal(readLatestReply(wr("empty.jsonl", [])), null);
		assert.equal(readLatestReply(wr("u.jsonl", [m("user", T("hi"))])), null);
	});
	test("last assistant text wins; multi blocks joined; non-text ignored", () => {
		const p = wr("a.jsonl", [m("user", T("q")), m("assistant", T("old")), m("user", T("q2")), m("assistant", [...T("A"), { type: "toolCall", name: "bash" }, ...T("B")])]);
		const r = readLatestReply(p);
		assert.equal(r.text, "AB"); assert.equal(r.pending, false);
	});
	test("tolerates partially written final line and garbage lines", () => {
		const p = wr("p.jsonl", ["not json", m("assistant", T("ok")), '{"type":"message","message":{"role":"assis']);
		assert.equal(readLatestReply(p).text, "ok");
	});
	test("pending when a user message follows the last assistant message", () => {
		const p = wr("pend.jsonl", [m("assistant", T("old")), m("user", T("new"))]);
		assert.equal(readLatestReply(p).pending, true);
	});
	test("toolResult / bashExecution / session entries are skipped", () => {
		const p = wr("mix.jsonl", [JSON.stringify({ type: "session" }), m("assistant", T("done")), m("toolResult", T("x")), JSON.stringify({ type: "message", message: { role: "bashExecution" } })]);
		const r = readLatestReply(p);
		assert.equal(r.text, "done"); assert.equal(r.pending, false);
	});
	test("error stopReason + tool-only reply surface their metadata", () => {
		const e = readLatestReply(wr("err.jsonl", [m("assistant", [], { stopReason: "error", errorMessage: "boom" })]));
		assert.equal(e.stopReason, "error"); assert.equal(e.errorMessage, "boom"); assert.equal(e.text, "");
	});
	test("counts user messages; toolUse stopReason is surfaced", () => {
		const r = readLatestReply(wr("cnt.jsonl", [m("user", T("1")), m("assistant", T("a")), m("user", T("2")), m("assistant", [], { stopReason: "toolUse" })]));
		assert.equal(r.users, 2); assert.equal(r.stopReason, "toolUse"); assert.equal(r.pending, false);
	});
	test("non-array content does not crash", () => assert.equal(readLatestReply(wr("str.jsonl", [m("assistant", "plain")])).text, ""));
});

// ============================ CLI without herdr ============================
describe("cli: outside herdr / argument handling", () => {
	test("help works anywhere; unknown command exit 2", () => {
		assert.equal(hs(["--help"], { env: { HERDR_ENV: null } }).code, 0);
		assert.equal(hs([], { env: { HERDR_ENV: null } }).code, 0);
		const u = hs(["bogus"], { env: { HERDR_ENV: null } });
		assert.equal(u.code, 2); assert.match(u.err, /unknown command/);
	});
	for (const c of ["spawn x", "list", "status x", "send x y", "wait x", "result x", "peek x", "stop x"]) {
		test(`'${c}' refuses outside herdr and touches nothing`, () => {
			const r = hs(c.split(" "), { env: { HERDR_ENV: null } });
			assert.equal(r.code, 1); assert.match(r.err, /not inside a Herdr pane/);
		});
	}
	test("HERDR_ENV=0 also refused", () => assert.equal(hs(["list"], { env: { HERDR_ENV: "0" } }).code, 1));
});

// ============================ LIVE: validation (no children started) ============================
describe("live: validation errors leave no panes behind", { skip: !LIVE && "not inside herdr" }, () => {
	const cases = [
		["spawn without prompt", ["spawn"], /usage: spawn/],
		["spawn invalid name", ["spawn", "--name", "Bad Name", "x"], /invalid name/],
		["spawn traversal name", ["spawn", "--name", "../../etc/x", "x"], /invalid name/],
		["spawn bad direction", ["spawn", "--direction", "up", "x"], /--direction/],
		["spawn bad cwd", ["spawn", "--cwd", "/definitely/not/here", "x"], /not a directory/],
		["spawn cwd is a file", ["spawn", "--cwd", CLI, "x"], /not a directory/],
		["spawn unknown option", ["spawn", "--wat", "x"], /unknown option/],
		["spawn option without value", ["spawn", "--tools"], /needs a value/],
		["send without text", ["send", "nobody"], /usage: send/],
		["send to missing agent", ["send", "nobody", "hi"], /not running/],
		["wait missing agent", ["wait", "nobody", "--timeout", "1"], /not running/],
		["wait bad timeout (text)", ["wait", "nobody", "--timeout", "abc"], /positive number/],
		["wait bad timeout (zero)", ["wait", "nobody", "--timeout", "0"], /positive number/],
		["wait bad timeout (negative)", ["wait", "nobody", "--timeout", "-5"], /positive number/],
		["peek missing agent", ["peek", "nobody"], /not running/],
		["peek bad lines", ["peek", "nobody", "--lines", "x"], /positive number/],
		["result unknown agent", ["result", "nobody"], /no assistant message/],
		["status without name", ["status"], /missing <name>/],
		["traversal in status", ["status", "../../x"], /invalid name/],
		["traversal in result", ["result", "../../../etc/passwd"], /invalid name/],
	];
	for (const [label, args, re] of cases) {
		test(label, () => {
			const before = panes();
			const r = hs(args);
			assert.notEqual(r.code, 0, `expected failure, got stdout: ${r.out}`);
			assert.match(r.err, re);
			assert.deepEqual([...panes()].sort(), [...before].sort(), "pane leaked");
		});
	}
	test("spawn without provider/model env is a clear error, no pane", () => {
		const before = panes();
		const r = hs(["spawn", "x"], { env: { PI_PROVIDER: null, PI_MODEL: null } });
		assert.equal(r.code, 1); assert.match(r.err, /no provider\/model/);
		assert.deepEqual([...panes()].sort(), [...before].sort());
	});
	test("nested spawn refused", () => {
		const r = hs(["spawn", "x"], { env: { HERDR_SUBAGENT: "1" } });
		assert.equal(r.code, 1); assert.match(r.err, /nested subagents are disabled/);
	});
	test("status/stop of unknown agent are graceful", () => {
		assert.match(hs(["status", "nobody"]).out, /exited \(unknown\)/);
		const s = hs(["stop", "nobody"]); assert.equal(s.code, 0); assert.match(s.out, /already gone/);
	});
	test("list works with no subagents of ours", () => assert.equal(hs(["list"]).code, 0));
	test("result from a saved index of an exited agent: ok / error / pending / none", () => {
		const idx = (n, lines) => {
			const sf = join(FIX, `${n}.jsonl`); writeFileSync(sf, lines.join("\n"));
			writeFileSync(join(STATE, `sa-${n}.json`), JSON.stringify({ sessionFile: sf }));
		};
		const m = (role, content, extra = {}) => JSON.stringify({ type: "message", message: { role, content, ...extra } });
		idx("fx-ok", [m("user", [{ type: "text", text: "q" }]), m("assistant", [{ type: "text", text: "ANSWER" }])]);
		idx("fx-err", [m("assistant", [], { stopReason: "error", errorMessage: "model exploded" })]);
		idx("fx-abort", [m("assistant", [{ type: "text", text: "half" }], { stopReason: "aborted" })]);
		idx("fx-pend", [m("assistant", [{ type: "text", text: "old" }]), m("user", [{ type: "text", text: "new" }])]);
		idx("fx-none", [m("user", [{ type: "text", text: "q" }])]);
		idx("fx-tool", [m("assistant", [{ type: "toolCall", name: "bash" }], { stopReason: "toolUse" })]);
		assert.deepEqual([hs(["result", "fx-ok"]).code, hs(["result", "fx-ok"]).out.trim()], [0, "ANSWER"]);
		const e = hs(["result", "fx-err"]); assert.equal(e.code, 1); assert.match(e.err, /model exploded/);
		const a = hs(["result", "fx-abort"]); assert.equal(a.code, 1); assert.match(a.err, /aborted/);
		const p = hs(["result", "fx-pend"]); assert.equal(p.code, 1); assert.match(p.err, /not answered/);
		assert.equal(hs(["result", "fx-none"]).code, 1);
		const t = hs(["result", "fx-tool"]); assert.equal(t.code, 1); assert.match(t.err, /ended mid-task/);
	});
});

describe("live: extension / user-feedback interference", { skip: !LIVE && "not inside herdr" }, () => {
	const TRUST = join(process.env.HOME, ".pi", "agent", "trust.json");

	test("untrusted folder with project-local .pi: no trust dialog, nothing trusted behind our back, child works", () => {
		const dir = mkdtempSync(join(tmpdir(), "hs-untrusted-"));
		mkdirSync(join(dir, ".pi")); writeFileSync(join(dir, ".pi", "settings.json"), "{}");
		const before = readFileSync(TRUST, "utf8");
		const t = tok();
		const name = "xttrust"; created.add(full(name));
		const s = hs(["spawn", "--name", name, ...BASE, "--tools", "read", "--cwd", dir, say(t)]);
		assert.equal(s.code, 0, s.err);
		const w = hs(["wait", name, "--timeout", "90"]);
		assert.equal(w.code, 0, `child stuck (trust dialog swallowed the prompt?): ${w.err}`);
		assert.ok(w.out.includes(t), w.out);
		assert.equal(readFileSync(TRUST, "utf8"), before, "trust.json was modified: the prompt's Enter answered a trust dialog");
		stopQuiet(name);
		unlinkSync(join(dir, ".pi", "settings.json")); rmdirSync(join(dir, ".pi")); rmdirSync(dir);
	});

	test("child environment: update-check skipped, nesting marker set", () => {
		const n = spawnChild("env", "Run this bash command and paste its output verbatim: echo SKIP=$PI_SKIP_VERSION_CHECK CHILD=$HERDR_SUBAGENT", ["--tools", "bash"]);
		const w = hs(["wait", n, "--timeout", "120"]);
		assert.equal(w.code, 0, w.err); assert.match(w.out, /SKIP=1/); assert.match(w.out, /CHILD=1/);
		stopQuiet(n);
	});

	test("security 'ask' dialog: exit 3, send refused, human approves -> child resumes; human denies -> child continues, never hangs", () => {
		for (const [verdict, key] of [["approve", "enter"], ["deny", "escape"]]) {
			const n = spawnChild(`ask${verdict}`, "Run exactly this bash command and report its output: git push --dry-run origin nonexistent-branch-xyz", ["--tools", "bash"]);
			let w = hs(["wait", n, "--timeout", "90"]);
			assert.equal(w.code, 3, `${verdict}: ${w.out}${w.err}`);
			const sendWhileBlocked = hs(["send", n, "go ahead"]);
			assert.equal(sendWhileBlocked.code, 3, "send must refuse: its Enter would approve the dialog");
			assert.equal(userTexts(n).length, 1, "a message leaked into the blocked child");
			// the human acts (here: the test plays the human):
			herdr(["agent", "send-keys", n, key]);
			for (let i = 0; i < 4; i++) { // the model may retry and raise a second dialog; the human answers it the same way
				w = hs(["wait", n, "--timeout", "90"]);
				if (w.code !== 3) break;
				herdr(["agent", "send-keys", n, key]);
			}
			assert.equal(w.code, 0, `${verdict}: child did not recover: ${w.out}${w.err}`);
			const results = transcript(n).filter((e) => e.message?.role === "toolResult");
			assert.ok(results.length >= 1, `${verdict}: no tool result recorded`);
			if (verdict === "deny") assert.ok(!results.some((e) => /Everything up-to-date|error: src refspec/.test(flat(e.message.content))), "denied command still ran");
			stopQuiet(n);
		}
	});

	test("a dialog nobody answers resolves by itself (30s fuse): audit log and tool result always agree, nothing hangs", () => {
		const n = spawnChild("expire", "Run exactly this bash command and report its output: git push --dry-run origin nonexistent-branch-xyz", ["--tools", "bash"]);
		const first = hs(["wait", n, "--timeout", "60"]);
		assert.ok([0, 3].includes(first.code), `${first.code}: ${first.out}${first.err}`);
		spawnSync("sleep", ["38"]); // the dialog's own 30s timeout fires if nobody answered
		const entries = transcript(n);
		const audit = entries.filter((e) => e.customType === "security-log").map((e) => e.data?.action);
		const results = entries.filter((e) => e.message?.role === "toolResult").map((e) => flat(e.message.content));
		const blockedResults = results.filter((r) => /BLOCKED by security/.test(r)).length;
		const ranResults = results.filter((r) => /src refspec|Everything up-to-date/.test(r) && !/BLOCKED by security/.test(r)).length;
		const approvals = audit.filter((a) => /approved/.test(a)).length;
		const denials = audit.filter((a) => a === "expired" || a === "blocked_by_user").length;
		// The model may retry after a denial, so compare per call: every execution needs a recorded approval,
		// every block needs a recorded denial. (A silent run or an unrecorded block would be a real hole.)
		assert.ok(ranResults <= approvals, `${ranResults} command run(s) but only ${approvals} approval(s): ${JSON.stringify(audit)}`);
		assert.ok(blockedResults <= denials, `${blockedResults} block(s) but only ${denials} denial(s): ${JSON.stringify(audit)}`);
		const w = hs(["wait", n, "--timeout", "90"]);
		assert.ok([0, 3].includes(w.code), `unexpected wait result ${w.code}: ${w.out}${w.err}`);
	});

	test("a stray Enter-bearing message can't answer a dialog: status stays blocked after refused sends", () => {
		const n = spawnChild("noenter", "Run exactly this bash command and report its output: git push --dry-run origin nonexistent-branch-xyz", ["--tools", "bash"]);
		assert.equal(hs(["wait", n, "--timeout", "90"]).code, 3);
		for (const args of [["send", n, "yes"], ["send", n, "--follow-up", "yes"], ["send", n, "y"]]) assert.equal(hs(args).code, 3);
		assert.equal(agentOf(n).agent_status, "blocked", "dialog was answered by a CLI message");
		assert.match(hs(["peek", n, "--lines", "30"]).out, /Allow this command/);
		stopQuiet(n);
	});

	test("fresh child has no startup dialog: peek shows an input prompt, not a select/confirm", () => {
		const name = "xtclean"; created.add(full(name));
		assert.equal(hs(["spawn", "--name", name, ...BASE, "--no-prompt"]).code, 0);
		const screen = hs(["peek", name, "--lines", "60"]).out;
		assert.doesNotMatch(screen, /Update available|Update and restart|Trust|trust this|↑↓ navigate/i, screen.slice(-600));
		stopQuiet(name);
	});
});

// ============================ LIVE: real children ============================
describe("live: lifecycle with real pi children", { skip: !LIVE && "not inside herdr" }, () => {
	test("spawn -> list -> wait -> status -> stop -> result after exit; files private", () => {
		const t = tok();
		const n = spawnChild("life", say(t));
		assert.match(hs(["list"]).out, /sa-xtlife\t(working|idle|done)\t/);
		const w = hs(["wait", n, "--timeout", "120"]);
		assert.equal(w.code, 0, w.err); assert.ok(w.out.includes(t), w.out);
		assert.match(hs(["status", "xtlife"]).out, /sa-xtlife: (idle|done)/); // name without prefix works
		const pane = agentOf(n).pane_id;
		const s = hs(["stop", n]); assert.equal(s.code, 0); assert.match(s.out, /transcript kept/);
		assert.equal(agentOf(n), null); assert.ok(!panes().has(pane), "pane still open after stop");
		const r = hs(["result", n]); assert.equal(r.code, 0); assert.ok(r.out.includes(t));
		assert.match(hs(["status", n]).out, /exited \(transcript kept/);
		assert.equal(statSync(join(STATE, `${n}.json`)).mode & 0o777, 0o600);
		assert.equal(statSync(STATE).mode & 0o777 & 0o077, 0, "state dir must not be group/world accessible");
		assert.equal(hs(["stop", n]).out.includes("already gone"), true, "second stop is idempotent");
	});

	test("duplicate name rejected; original child untouched; prefix not doubled", () => {
		const t = tok();
		const n = spawnChild("dup", say(t));
		const before = panes();
		const d = hs(["spawn", "--name", "sa-xtdup", ...BASE, "other"]);
		assert.equal(d.code, 1); assert.match(d.err, /already exists/);
		assert.deepEqual([...panes()].sort(), [...before].sort());
		assert.equal(n, "sa-xtdup");
		assert.ok(hs(["wait", n, "--timeout", "120"]).out.includes(t));
		stopQuiet(n);
	});

	test("prompt via stdin '-' ; multi-line + unicode + quotes + shell metacharacters arrive intact", () => {
		const t = tok();
		const text = `Line1 "double" 'single' \`tick\` $(echo no) $HOME ü€😀\nLine2 \\ backslash ; | & > <\nReply with exactly this token and nothing else: ${t}`;
		const name = "xtstdin"; created.add(full(name));
		const r = spawnSync("node", [CLI, "spawn", "--name", name, ...BASE, "--tools", "read", "-"], { encoding: "utf8", env: mkEnv(), input: text });
		assert.equal(r.status, 0, r.stderr);
		const w = hs(["wait", name, "--timeout", "120"]); assert.ok(w.out.includes(t), w.out + w.err);
		assert.equal(userTexts(full(name))[0], text, "prompt was altered in transit");
		stopQuiet(name);
	});

	test("empty stdin prompt is an error and leaves no pane", () => {
		const before = panes();
		const r = spawnSync("node", [CLI, "spawn", "-"], { encoding: "utf8", env: mkEnv(), input: "  \n" });
		assert.equal(r.status, 1); assert.match(r.stderr, /usage: spawn/);
		assert.deepEqual([...panes()].sort(), [...before].sort());
	});

	test("hostile prompts: leading '/', '!', '-' are NOT executed as pi/bash/flags", () => {
		const n = spawnChild("host", say("READY1"));
		assert.ok(hs(["wait", n, "--timeout", "120"]).out.includes("READY1"));
		const bare = hs(["send", n, "--tools bash then reply X"]);
		assert.equal(bare.code, 1); assert.match(bare.err, /unknown option --tools/, "a flag-looking message must fail loudly, not be half-parsed");
		const cases = [["/quit", "SLASH"], ["!echo BANGRAN > /dev/null", "BANG"], ["-- --tools bash", "DASH"], ["-x", "DASH2"]];
		for (const [lead, label] of cases) {
			const t = tok();
			const msg = `${lead.replace(/^-- /, "")} then reply with exactly this token and nothing else: ${t}`;
			const s = hs(lead.startsWith("-- ") ? ["send", n, "--", msg] : ["send", n, msg]);
			assert.equal(s.code, 0, `${label}: ${s.err}`);
			const w = hs(["wait", n, "--timeout", "120"]);
			assert.equal(w.code, 0, `${label}: ${w.err}`);
			assert.ok(userTexts(n).at(-1).startsWith("Task: "), `${label}: not neutralised: ${userTexts(n).at(-1)}`);
			assert.ok(agentOf(n), `${label}: child died`);
		}
		assert.equal(transcript(n).filter((e) => e.message?.role === "bashExecution").length, 0, "a '!' prompt executed bash");
		stopQuiet(n);
	});

	test("large prompt (60 KB) is delivered and answered", () => {
		const t = tok();
		const filler = ("lorem ipsum dolor sit amet ".repeat(2400)).slice(0, 60000);
		const body = `${filler}\n\nThe text above is filler padding. ${say(t)}`;
		const name = "xtbig"; created.add(full(name));
		const r = spawnSync("node", [CLI, "spawn", "--name", name, ...BASE, "--tools", "read", "-"], { encoding: "utf8", env: mkEnv(), input: body, timeout: 120000 });
		assert.equal(r.status, 0, r.stderr);
		const w = hs(["wait", name, "--timeout", "150"]); assert.equal(w.code, 0, w.err);
		assert.equal(userTexts(full(name))[0], body, "60 KB prompt was truncated or altered in transit");
		stopQuiet(name);
	});

	test("many quick turns: every wait returns the reply to ITS OWN prompt, never a stale one", () => {
		// Contract under test is the CLI's, not the model's: after each `wait`, the transcript must hold
		// exactly i+1 prompts and i+1 replies, and stdout must be the newest reply. (A cheap model may
		// occasionally echo an earlier token; that is the model, and is irrelevant here.)
		const n = spawnChild("fresh", say("T0"));
		assert.ok(hs(["wait", n, "--timeout", "120"]).out.includes("T0"));
		const text = (e) => flat(e.message.content);
		for (let i = 1; i <= 8; i++) {
			const t = tok();
			const s = hs(["send", n, say(t)]); assert.equal(s.code, 0, s.err); assert.match(s.out, /Prompted/);
			const w = hs(["wait", n, "--timeout", "120"]);
			assert.equal(w.code, 0, w.err);
			const msgs = transcript(n).filter((e) => e.message && ["user", "assistant"].includes(e.message.role));
			const users = msgs.filter((e) => e.message.role === "user"), asst = msgs.filter((e) => e.message.role === "assistant");
			assert.equal(users.length, i + 1, `turn ${i}: wait returned before the prompt was recorded`);
			assert.equal(asst.length, i + 1, `turn ${i}: wait returned before the reply was recorded`);
			assert.equal(msgs.at(-1).message.role, "assistant");
			assert.equal(text(users.at(-1)), say(t), `turn ${i}: latest prompt mismatch`);
			assert.equal(w.out.trim(), text(asst.at(-1)).trim(), `turn ${i}: stdout is not the newest reply (stale read)`);
		}
		stopQuiet(n);
	});

	test("transcript lagging behind what we sent: wait refuses to return the old reply (times out instead)", () => {
		const t = tok();
		const n = spawnChild("lag", say(t));
		assert.ok(hs(["wait", n, "--timeout", "120"]).out.includes(t));
		const file = join(STATE, `${n}.json`);
		const idx = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...idx, sent: idx.sent + 1 })); // pretend a prompt was sent but never recorded
		const w = hs(["wait", n, "--timeout", "4"]);
		assert.equal(w.code, 124, `must not return the stale reply; got ${w.code}: ${w.out}${w.err}`);
		assert.equal(w.out, "");
		writeFileSync(file, JSON.stringify(idx)); // consistent again -> returns
		assert.equal(hs(["wait", n, "--timeout", "30"]).code, 0);
		stopQuiet(n);
	});

	test("steer and follow-up (single + multi-line) are delivered in order", () => {
		const n = spawnChild("steer", "Run the bash command `sleep 14`, then reply with exactly: FIRST", ["--tools", "bash"]);
		for (let i = 0; i < 40 && agentOf(n)?.agent_status !== "working"; i++) spawnSync("sleep", ["0.5"]);
		spawnSync("sleep", ["3"]);
		const st = hs(["send", n, "STEER: forget the sleep, reply with exactly: SECOND"]); assert.match(st.out, /Steered/, st.err);
		const fu = hs(["send", n, "--follow-up", "FU line A\nFU line B\nthen reply with exactly: THIRD"]); assert.match(fu.out, /Queued follow-up/, fu.err);
		const w = hs(["wait", n, "--timeout", "150"]); assert.equal(w.code, 0, w.err);
		const u = userTexts(n);
		assert.ok(u.some((x) => x.startsWith("STEER:")), "steer missing");
		assert.ok(u.includes("FU line A\nFU line B\nthen reply with exactly: THIRD"), `multi-line follow-up not delivered as one message: ${JSON.stringify(u)}`);
		assert.ok(w.out.includes("THIRD"), `final reply should be the follow-up's: ${w.out}`);
		stopQuiet(n);
	});

	test("--follow-up on an idle child behaves like a normal prompt", () => {
		const n = spawnChild("fuidle", say("A1"));
		hs(["wait", n, "--timeout", "120"]);
		const t = tok();
		const s = hs(["send", n, "--follow-up", say(t)]); assert.match(s.out, /Prompted/, s.err);
		assert.ok(hs(["wait", n, "--timeout", "120"]).out.includes(t));
		stopQuiet(n);
	});

	test("wait --timeout: exit 124, child keeps running, can still be waited on afterwards", async () => {
		const n = spawnChild("slow", "Run the bash command `sleep 25`, then reply with exactly: SLOWDONE", ["--tools", "bash"]);
		const r = await hsAsync(["wait", n, "--timeout", "3"]);
		assert.equal(r.code, 124, r.err); assert.match(r.err, /still running/);
		assert.ok(r.ms < 15000, `timeout took ${r.ms}ms`);
		assert.equal(agentOf(n)?.agent_status, "working", "timeout must not stop the child");
		const w = hs(["wait", n, "--timeout", "120"]); assert.equal(w.code, 0, w.err); assert.ok(w.out.includes("SLOWDONE"));
		stopQuiet(n);
	});

	test("pane closed by someone else while waiting: wait fails fast, not hangs", async () => {
		const n = spawnChild("kill", "Run the bash command `sleep 60`, then reply DONE", ["--tools", "bash"]);
		const pane = agentOf(n).pane_id;
		const waiting = hsAsync(["wait", n, "--timeout", "120"]);
		await new Promise((r) => setTimeout(r, 4000));
		herdr(["pane", "close", pane]);
		const r = await waiting;
		assert.notEqual(r.code, 0); assert.ok(r.ms < 30000, `hung ${r.ms}ms`); assert.match(r.err, /herdr-subagent:/);
		assert.equal(hs(["status", n]).out.includes("exited"), true);
		const res = hs(["result", n]); assert.equal(res.code, 1, "interrupted run must not look like a valid result");
	});

	test("stop while working: pane gone, result reports the run never answered", () => {
		const n = spawnChild("stopw", "Run the bash command `sleep 60`, then reply DONE", ["--tools", "bash"]);
		for (let i = 0; i < 30 && agentOf(n)?.agent_status !== "working"; i++) spawnSync("sleep", ["0.5"]);
		assert.equal(hs(["stop", n]).code, 0);
		assert.equal(agentOf(n), null);
		assert.equal(hs(["result", n]).code, 1);
	});

	test("model failure is an error (exit 1), not a successful answer", () => {
		const name = "xtbadm"; created.add(full(name));
		const s = hs(["spawn", "--name", name, "--model", "no-such-model-xyz", "--thinking", "off", "hello"]);
		assert.equal(s.code, 0, s.err);
		const w = hs(["wait", name, "--timeout", "60"]);
		assert.equal(w.code, 1, `wait must fail; got code ${w.code} out ${w.out}`); assert.match(w.err, /failed \(error\)/);
		const r = hs(["result", name]); assert.equal(r.code, 1);
		stopQuiet(name);
	});

	test("blocked on an approval dialog: wait exit 3 with dialog text; send refused; status/peek/result sane; no hang", () => {
		const n = spawnChild("blk", "Run the bash command `git push --dry-run origin nonexistent-branch-xyz` and report the output.", ["--tools", "bash"]);
		const w = hs(["wait", n, "--timeout", "90"]);
		assert.equal(w.code, 3, `wait: ${w.out}${w.err}`); assert.match(w.err, /BLOCKED/); assert.match(w.err, /Allow this command/);
		assert.match(hs(["status", n]).out, /blocked/);
		const s = hs(["send", n, "yes do it"]); assert.equal(s.code, 3); assert.match(s.err, /blocked/);
		assert.match(hs(["peek", n, "--lines", "30"]).out, /Allow this command/);
		const r = hs(["result", n]); assert.match(r.err, /warning: .*blocked/);
		assert.ok(agentOf(n), "child must still be alive and blocked; the CLI never answers dialogs");
		assert.equal(agentOf(n).agent_status, "blocked");
		stopQuiet(n);
	});

	test("--no-prompt child: idle; wait/result say nothing answered; first send works", () => {
		const name = "xtnop"; created.add(full(name));
		assert.equal(hs(["spawn", "--name", name, ...BASE, "--no-prompt"]).code, 0);
		assert.match(hs(["status", name]).out, /idle/);
		assert.equal(hs(["wait", name, "--timeout", "30"]).code, 1);
		assert.equal(hs(["result", name]).code, 1);
		const t = tok();
		assert.equal(hs(["send", name, say(t)]).code, 0);
		assert.ok(hs(["wait", name, "--timeout", "120"]).out.includes(t));
		stopQuiet(name);
	});

	test("--cwd (absolute and relative) is honoured", () => {
		const dir = mkdtempSync(join(tmpdir(), "hs-cwd-"));
		const name = "xtcwd"; created.add(full(name));
		const r = hs(["spawn", "--name", name, ...BASE, "--tools", "read", "--cwd", dir, say("CWDOK")]);
		assert.equal(r.code, 0, r.err);
		const real = herdr(["agent", "get", full(name)]).stdout && agentOf(full(name)).cwd;
		assert.ok(real.endsWith(dir.split("/").pop()), `cwd ${real} vs ${dir}`);
		hs(["wait", name, "--timeout", "120"]); stopQuiet(name);
		const name2 = "xtcwd2"; created.add(full(name2));
		const r2 = spawnSync("node", [CLI, "spawn", "--name", name2, ...BASE, "--tools", "read", "--cwd", ".", say("CWD2")], { encoding: "utf8", env: mkEnv(), cwd: dir });
		assert.equal(r2.status, 0, r2.stderr);
		assert.ok(agentOf(full(name2)).cwd.endsWith(dir.split("/").pop()));
		hs(["wait", name2, "--timeout", "120"]); stopQuiet(name2);
		rmdirSync(dir);
	});

	test("unknown tool name does not leak a pane or hang", () => {
		const before = panes();
		const name = "xttool"; created.add(full(name));
		const r = hs(["spawn", "--name", name, ...BASE, "--tools", "definitely_not_a_tool", say("TOOLX")]);
		if (r.code === 0) { hs(["wait", name, "--timeout", "90"]); stopQuiet(name); }
		else assert.match(r.err, /herdr-subagent:/);
		assert.deepEqual([...panes()].sort(), [...before].sort(), "pane leaked");
	});

	test("a real child cannot spawn grandchildren (env var reaches the child's shell)", () => {
		const n = spawnChild("nest", "Run exactly this bash command and paste its full output: `echo NEST=$HERDR_SUBAGENT; herdr-subagent spawn --name grand 'hi' 2>&1; echo EXIT=$?`", ["--tools", "bash"]);
		const w = hs(["wait", n, "--timeout", "120"]);
		assert.equal(w.code, 0, w.err + w.out);
		assert.match(w.out, /NEST=1/); assert.match(w.out, /nested subagents are disabled/);
		assert.equal(agentOf("sa-grand"), null, "grandchild exists!");
		stopQuiet(n);
	});

	test("4 parallel auto-named spawns: unique names, own answers, all panes exist", async () => {
		const toks = [tok(), tok(), tok(), tok()];
		const before = panes();
		const rs = await Promise.all(toks.map((t) => hsAsync(["spawn", ...BASE, "--tools", "read", say(t)])));
		const names = rs.map((r) => { assert.equal(r.code, 0, r.err); return r.out.match(/Spawned (\S+)/)[1]; });
		names.forEach((x) => created.add(x));
		assert.equal(new Set(names).size, 4, "duplicate names");
		const list = hs(["list"]).out;
		for (const x of names) assert.ok(list.includes(x), `${x} missing from list`);
		const ws = await Promise.all(names.map((x) => hsAsync(["wait", x, "--timeout", "150"])));
		ws.forEach((w, i) => { assert.equal(w.code, 0, w.err); assert.ok(w.out.includes(toks[i]), `child ${i}: ${w.out}`); });
		assert.equal(panes().size, before.size + 4);
		assert.equal(tabs().filter((x) => x.label === "subagents").length, 1, "parallel spawns created several subagents tabs");
		names.forEach(stopQuiet);
		assert.equal(panes().size, before.size);
	});

	test("same --name raced 3x: exactly one wins, losers fail cleanly with no leaked pane", async () => {
		const before = panes();
		const name = "xtrace"; created.add(full(name));
		const rs = await Promise.all([1, 2, 3].map(() => hsAsync(["spawn", "--name", name, ...BASE, "--tools", "read", say(tok())])));
		const ok = rs.filter((r) => r.code === 0);
		assert.equal(ok.length, 1, `winners: ${ok.length}; ${rs.map((r) => r.code + ":" + r.err.trim()).join(" | ")}`);
		assert.equal(panes().size, before.size + 1, "loser panes leaked");
		hs(["wait", name, "--timeout", "120"]); stopQuiet(name);
		assert.equal(panes().size, before.size);
	});

	test("children live in ONE tab named 'subagents'; caller's tab/focus untouched; tab disappears with the last child", () => {
		const myTab = process.env.HERDR_TAB_ID;
		const names = [];
		for (let i = 0; i < 6; i++) {
			const r = hs(["spawn", "--name", `xtlay${i}`, ...BASE, "--tools", "read", "--no-prompt"]); assert.equal(r.code, 0, r.err);
			names.push(full(`xtlay${i}`)); created.add(names.at(-1));
			const now = tabs();
			assert.equal(now.filter((x) => x.label === "subagents").length, 1, `spawn ${i}: expected exactly one subagents tab`);
			assert.equal(now.length, initialTabs.length + 1);
		}
		const sub = tabs().find((x) => x.label === "subagents").tab_id;
		assert.notEqual(sub, myTab);
		const paneIds = names.map((n) => agentOf(n).pane_id);
		assert.equal(new Set(paneIds).size, 6);
		for (const p of paneIds) assert.equal(tabOfPane(p), sub, "child outside the subagents tab");
		assert.equal(tabOfPane(process.env.HERDR_PANE_ID), myTab, "caller moved");
		const cur = JSON.parse(herdr(["pane", "current", "--current"]).stdout).result;
		assert.equal((cur.pane ?? cur).tab_id, myTab);
		for (const n of names) assert.match(hs(["status", n]).out, /idle/);
		const myTabPanes = [...panes()].filter((p) => tabOfPane(p) === myTab);
		assert.ok(!paneIds.some((p) => myTabPanes.includes(p)), "a child polluted the caller's tab");
		names.slice(0, -1).forEach(stopQuiet);
		assert.equal(tabs().some((x) => x.label === "subagents"), true, "tab must survive while a child remains");
		stopQuiet(names.at(-1));
		assert.deepEqual(tabs().map((x) => x.tab_id).sort(), initialTabs, "subagents tab leaked after the last child stopped");
	});

	test("--here splits beside the caller instead; --tab uses a custom tab label", () => {
		const myTab = process.env.HERDR_TAB_ID;
		assert.equal(hs(["spawn", "--name", "xthere", ...BASE, "--no-prompt", "--here"]).code, 0);
		created.add("sa-xthere");
		assert.equal(tabOfPane(agentOf("sa-xthere").pane_id), myTab);
		assert.equal(tabs().length, initialTabs.length, "--here must not create a tab");
		assert.equal(hs(["spawn", "--name", "xtcustom", ...BASE, "--no-prompt", "--tab", "xt-custom-tab"]).code, 0);
		created.add("sa-xtcustom");
		assert.ok(tabs().some((x) => x.label === "xt-custom-tab"));
		stopQuiet("sa-xthere"); stopQuiet("sa-xtcustom");
		assert.deepEqual(tabs().map((x) => x.tab_id).sort(), initialTabs);
	});

	test("a bare shell left in the subagents tab is recycled (and still blocks nesting)", () => {
		assert.equal(hs(["spawn", "--name", "xtrec1", ...BASE, "--no-prompt"]).code, 0); created.add("sa-xtrec1");
		const sub = tabs().find((x) => x.label === "subagents").tab_id;
		const extra = JSON.parse(herdr(["pane", "split", agentOf("sa-xtrec1").pane_id, "--direction", "down", "--no-focus"]).stdout).result.pane.pane_id; // plain shell, no marker env
		for (let i = 0; i < 40; i++) { // wait for the new pane's shell to be up
			const info = JSON.parse(herdr(["pane", "process-info", "--pane", extra]).stdout).result?.process_info;
			if (info?.foreground_processes?.length === 1 && info.foreground_processes[0].pid === info.shell_pid) break;
			spawnSync("sleep", ["0.25"]);
		}
		const before = panes();
		assert.equal(hs(["spawn", "--name", "xtrec2", ...BASE, "--no-prompt"]).code, 0); created.add("sa-xtrec2");
		assert.equal(agentOf("sa-xtrec2").pane_id, extra, "the free shell was not reused");
		assert.equal(panes().size, before.size, "reuse must not add a pane");
		assert.equal(tabOfPane(extra), sub);
		stopQuiet("sa-xtrec1"); stopQuiet("sa-xtrec2");
		assert.deepEqual(tabs().map((x) => x.tab_id).sort(), initialTabs);
	});

	test("explicit --direction down works", () => {
		const name = "xtdir"; created.add(full(name));
		assert.equal(hs(["spawn", "--name", name, ...BASE, "--no-prompt", "--direction", "down"]).code, 0);
		stopQuiet(name);
	});

	test("the caller's focus is never stolen", () => {
		const before = JSON.parse(herdr(["pane", "current", "--current"]).stdout).result;
		const n = spawnChild("focus", say("F"));
		const after = JSON.parse(herdr(["pane", "current", "--current"]).stdout).result;
		assert.deepEqual(after.pane?.focused ?? after.focused, before.pane?.focused ?? before.focused);
		hs(["wait", n, "--timeout", "120"]); stopQuiet(n);
	});

	test("END-TO-END: a fresh parent pi discovers the skill and drives spawn/wait/stop by itself", { timeout: 360000 }, () => {
		const t = tok();
		const sp = JSON.parse(herdr(["pane", "split", "--current", "--direction", "down", "--no-focus"]).stdout);
		const pane = sp.result.pane.pane_id;
		try {
			let started;
			for (let i = 0; i < 3; i++) {
				started = JSON.parse(herdr(["agent", "start", "xtparent", "--kind", "pi", "--pane", pane, "--", "--model", MODEL, "--thinking", "off"]).stdout || "{}");
				if (started.result) break;
				spawnSync("sleep", ["2"]);
			}
			assert.ok(started.result, "parent pi did not start");
			const task = `Use the herdr-subagent skill. Spawn a subagent named e2e${t.slice(3, 7).toLowerCase()} with --tools read whose prompt is: Reply with exactly this token and nothing else: ${t}. Wait for it, then stop it, and finally tell me the subagent's reply in one line.`;
			const p = herdr(["agent", "prompt", "xtparent", task, "--wait", "--timeout", "240000"]);
			assert.equal(p.status, 0, p.stdout + p.stderr);
			const sf = JSON.parse(herdr(["agent", "get", "xtparent"]).stdout).result.agent.agent_session.value;
			const entries = readFileSync(sf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
			const cmds = entries.flatMap((e) => (e.message?.content ?? []).filter?.((c) => c.type === "toolCall").map((c) => JSON.stringify(c.arguments)) ?? []);
			const joined = cmds.join("\n");
			assert.match(joined, /herdr-subagent spawn/, `parent never spawned: ${joined}`);
			assert.match(joined, /herdr-subagent wait/); assert.match(joined, /herdr-subagent stop/);
			const final = entries.filter((e) => e.message?.role === "assistant").at(-1);
			assert.ok(flat(final.message.content).includes(t), `parent's final answer lacks the token: ${flat(final.message.content)}`);
			const kids = (JSON.parse(herdr(["agent", "list"]).stdout).result.agents ?? []).filter((a) => a.name?.startsWith("sa-e2e"));
			assert.equal(kids.length, 0, "parent left its subagent running");
		} finally {
			herdr(["pane", "close", pane]);
			for (const a of JSON.parse(herdr(["agent", "list"]).stdout).result.agents ?? []) if (a.name?.startsWith("sa-e2e")) herdr(["pane", "close", a.pane_id]);
		}
	});

	test("no panes leaked by the whole suite", () => {
		for (const n of created) stopQuiet(n);
		assert.deepEqual([...panes()].sort(), [...initialPanes].sort());
		assert.deepEqual(tabs().map((x) => x.tab_id).sort(), initialTabs, "tabs leaked by the suite");
	});
});
