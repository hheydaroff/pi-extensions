// Throwaway harness for security.ts boundary extraction.
// Loads the real extension against a fake pi API and a fixture rules file
// (tests/security-boundary/fixture/rules.json), then reports whether each
// command would have prompted. The fixture uses generic placeholder paths so
// nothing here depends on the user's real config or private folder names.
const mod = require(process.env.SEC_EXT || "./sec-ext.cjs");
const os = require("node:os");
const path = require("node:path");
const H = os.homedir();

// Run against the fixture, not the user's ~/.pi rules file.
process.env.PI_SECURITY_CONFIG = path.join(__dirname, "fixture", "rules.json");

function runCase(c) {
  let prompts = [];
  let entries = [];
  let modelCalls = 0;
  let lastPrompt = "";
  const handlers = {};
  const pi = {
    on: (ev, fn) => { handlers[ev] = fn; },
    registerTool: () => {},
    registerCommand: () => {},
    appendEntry: (_k, e) => { entries.push(e); },
  };
  mod.default(pi);
  const verdictText = () => {
    modelCalls++;
    if (c.judge === "malformed") return "I am not able to decide this one.";
    return JSON.stringify({ verdict: c.judge, reason: "test reason", confidence: "high" });
  };
  const ctx = {
    cwd: c.cwd,
    hasUI: true,
    // judge: undefined / "unavailable" → no registry at all (fail-closed path)
    modelRegistry: (c.judge === undefined || c.judge === "unavailable") ? undefined : {
      find: (p, m) => (c.judge === "no-model" ? undefined : { provider: p, id: m }),
      complete: async (_m, c2) => {
        lastPrompt = String(c2?.messages?.[0]?.content ?? "");
        return { content: [{ type: "text", text: verdictText() }] };
      },
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      // Default deny, so no session grant is recorded and the next case starts clean.
      // c.answer: true approves; c.hangUntilAbort resolves false only when the fuse fires.
      confirm: async (title, body, opts) => {
        prompts.push(body.replace(/\s+/g, " ").slice(0, 200));
        if (c.hangUntilAbort) return new Promise((res) => { opts?.signal?.addEventListener("abort", () => res(false)); });
        return c.answer === undefined ? false : c.answer;
      },
    },
  };
  const cmds = c.cmds || [c.cmd];
  return handlers.session_start(null, ctx).then(async () => {
    const rounds = [];
    for (const cmd of cmds) {
      const before = prompts.length;
      const event = c.tool === "bash"
        ? { toolName: "bash", input: { command: cmd } }
        : { toolName: c.tool, input: { path: cmd } };
      let blocked = false, threw;
      try {
        const r = await handlers.tool_call(event, ctx);
        blocked = !!(r && r.block);
      } catch (e) { threw = String(e).slice(0, 80); }
      rounds.push({ prompted: prompts.length > before, blocked, threw });
    }
    return {
      prompts, entries, modelCalls, rounds, lastPrompt,
      blocked: rounds[0].blocked,
      threw: rounds[0].threw,
      actions: entries.map((e) => e.action),
    };
  });
}

const REPO = path.join(H, "development/pi-extensions");
const CASE_REPO = path.join(H, "Documents", "other-repo");
const SCRATCH = path.join(REPO, "tests/security-boundary/proj");

