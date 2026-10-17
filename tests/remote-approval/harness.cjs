// Offline acceptance tests for the remote-approval leg in security.ts (see HANDOFF-remote-approvals.md).
// Real extension bundle + fake pi API + controllable fake ctx.ui.confirm + fake bridge on a temp unix socket.
const mod = require("./sec-ext.cjs");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

process.env.PI_SECURITY_CONFIG = path.join(__dirname, "fixture", "rules.json");
delete process.env.PI_APPROVAL_TIMEOUT_MS;
delete process.env.PI_REMOTE_APPROVAL_TIMEOUT_MS;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ra-"));
const SOCK = path.join(TMP, "approvals.sock");
// Never touch the real bridge socket, even for the "no socket" cases (a live bridge would receive a real request).
process.env.PI_MATRIX_APPROVAL_SOCK = SOCK;

// ── fake clock: only fuse-sized timers (>= 5 s) are intercepted; short ones (connect guard) stay real ──
const realSet = global.setTimeout, realClear = global.clearTimeout;
let fuses = [];
global.setTimeout = (fn, ms, ...a) => {
  if (ms >= 5000) { const t = { fn, ms, cleared: false, fired: false }; fuses.push(t); return t; }
  return realSet(fn, ms, ...a);
};
global.clearTimeout = (t) => { if (t && typeof t === "object" && "cleared" in t) t.cleared = true; else realClear(t); };
const live = () => fuses.filter((t) => !t.cleared && !t.fired);
const fire = (ms) => { const t = live().find((x) => x.ms === ms); assert.ok(t, `no live ${ms}ms timer (have ${live().map((x) => x.ms)})`); t.fired = true; t.fn(); };
const sleep = (ms) => new Promise((r) => realSet(r, ms));
const until = async (pred, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(5); } return pred(); };

// ── fake bridge ──
function fakeBridge(behaviour = "post") {
  const b = { conns: [], requests: [], cancels: [], listening: false };
  b.server = net.createServer((s) => {
    const c = { s, closed: false }; b.conns.push(c); s.setEncoding("utf8"); let buf = "";
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.type === "cancel") b.cancels.push(m.reason); else {
        b.requests.push(m);
        if (behaviour === "post") s.write(JSON.stringify({ type: "posted", code: "abc" }) + "\n");
        if (behaviour === "error") s.end(JSON.stringify({ type: "error", error: "rate limited" }) + "\n");
        if (behaviour === "garbage") s.write("not json\n{\"type\":\"decision\",\"decision\":\"maybe\"}\n");
      }
    } });
    s.on("close", () => { c.closed = true; }); s.on("error", () => {});
  });
  b.start = () => new Promise((r) => b.server.listen(SOCK, () => { b.listening = true; r(); }));
  b.decide = (d) => b.conns.at(-1).s.write(JSON.stringify({ type: "decision", decision: d }) + "\n");
  b.die = () => b.conns.at(-1).s.destroy();
  b.stop = () => new Promise((r) => { b.conns.forEach((c) => c.s.destroy()); b.server.close(() => r()); });
  return b;
}

// ── fake pi + ctx ──
function rig({ judge, hasUI = true } = {}) {
  const handlers = {}, entries = [], events = [];
  const pi = {
    on: (ev, fn) => { handlers[ev] = fn; }, registerTool() {}, registerCommand() {},
    appendEntry: (_k, e) => entries.push(e), events: { emit: (n, d) => { if (n === "herdr:blocked") events.push([n, d.active]); } },
    getSessionName: () => "fixture-session",
  };
  mod.default(pi);
  const tui = { calls: [], pending: [] };
  const ctx = {
    cwd: "/tmp/fixture-proj", hasUI,
    modelRegistry: judge ? { find: (p, m) => ({ provider: p, id: m }), complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict: judge, reason: "judge says " + judge, confidence: "high" }) }] }) } : undefined,
    ui: {
      notify() {}, setStatus() {},
      confirm: (title, body, opts) => new Promise((res) => {
        const call = { title, body, opts, aborted: false, res };
        tui.calls.push(call);
        opts?.signal?.addEventListener("abort", () => { call.aborted = true; res(false); });
      }),
    },
  };
  const ready = handlers.session_start(null, ctx);
  const run = async (command, tool = "bash", input) => { await ready; return handlers.tool_call({ toolName: tool, input: input ?? { command } }, ctx); };
  return { run, ctx, tui, entries, events, handlers };
}
const lastEntry = (r, action) => r.entries.filter((e) => e.action === action).at(-1);

