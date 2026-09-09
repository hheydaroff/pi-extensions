// Concurrency test for vault-memory's read-modify-write.
//
// Two modes:
//   node harness.cjs run              set up a scratch HOME, fire N workers, assert
//   node harness.cjs worker <i> <t0>  one "session" appending MARKER-<i>
//
// Every worker is a separate process with its own extension instance, which is what
// six open pi panes actually are. Nothing touches the real vault: HOME is a scratch
// dir, so MEMORY_PATH resolves inside it.
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const HOME = path.join(HERE, "scratch-home");
const MEM_DIR = path.join(HOME, ".pi/agent/pi-memory");
const MEM_FILE = path.join(MEM_DIR, "concurrency-probe.md");
const N = 8;

function setUp() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(
    MEM_FILE,
    [
      "---",
      'description: "probe"',
      "created: 2026-01-01",
      "updated: 2026-01-01",
      "tags:",
      "  - pi-memory",
      "---",
      "",
      "base content",
      "",
    ].join("\n"),
  );
}

async function worker(index, startAt) {
  const mod = require(process.env.VM_EXT || "./vm-ext.cjs");
  let tool;
  mod.default({ registerTool: (t) => { if (t.name === "vault_memory") tool = t; },
                registerCommand: () => {}, on: () => {} });
  while (Date.now() < startAt) { /* spin to a common start so the writes collide */ }
  const r = await tool.execute("t1", { action: "update", name: "concurrency-probe",
                                       content: `MARKER-${index}` }, undefined, undefined, {});
  if (r.isError) console.error(`worker ${index} error: ${r.content[0].text}`);
  process.exit(r.isError ? 1 : 0);
}

function run() {
  setUp();
  const startAt = Date.now() + 1500;
  const kids = [];
  for (let i = 0; i < N; i++) {
    kids.push(new Promise((res) => {
      const p = spawn(process.execPath, [path.join(HERE, "harness.cjs"), "worker", String(i), String(startAt)],
                      { env: { ...process.env, HOME, VM_EXT: process.env.VM_EXT || path.join(HERE, "vm-ext.cjs") },
                        stdio: ["ignore", "ignore", "inherit"] });
      p.on("exit", (code) => res(code));
    }));
  }
  Promise.all(kids).then((codes) => {
    const body = readFileSync(MEM_FILE, "utf-8");
    const found = [];
    for (let i = 0; i < N; i++) if (body.includes(`MARKER-${i}`)) found.push(i);
    const missing = [...Array(N).keys()].filter((i) => !found.includes(i));
    const leftovers = readdirSync(MEM_DIR).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
    const updatedOnce = (body.match(/updated:/g) || []).length;

    console.log(`appends surviving: ${found.length}/${N}` + (missing.length ? `  MISSING: ${missing.join(",")}` : ""));
    console.log(`frontmatter 'updated:' occurrences: ${updatedOnce} (must be 1 — no duplicated header)`);
    console.log(`workers exiting non-zero: ${codes.filter((c) => c !== 0).length}`);
    console.log(`stray .tmp/.lock files: ${leftovers.length}${leftovers.length ? " -> " + leftovers.join(",") : ""}`);
    const ok = found.length === N && updatedOnce === 1 && leftovers.length === 0 && codes.every((c) => c === 0);
    console.log(ok ? "\nPASS — no lost appends, no torn file, locks cleaned up" : "\nFAIL");
    process.exit(ok ? 0 : 1);
  });
}

if (process.argv[2] === "worker") worker(Number(process.argv[3]), Number(process.argv[4]));
else run();