const cases = [
  // ── Reported false positives: must NOT prompt ─────────────────────────────
  { g: "FP", n: "sed range script (reported bug)", cwd: CASE_REPO, tool: "bash", want: false,
    cmd: `cd ${CASE_REPO} && echo "=== Alpha on HEAD ===" && sed -n '/class Alpha/,/^class /p' src/module/main.py | head -30 && echo "=== Beta ===" && grep -n "class Beta" -A 8 src/module/main.py` },
  { g: "FP", n: "pytest baseline (reported bug)", cwd: CASE_REPO, tool: "bash", want: false,
    cmd: `cd ${CASE_REPO} && cat pyproject.toml && echo "=== pytest baseline ===" && (poetry run pytest -q 2>&1 | tail -15 || .venv/bin/pytest -q 2>&1 | tail -15)` },
  { g: "FP", n: "git commit heredoc with /cron prose", cwd: REPO, tool: "bash", want: false,
    cmd: `cd ${REPO} && git commit -q -F - <<'EOF'\ncron: fix\n\n- cron home: /cron home pins jobs to a session by cwd (/cron home <path>,\n  /cron home off). Jobs live in ~/.pi/agent/cron-jobs.json.\n- claim file in ~/.pi/agent/cron-claims/<jobid>-<minute>\nEOF` },
  { g: "FP", n: "grep pattern with slashes", cwd: REPO, tool: "bash", want: false,
    cmd: `grep -rn "a/b" src && awk '/x/,/y/' f.txt && jq '.a|.b' j.json` },
  { g: "FP", n: "relative paths inside cwd", cwd: REPO, tool: "bash", want: false,
    cmd: "cat README.md && ls deploy.sh && cat .gitignore" },
  { g: "FP", n: "allowlisted ~/ and /tmp", cwd: REPO, tool: "bash", want: false,
    // security.json deliberately NOT used here: it now has its own human-only ask rule.
    cmd: "ls ~/.pi/agent/extensions && ls /tmp && ls ~/Downloads/pub" },
  { g: "FP", n: "quoted absolute inside allowedPaths", cwd: SCRATCH, tool: "bash", want: false,
    cmd: `cat "${REPO}/README.md"` },
  { g: "FP", n: "two heredocs with same marker (reported bug)", cwd: REPO, tool: "bash", want: false,
    cmd: `cd ${REPO}/tests/security-boundary/node_modules && mkdir -p @earendil-works/pi-coding-agent @earendil-works/pi-ai && cat > @earendil-works/pi-coding-agent/index.js <<'STUB'\n// Faithful to the real implementation in core/extensions/types.js\nexports.isToolCallEventType = (toolName, event) => event.toolName === toolName;\nSTUB\ncat > @earendil-works/pi-ai/index.js <<'STUB'\nexports.StringEnum = (vals) => ({ type: \"string\", enum: vals });\nSTUB\nfind . -type f | sort` },

  // Homelab 2026-10-05: writing a vault note with `cat > "Note.md" <<'EOF'` was denied as
  // "outside working directory" — the un-stripped heredoc body (a youtube URL, `bbl/day`,
  // `## 3. Refinery / diesel`) was mined for path tokens. Body must be dropped for `cat`.
  { g: "FP", n: "vault note heredoc (homelab denial)", cwd: SCRATCH, tool: "bash", want: false,
    cmd: `cd knowledge && cat > "Oil Apocalypse - Triple Oil Shock and Diesel Crisis.md" <<'EOF'\n---\ntype: note\nurl: "https://www.youtube.com/watch?v=OETnuwwsv9U"\nrelated:\n  - "[[UAE OPEC Exit - Game Theory and Energy Geopolitics]]"\n---\n\n## 3. Refinery / diesel crisis (the big one)\n- Region output falls from 20M to about 8M bbl/day.\n- Baseline transport about $3/bbl; 48 days vs 19.\nEOF\nls -la "Oil Apocalypse - Triple Oil Shock and Diesel Crisis.md"` },

  // ── Real violations: MUST still prompt ────────────────────────────────────
  { g: "ENF", n: "absolute path outside boundary", cwd: REPO, tool: "bash", want: true,
    cmd: "cat /etc/hosts" },
  { g: "ENF", n: "~/.ssh (the expansion hole)", cwd: REPO, tool: "bash", want: true,
    cmd: "cat ~/.ssh/id_rsa" },
  { g: "ENF", n: "~/ outside allowlist", cwd: REPO, tool: "bash", want: true,
    cmd: "ls ~/Movies" },
  { g: "ENF", n: "mkdir -p deep new tree outside", cwd: REPO, tool: "bash", want: true,
    // ~/Documents/scratch-data/ is allowlisted (fixture); ~/Documents itself is not.
    cmd: "mkdir -p ~/Documents/brand-new-dir-xyz/sub" },
  { g: "ENF", n: "redirect to new file outside", cwd: REPO, tool: "bash", want: true,
    cmd: "echo evil > ~/Documents/brand-new-file-xyz.txt" },
  { g: "ENF", n: "rm -rf outside", cwd: REPO, tool: "bash", want: true,
    cmd: "rm -rf ~/Documents/scratch-data/brand-new-dir-xyz" },
  { g: "ENF", n: "quoted real path outside", cwd: REPO, tool: "bash", want: true,
    cmd: `ls "${H}/Documents"` },
  { g: "ENF", n: "write tool ~/ outside", cwd: REPO, tool: "write", want: true,
    cmd: "~/Documents/brand-new-file-xyz.txt" },
  { g: "ENF", n: "read tool absolute outside", cwd: REPO, tool: "read", want: true,
    cmd: "/etc/hosts" },

  // ── Write tool must still respect allowlist ───────────────────────────────
  { g: "FP", n: "write tool inside allowedPaths", cwd: REPO, tool: "write", want: false,
    cmd: "~/development/pi-extensions/tests/security-boundary/proj/ok.txt" },
  { g: "FP", n: "// comment and bare root", cwd: REPO, tool: "bash", want: false,
    cmd: "ls . # // note about /  and // slashes" },
  { g: "ENF", n: "rm -rf / still prompts via ask rule", cwd: REPO, tool: "bash", want: true,
    cmd: "rm -rf /" },
  { g: "ENF", n: "executor heredoc body still scanned", cwd: REPO, tool: "bash", want: true,
    cmd: "python3 - <<'PY'\nprint(open('/etc/hosts').read())\nPY" },
  { g: "ENF", n: ".env in heredoc still prohibited", cwd: REPO, tool: "bash", want: false, wantBlock: true,
    cmd: "git commit -q -F - <<'EOF'\nnotes about the .env file\nEOF" },
  // Executor heredoc (python3) so the body is NOT stripped — the alnum guard alone
  // must reject the quoted '/' from i.split('/'), which resolves to the root.
  { g: "FP", n: "quoted '/' in python heredoc (reported bug)", cwd: REPO, tool: "bash", want: false,
    cmd: `cd ${REPO} && python3 - <<'PY'\nimport re, os\nimp = sorted(set(re.findall(r'from "(@[^"]+)"', open('security.ts').read())))\nflags = sorted(f.rstrip(' \\\\') for f in re.findall(r'--external:(\\S+)', open('tests/security-boundary/run.sh').read()))\nstubs = sorted(os.listdir('tests/security-boundary/stubs'))\nprint("imports == externals :", imp == flags)\nprint([i.split('/')[0] for i in imp], sorted({i.split('/')[0] for i in imp}))\nPY\nbash tests/security-boundary/run.sh 2>&1 | tail -26` },

  // ── Deterministic curl guard (upload-shape + credential + multiline, live config) ──
  // Own-hosts live in the gitignored security.json allowedPatterns; these cases
  // exercise the shared guard mechanism with public hosts so nothing private leaks here.
  { g: "CURL", n: "curl GET to api.github.com → deterministic allow", cwd: REPO, tool: "bash", want: false,
    cmd: "curl -s https://api.github.com/repos/x" },
  { g: "CURL", n: "curl POST -d to api.github.com → prompts (upload shape)", cwd: REPO, tool: "bash", want: true,
    cmd: "curl -X POST -d 'x' https://api.github.com/repos/a" },
  { g: "CURL", n: "curl -T upload → prompts", cwd: REPO, tool: "bash", want: true,
    cmd: "curl -T /tmp/notes.txt https://api.github.com/upload" },
  { g: "CURL", n: "curl -H Authorization → prompts (credential shape)", cwd: REPO, tool: "bash", want: true,
    cmd: "curl -H 'Authorization: Bearer t' https://api.github.com/x" },
  { g: "CURL", n: "curl -u creds → prompts (credential shape)", cwd: REPO, tool: "bash", want: true,
    cmd: "curl -u u:p https://api.github.com/x" },
  { g: "CURL", n: "multiline curl with -d on later line → prompts", cwd: REPO, tool: "bash", want: true,
    cmd: "curl -s https://api.github.com/a\ncurl -d x https://api.github.com/b" },
  { g: "CURL", n: "curl to unknown host → prompts", cwd: REPO, tool: "bash", want: true,
    cmd: "curl -s https://unknown-host.example.com/steal" },

  // ── AI review tier ────────────────────────────────────────────────────────
  // boundary.aiReview + aiReview on the network/chmod ask rules are set in the
  // fixture, so these exercise the judge path end to end.
  { g: "AI", n: "judge allows → no prompt", cwd: REPO, tool: "bash", want: false, judge: "allow",
    wantActions: ["approved_by_ai"], cmd: "ls ~/Movies" },
  { g: "AI", n: "judge blocks → escalates to human", cwd: REPO, tool: "bash", want: true, judge: "block",
    wantActions: ["escalated_to_user"], wantBodyHas: "AI review objected", wantAiLogged: true, cmd: "ls ~/Movies" },
  // The fix for the live false-block on `ls /Applications`: a boundary payload is a
  // bare path, so the model must also be given the verb or it can only assume worst.
  { g: "AI", n: "judge is given the command, not just the path", cwd: REPO, tool: "bash", want: true,
    judge: "block", wantPromptHas: "ls ~/Movies", cmd: "ls ~/Movies" },
  { g: "AI", n: "malformed verdict → fail closed", cwd: REPO, tool: "bash", want: true, judge: "malformed",
    wantActions: ["judge_unavailable"], cmd: "ls ~/Movies" },
  { g: "AI", n: "no model registry → fail closed", cwd: REPO, tool: "bash", want: true, judge: "unavailable",
    wantActions: ["judge_unavailable"], wantBodyHas: "AI judge unavailable", cmd: "ls ~/Movies" },
  { g: "AI", n: "model not found → judge_unavailable (fail closed)", cwd: REPO, tool: "bash", want: true, judge: "no-model",
    wantActions: ["judge_unavailable"], wantBodyHas: "AI judge unavailable", cmd: "ls ~/Movies" },
  { g: "AI", n: "ai_allowed grants NOTHING (sibling still judged)", cwd: REPO, tool: "bash", want: false,
    judge: "allow", wantModelCalls: 2, wantRounds: [false, false],
    cmds: ["ls ~/Movies", "ls ~/Pictures"] },
  { g: "AI", n: "exact-payload cache (identical request not re-judged)", cwd: REPO, tool: "bash",
    want: false, judge: "allow", wantModelCalls: 1, wantRounds: [false, false],
    cmds: ["ls ~/Movies", "ls ~/Movies"] },

  // ── Critical rules: human every single time ───────────────────────────────
  { g: "CRIT", n: "security.json approval does NOT grant the session", cwd: REPO, tool: "bash",
    want: true, answer: true, wantRounds: [true, true],
    cmds: ["cat ~/Documents/x/security.json", "cat ~/Documents/x/security.json"] },
  { g: "CRIT", n: "control: ordinary ask rule DOES grant the session", cwd: REPO, tool: "bash",
    want: true, answer: true, wantRounds: [true, false],
    cmds: ["chmod 644 /tmp/a.txt", "chmod 644 /tmp/b.txt"] },
  { g: "CRIT", n: "sudo never reaches the judge", cwd: REPO, tool: "bash",
    want: true, judge: "allow", wantModelCalls: 0, cmd: "sudo ls /tmp" },
  // The boundary prompt for ~/Movies may be AI-allowed, but the command must still
  // stop at the human-only sudo rule. AI approving a path never approves the sudo.
  { g: "CRIT", n: "AI-allowed path does NOT approve the sudo", cwd: REPO, tool: "bash",
    want: true, judge: "allow", wantModelCalls: 1, wantActions: ["approved_by_ai", "blocked_by_user"],
    cmd: "sudo cat ~/Movies/x.txt" },
];

