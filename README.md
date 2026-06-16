# pi-extensions

A collection of extensions for the [pi coding agent](https://github.com/badlogic/pi-mono).

Extensions are developed here and deployed to `~/.pi/agent/extensions/` with `deploy.sh`.

## Usage

```bash
# Deploy all extensions to ~/.pi/agent/extensions/
bash deploy.sh

# Or test a single extension without deploying
pi -e ./radio-garden.ts
```

After deploying, run `/reload` inside pi (or restart) to pick up changes.

> **Edit here, not in `~/.pi/agent/extensions/`.** `deploy.sh` mirrors this repo to the target and deletes anything not present here.

## Extensions

### Productivity & UX

| Extension | What it does |
|---|---|
| **`btw.ts`** | `/btw <question>` — ask a quick aside question answered with recent context in a dismissible overlay, without polluting the main conversation. |
| **`copy-block.ts`** | `/copy-block [n]` (alias `/cb`) — extract code blocks from the last assistant message and copy clean text (no TUI padding) to the clipboard. |
| **`exit-alias.ts`** | Adds `/exit` as an alias for the built-in `/quit`. |
| **`coffee-break.ts`** | Prevents the machine from sleeping while the agent is working (macOS `caffeinate`, Linux `systemd-inhibit`, Windows `SetThreadExecutionState`). Auto-releases when the turn ends. |
| **`radio-garden.ts`** | `/radio` — listen to live radio from [radio.garden](https://radio.garden). Random station, search by name, or browse by city/country. Shows the current station in a sticky footer widget. Requires `mpv` or `ffplay`. |
| **`pocket-tts.ts`** | `/voice` — text-to-speech voice output of assistant replies using a configurable TTS model. |

### Memory & Sessions

| Extension | What it does |
|---|---|
| **`vault-memory.ts`** | `vault_memory` tool — persistent agent memory stored as markdown in `~/.pi/agent/pi-memory/`. Read, write, update, and list facts/preferences across sessions. |
| **`session-summary.ts`** | Auto-saves a conversation summary (highlights, tools used, files modified) to the vault memory path when a session ends or switches. |
| **`auto-skill.ts`** | After a complex multi-step task, *proposes* (never auto-creates) a reusable pi skill. Only written after you explicitly accept. |

### Workflow & Tooling

| Extension | What it does |
|---|---|
| **`review.ts`** | `/review` — code review command (inspired by Codex). Review a GitHub PR, a base branch, uncommitted changes, a specific commit, or a folder snapshot. Supports shared custom review instructions and a loop-fixing mode. |
| **`cron-scheduler.ts`** | `cron_schedule` tool — schedule recurring/one-shot prompts (standard 5-field cron, or `once`). Jobs persist in `~/.pi/agent/cron-jobs.json` and deliver results via Signal. |
| **`spool.ts`** | Keeps oversized tool output out of context. Transparently spools large results to disk + FTS5 index, replacing them with a compact pointer. Adds `spool_run`, `spool_index`, `spool_search`, `spool_get` and `/spool`. |
| **`update-checker.ts`** | Checks npm for a newer pi release and surfaces the right install command for your package manager. |
| **`update-local-models.ts`** | `/update-local-models` — sync locally served models (e.g. LM Studio / Ollama) into `~/.pi/agent/models.json`. |
| **`tool-counter.ts`** | Rich two-line custom footer: model + context meter + token/cost on top, cwd/branch + per-tool call tally below. Good `setFooter` reference. |

### Security & Safety

| Extension | What it does |
|---|---|
| **`security.ts`** | Enforces configurable security rules from `~/.pi/agent/security.json` (global) and `.pi/security.json` (project). Pattern-based bash/path guards, allowed-pattern exceptions, session grants, CWD boundary mode, and a `security_manage` tool. |
| **`secret-guard.ts`** | Two-layer secret defence: **blocks** tool access to `.pi/.secrets/` directories and **redacts** known secret values from tool results before the LLM sees them. Commands: `/secrets-reload`, `/secrets-status`. |
| **`uv.ts`** | Redirects Python tooling to `uv` equivalents. Blocks `pip`/`poetry`, routes `python`/`python3` through `uv run`, and blocks interpreter-bypass paths with helpful hints. |

### Integrations

| Extension | What it does |
|---|---|
| **`signal-bridge/`** | Bridges pi to Signal so you can talk to the agent from your phone. Validates E.164 numbers and an allowlist of contacts. Config lives in `signal-bridge.json` (gitignored — never committed). |

## Structure

- **Single-file extensions:** `*.ts`
- **Multi-file extensions:** directories with `index.ts` + `package.json` (e.g. `signal-bridge/`)

## Configuration & secrets

These extensions read config/secrets from outside the repo and are **not** committed:

- `~/.pi/agent/security.json`, `.pi/security.json` — security rules
- `~/.pi/.secrets/`, `.pi/.secrets/` — secret values for `secret-guard`
- `signal-bridge.json`, `.signal-cli/` — Signal account config (gitignored)
- `~/.pi/agent/cron-jobs.json`, `~/.pi/agent/models.json`, `~/.pi/agent/pi-memory/` — runtime state

## License

Personal extensions, provided as-is. Use at your own risk — extensions run with your full system permissions.