let passed = 0, failed = 0;
async function test(name, fn) {
  fuses = []; delete process.env.PI_MATRIX_ROOM;
  try { fs.unlinkSync(SOCK); } catch {}
  try {
    // A protocol mismatch shows up as a promise that never settles: fail it instead of hanging the run.
    await Promise.race([fn(), new Promise((_, rej) => realSet(() => rej(new Error("timed out after 8 s")), 8000))]);
    passed++; console.log("  ok   ", name); }
  catch (e) { failed++; console.log("  FAIL ", name, "\n       ", String(e.stack || e).split("\n").slice(0, 4).join("\n        ")); }
}
const ASK = "foo-deploy now";

(async () => {
  console.log("remote approval (security.ts)");

  await test("1 no socket: TUI-only, 30 s fuse with countdown, result unchanged (expired)", async () => {
    const r = rig(); const p = r.run(ASK);
    await until(() => r.tui.calls.length === 1);
    assert.equal(r.tui.calls[0].opts.timeout, 30000); assert.ok(r.tui.calls[0].opts.signal);
    assert.deepEqual(live().map((t) => t.ms), [30000]);
    fire(30000);
    const res = await p; assert.equal(res.block, true);
    assert.equal(lastEntry(r, "expired").via, "tui");
    assert.deepEqual(r.events, [["herdr:blocked", true], ["herdr:blocked", false]]);
  });

  await test("1b no socket: TUI yes / no keep today's labels", async () => {
    let r = rig(); let p = r.run(ASK); await until(() => r.tui.calls.length === 1); r.tui.calls[0].res(true);
    assert.equal(await p, undefined); assert.equal(lastEntry(r, "approved_by_user").via, "tui");
    r = rig(); p = r.run(ASK); await until(() => r.tui.calls.length === 1); r.tui.calls[0].res(false);
    assert.equal((await p).block, true); assert.equal(lastEntry(r, "blocked_by_user").via, "tui");
  });

  await test("1c a regular file (not a socket) at the path is ignored", async () => {
    fs.writeFileSync(SOCK, ""); process.env.PI_MATRIX_APPROVAL_SOCK = SOCK;
    const r = rig(); const p = r.run(ASK); await until(() => r.tui.calls.length === 1);
    assert.equal(r.tui.calls[0].opts.timeout, 30000); r.tui.calls[0].res(true); await p;
  });

  process.env.PI_MATRIX_APPROVAL_SOCK = SOCK;

  await test("2 PI_MATRIX_ROOM set: no connection attempted, TUI-only", async () => {
    const b = fakeBridge(); await b.start(); process.env.PI_MATRIX_ROOM = "!r:x";
    const r = rig(); const p = r.run(ASK); await until(() => r.tui.calls.length === 1);
    await sleep(100); assert.equal(b.conns.length, 0); assert.equal(r.tui.calls[0].opts.timeout, 30000);
    r.tui.calls[0].res(true); await p; await b.stop();
  });

  await test("3 remote yes while TUI pending: allowed, TUI dialog aborted, via=matrix, no TUI fuse", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK);
    await until(() => r.tui.calls.length === 1 && b.requests.length === 1);
    const call = r.tui.calls[0];
    assert.equal(call.opts.timeout, undefined, "no TUI fuse while the phone leg is up");
    assert.ok(call.opts.signal);
    assert.deepEqual(live().map((t) => t.ms), [120000], "one timer, the remote one");
    b.decide("yes");
    assert.equal(await p, undefined);
    assert.equal(call.aborted, true);
    assert.equal(lastEntry(r, "approved_by_user").via, "matrix");
    assert.deepEqual(live(), []);
    // a remote yes is treated like a TUI yes: the rule is granted for the session, so no 2nd prompt
    assert.equal(await r.run(ASK), undefined); assert.equal(r.tui.calls.length, 1);
    assert.deepEqual(r.events, [["herdr:blocked", true], ["herdr:blocked", false]]);
    await b.stop();
  });

  await test("3b request payload: rule, body, cwd, session, timeout; no secrets beyond the prompt", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1);
    const q = b.requests[0];
    assert.equal(q.v, 1); assert.equal(q.pid, process.pid); assert.equal(q.cwd, "/tmp/fixture-proj"); assert.equal(q.session, "fixture-session");
    assert.equal(q.rule, "fixture deploy"); assert.match(q.body, /foo-deploy now/); assert.equal(q.timeoutMs, 120000);
    assert.ok(q.id && q.title);
    b.decide("no"); await p; await b.stop();
  });

  await test("4 remote no: blocked as blocked_by_user, not expired", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1);
    b.decide("no"); const res = await p;
    assert.equal(res.block, true);
    const e = lastEntry(r, "blocked_by_user"); assert.equal(e.via, "matrix"); assert.equal(lastEntry(r, "expired"), undefined);
    assert.equal(r.tui.calls[0].aborted, true);
    await b.stop();
  });

  await test("5 TUI answers first: cancel(answered_locally) sent, connection closed", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1 && r.tui.calls.length === 1);
    r.tui.calls[0].res(true);
    assert.equal(await p, undefined);
    await until(() => b.cancels.length === 1);
    assert.deepEqual(b.cancels, ["answered_locally"]); assert.ok(await until(() => b.conns[0].closed));
    assert.equal(lastEntry(r, "approved_by_user").via, "tui"); assert.deepEqual(live(), []);
    await b.stop();
  });

  await test("5b TUI no first: also cancels", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1 && r.tui.calls.length === 1);
    r.tui.calls[0].res(false); assert.equal((await p).block, true);
    await until(() => b.cancels.length === 1); assert.deepEqual(b.cancels, ["answered_locally"]);
    assert.equal(lastEntry(r, "blocked_by_user").via, "tui");
    await b.stop();
  });

  await test("6 no answer: expires at the REMOTE timeout (2 min), not at 30 s; bridge told 'expired'", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1 && r.tui.calls.length === 1);
    assert.equal(live().some((t) => t.ms === 30000), false);
    fire(120000);
    assert.equal((await p).block, true);
    assert.ok(lastEntry(r, "expired")); assert.equal(r.tui.calls[0].aborted, true);
    await until(() => b.cancels.length === 1); assert.deepEqual(b.cancels, ["expired"]);
    await b.stop();
  });

  await test("6b bridge reports 'expired' first: expired", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1);
    b.decide("expired"); assert.equal((await p).block, true); assert.ok(lastEntry(r, "expired")); assert.equal(r.tui.calls[0].aborted, true);
    await b.stop();
  });

  await test("6c PI_REMOTE_APPROVAL_TIMEOUT_MS shorter than the caller's fuse never shortens it", async () => {
    process.env.PI_REMOTE_APPROVAL_TIMEOUT_MS = "5000";
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1);
    assert.deepEqual(live().map((t) => t.ms), [30000]); assert.equal(b.requests[0].timeoutMs, 30000);
    b.decide("yes"); await p; await b.stop(); delete process.env.PI_REMOTE_APPROVAL_TIMEOUT_MS;
  });

  await test("7 bridge dies mid-request: TUI leg keeps working, fuse falls back to 30 s, still resolves", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1 && r.tui.calls.length === 1);
    b.die();
    await until(() => live().some((t) => t.ms === 30000));
    assert.equal(r.tui.calls[0].aborted, false);
    assert.deepEqual(live().map((t) => t.ms), [30000]);
    r.tui.calls[0].res(true);
    assert.equal(await p, undefined); assert.equal(lastEntry(r, "approved_by_user").via, "tui");
    await b.stop();
  });

  await test("7b bridge dies, nobody answers: expired after the fallback fuse", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1);
    b.die(); await until(() => live().some((t) => t.ms === 30000)); fire(30000);
    assert.equal((await p).block, true); assert.ok(lastEntry(r, "expired")); await b.stop();
  });

  await test("7c bridge refuses (error reply) or sends garbage: TUI-only behaviour, never rejects", async () => {
    for (const mode of ["error", "garbage"]) {
      fuses = []; try { fs.unlinkSync(SOCK); } catch {}
      const b = fakeBridge(mode); await b.start();
      const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1 && r.tui.calls.length === 1);
      if (mode === "error") await until(() => live().some((t) => t.ms === 30000));
      r.tui.calls[0].res(true); assert.equal(await p, undefined, mode); await b.stop();
    }
  });

  await test("7d connect refused (stale socket file, nobody listening): TUI-only, quickly", async () => {
    // A real left-behind socket: bind in a child process and SIGKILL it so nothing unlinks the file.
    const child = require("node:child_process").spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(SOCK)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((res) => child.stdout.once("data", res)); child.kill("SIGKILL"); await new Promise((res) => child.once("exit", res));
    assert.ok(fs.lstatSync(SOCK).isSocket(), "stale socket file should remain");
    const r = rig(); const t0 = Date.now(); const p = r.run(ASK); await until(() => r.tui.calls.length === 1);
    assert.ok(Date.now() - t0 < 700); assert.equal(r.tui.calls[0].opts.timeout, 30000); r.tui.calls[0].res(false); await p;
  });

  await test("8 judge allows: no socket traffic at all, ai_allowed unchanged", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig({ judge: "allow" });
    assert.equal(await r.run("foo-review now"), undefined);
    await sleep(80); assert.equal(b.conns.length, 0); assert.equal(r.tui.calls.length, 0);
    assert.ok(lastEntry(r, "approved_by_ai")); await b.stop();
  });

  await test("8b judge objects: escalated; request carries the judge note, TUI still shows it", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig({ judge: "block" }); const p = r.run("foo-review now"); await until(() => b.requests.length === 1);
    assert.match(b.requests[0].aiNote, /AI review objected/); assert.doesNotMatch(b.requests[0].body, /AI review objected/);
    assert.match(r.tui.calls[0].body, /AI review objected/);
    b.decide("yes"); assert.equal(await p, undefined); await b.stop();
  });

  await test("9 rule removal stays terminal-only (never offered to the phone), 60 s TUI fuse", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(null, "security_manage", { action: "remove", description: "x", pattern: "y", target: "global", scope: "bash", category: "ask" });
    await until(() => r.tui.calls.length === 1);
    await sleep(80); assert.equal(b.conns.length, 0); assert.equal(r.tui.calls[0].opts.timeout, 60000);
    assert.equal(r.tui.calls[0].opts.noRemote, undefined, "internal flag must not leak to pi");
    r.tui.calls[0].res(false); await p; await b.stop();
  });

  await test("10 hard prohibit: no prompt, no approval request; a text-only FYI goes to the bridge (rate-limited client side)", async () => {
    const b = fakeBridge("fyi"); await b.start();
    const r = rig(); const res = await r.run("foo-wipe all");
    assert.equal(res.block, true); assert.equal(r.tui.calls.length, 0);
    await until(() => b.requests.length === 1);
    assert.equal(b.requests[0].type, "fyi"); assert.equal(b.requests[0].rule, "fixture hard block");
    await r.run("foo-wipe again"); await sleep(80); assert.equal(b.requests.length, 1, "second block within 5 s is not sent");
    await b.stop();
  });

  await test("10b ask-rule without UI is not a hard block: no FYI", async () => {
    const b = fakeBridge("fyi"); await b.start();
    const r = rig({ hasUI: false }); await r.run(ASK); await sleep(80); assert.equal(b.requests.length, 0); await b.stop();
  });

  await test("11 headless (no UI): still denied, remote leg never used", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig({ hasUI: false }); const res = await r.run(ASK);
    assert.equal(res.block, true); assert.match(res.reason, /no UI/); await sleep(60); assert.equal(b.conns.length, 0); await b.stop();
  });

  await test("12 phone answer is final even if TUI later reports something", async () => {
    const b = fakeBridge(); await b.start();
    const r = rig(); const p = r.run(ASK); await until(() => b.requests.length === 1 && r.tui.calls.length === 1);
    b.decide("no"); await p; r.tui.calls[0].res(true); // late TUI 'yes' after abort: must not matter
    await sleep(30); assert.equal(r.entries.filter((e) => /_by_user$/.test(e.action)).length, 1);
    await b.stop();
  });

  // The other two prompt sites (askOnWrite, outside-workspace): same ask → audit → grant sequence as bash.ask.
  const WRITE = (r, p) => r.run(null, "write", { path: p, content: "x" });

  await test("13 askOnWrite: no UI blocks; 'no' blocks; 'yes' allows and grants the rule for the session", async () => {
    let r = rig({ hasUI: false }); const noUi = await WRITE(r, "/tmp/fixture-proj/a.fixture-ask");
    assert.equal(noUi.block, true); assert.equal(lastEntry(r, "blocked").category, "paths.askOnWrite");
    r = rig(); let p = WRITE(r, "/tmp/fixture-proj/a.fixture-ask"); await until(() => r.tui.calls.length === 1);
    assert.equal(r.tui.calls[0].opts.timeout, 30000); r.tui.calls[0].res(false);
    assert.equal((await p).block, true); assert.equal(lastEntry(r, "blocked_by_user").via, "tui");
    r = rig(); p = WRITE(r, "/tmp/fixture-proj/a.fixture-ask"); await until(() => r.tui.calls.length === 1); r.tui.calls[0].res(true);
    assert.equal(await p, undefined); assert.equal(lastEntry(r, "approved_by_user").category, "paths.askOnWrite");
    assert.equal(await WRITE(r, "/tmp/fixture-proj/b.fixture-ask"), undefined); assert.equal(r.tui.calls.length, 1, "granted for the session: no second prompt");
  });

  await test("13b askOnWrite expiry: fuse runs out → expired, not blocked_by_user", async () => {
    const r = rig(); const p = WRITE(r, "/tmp/fixture-proj/a.fixture-ask"); await until(() => r.tui.calls.length === 1);
    fire(30000); assert.equal((await p).block, true); assert.ok(lastEntry(r, "expired")); assert.equal(lastEntry(r, "blocked_by_user"), undefined);
  });

  await test("14 outside-workspace: 'yes' grants the DIRECTORY for the session; 'no' and expiry give their own reasons", async () => {
    const prev = process.env.PI_SECURITY_CONFIG; process.env.PI_SECURITY_CONFIG = path.join(__dirname, "fixture", "rules-boundary.json");
    try {
      const READ = (r, p) => r.run(null, "read", { path: p });
      let r = rig(); let p = READ(r, "/var/outside-fixture/one.txt"); await until(() => r.tui.calls.length === 1);
      assert.equal(r.tui.calls[0].opts.timeout, 30000); r.tui.calls[0].res(true);
      assert.equal(await p, undefined); assert.equal(lastEntry(r, "approved_by_user").category, "boundary");
      assert.equal(await READ(r, "/var/outside-fixture/two.txt"), undefined); assert.equal(r.tui.calls.length, 1, "directory granted");
      r = rig(); p = READ(r, "/var/outside-fixture/one.txt"); await until(() => r.tui.calls.length === 1); r.tui.calls[0].res(false);
      assert.match((await p).reason, /User denied access outside/);
      r = rig(); p = READ(r, "/var/outside-fixture/one.txt"); await until(() => r.tui.calls.length === 1); fire(30000);
      assert.match((await p).reason, /timed out/); assert.ok(lastEntry(r, "expired"));
    } finally { process.env.PI_SECURITY_CONFIG = prev; }
  });

  // ── contract: the REAL bridge side (pi-matrix/approvals.mjs) instead of the hand-written fake above ──
  // The fake bridge only proves security.ts against what we THINK the protocol is. These cases run both real
  // modules against each other, so a renamed field or changed reply on either side fails here, offline.
  const APPROVALS = process.env.PI_MATRIX_APPROVALS_MJS || path.join(os.homedir(), "development", "pi-matrix", "approvals.mjs");
  if (!fs.existsSync(APPROVALS)) console.log("\n  (contract cases skipped: " + APPROVALS + " not found)");
  else {
    const { createApprovals } = await import(require("node:url").pathToFileURL(APPROVALS).href);
    const realBridge = async () => {
      const o = { sent: [], edits: [], notices: [], locked: false, n: 0 };
      o.a = createApprovals({
        sockPath: SOCK, getRoom: () => "!r:t", isLocked: () => o.locked,
        send: async (_r, md) => { o.sent.push(md); return "$e" + ++o.n; },
        edit: async (_r, _id, md) => { o.edits.push(md); },
        notice: async (_r, md) => { o.notices.push(md); },
      });
      assert.equal(await o.a.start(), true);
      o.code = () => /code `([a-z0-9]{3})`/.exec(o.sent.at(-1))[1];
      return o;
    };

    await test("C1 contract: phone 'y <code>' approves; bridge message carries the rule; audit says matrix", async () => {
      const o = await realBridge(); const r = rig(); const p = r.run(ASK);
      await until(() => o.sent.length === 1 && r.tui.calls.length === 1);
      assert.match(o.sent[0], /fixture deploy/); assert.match(o.sent[0], /foo-deploy now/); assert.match(o.sent[0], /fixture-session/);
      assert.equal(await o.a.tryText("!r:t", "y " + o.code()), true);
      assert.equal(await p, undefined); assert.equal(r.tui.calls[0].aborted, true);
      assert.equal(lastEntry(r, "approved_by_user").via, "matrix");
      assert.match(o.edits.at(-1), /Approved from phone/);
      o.a.stop();
    });

    await test("C2 contract: phone 'n <code>' blocks", async () => {
      const o = await realBridge(); const r = rig(); const p = r.run(ASK);
      await until(() => o.sent.length === 1 && r.tui.calls.length === 1);
      await o.a.tryText("!r:t", "n " + o.code());
      assert.equal((await p).block, true); assert.equal(lastEntry(r, "blocked_by_user").via, "matrix");
      o.a.stop();
    });

    await test("C3 contract: terminal answers first; bridge edits the phone message and forgets the request", async () => {
      const o = await realBridge(); const r = rig(); const p = r.run(ASK);
      await until(() => o.sent.length === 1 && r.tui.calls.length === 1);
      r.tui.calls[0].res(true); assert.equal(await p, undefined);
      await until(() => o.edits.length === 1);
      assert.match(o.edits[0], /Answered at the Mac/); assert.equal(o.a.pendingCount(), 0);
      assert.equal(lastEntry(r, "approved_by_user").via, "tui");
      o.a.stop();
    });

    await test("C4 contract: bridge locked: refused as 'no' without asking anyone", async () => {
      const o = await realBridge(); o.locked = true; const r = rig(); const p = r.run(ASK);
      assert.equal((await p).block, true); assert.equal(lastEntry(r, "blocked_by_user").via, "matrix");
      assert.equal(o.sent.length, 0); assert.match(o.notices[0], /locked/);
      o.a.stop();
    });

    await test("C5 contract: hard block FYI reaches the phone as a notice, no approval request", async () => {
      const o = await realBridge(); const realNow = Date.now; Date.now = () => realNow() + 3_600_000; // past the client-side 5 s throttle
      try {
        const r = rig(); await r.run("foo-wipe all");
        await until(() => o.notices.length === 1);
        assert.match(o.notices[0], /Blocked/); assert.match(o.notices[0], /fixture hard block/); assert.equal(o.sent.length, 0);
      } finally { Date.now = realNow; o.a.stop(); }
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  global.setTimeout = realSet; global.clearTimeout = realClear;
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