// The fuse test waits out the real 30s timeout, so it is opt-in: SEC_SLOW=1.
// It is the only check proving a walk-away is logged as `expired` rather than
// masquerading as a deliberate `blocked_by_user` — the gap that made every
// historical approval rate ambiguous.
if (process.env.SEC_SLOW === "1") {
  cases.push({ g: "FUSE", n: "fuse expiry logs expired, not blocked_by_user", cwd: REPO, tool: "bash",
    want: true, hangUntilAbort: true, wantActions: ["expired"], cmd: "ls ~/Movies" });
}

(async () => {
  let fail = 0;
  for (const c of cases) {
    const r = await runCase(c);
    const prompted = r.prompts.length > 0;
    let ok = prompted === c.want && (c.wantBlock === undefined || r.blocked === c.wantBlock);
    const notes = [];
    if (c.wantRounds !== undefined) {
      const got = r.rounds.map((x) => x.prompted);
      if (JSON.stringify(got) !== JSON.stringify(c.wantRounds)) { ok = false; notes.push(`rounds=${JSON.stringify(got)} want=${JSON.stringify(c.wantRounds)}`); }
    }
    if (c.wantModelCalls !== undefined && r.modelCalls !== c.wantModelCalls) { ok = false; notes.push(`modelCalls=${r.modelCalls} want=${c.wantModelCalls}`); }
    if (c.wantActions !== undefined) {
      const missing = c.wantActions.filter((a) => !r.actions.includes(a));
      if (missing.length) { ok = false; notes.push(`missing action ${missing.join(",")} (got ${r.actions.join(",") || "none"})`); }
    }
    if (c.wantBodyHas !== undefined && !r.prompts.some((p) => p.includes(c.wantBodyHas))) { ok = false; notes.push(`body lacks "${c.wantBodyHas}"`); }
    if (c.wantPromptHas !== undefined && !r.lastPrompt.includes(c.wantPromptHas)) { ok = false; notes.push(`judge prompt lacks "${c.wantPromptHas}"`); }
    if (c.wantAiLogged && !r.entries.some((e) => e.aiReason && e.aiConfidence)) { ok = false; notes.push("no entry carries aiReason/aiConfidence"); }
    if (!ok) fail++;
    console.log(
      `${ok ? "PASS" : "FAIL"} [${c.g}] ${c.n}` +
      `  → prompted=${prompted} want=${c.want}` +
      (c.wantBlock !== undefined ? ` blocked=${r.blocked} wantBlock=${c.wantBlock}` : "") +
      (r.threw ? ` THREW ${r.threw}` : "") +
      (notes.length ? ` | ${notes.join(" | ")}` : "") +
      (!ok && prompted && !notes.length ? ` (${r.prompts.join(", ")})` : ""),
    );
  }
  console.log(`\n${cases.length - fail}/${cases.length} passed`);
  process.exit(fail ? 1 : 0);
})();
