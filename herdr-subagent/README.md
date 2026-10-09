# herdr-subagent

Zero-dependency (node + `herdr`) replacement for badlogic/pi-subagent's tmux control plane.
Herdr provides process lifetime, liveness (`agent get`), lifecycle (`working/idle/done/blocked`),
steering (`agent prompt` while working) and pane lifecycle. This file only glues them together.
Results are read from the child's pi session JSONL (path reported by `agent get`, saved in
`~/.local/state/herdr-subagent/<name>.json` so `result` works after exit).

Install: `ln -s "$PWD/herdr-subagent.mjs" ~/.local/bin/herdr-subagent` and
`ln -s "$PWD" ~/.pi/agent/skills/herdr-subagent` (then `/reload`).

## Layout and safety facts (verified by herdr-subagent.test.mjs)

- Children go to a tab labelled `subagents` (`--tab` to rename, `--here` to split beside the caller).
  Spawns are serialised by a mkdir lock under `~/.local/state/herdr-subagent/layout.lock`.
- Child env: `HERDR_SUBAGENT=1` (blocks nesting) and `PI_SKIP_VERSION_CHECK=1` (update-checker.ts opens a
  select whose first option is "Update and restart now"; the prompt's Enter would pick it).
- Unless cwd is trusted in `~/.pi/agent/trust.json`, children get `--no-approve` (a trust dialog's Enter would trust the folder).
- `send` refuses while the child is blocked; security dialogs auto-deny after 30 s.
- `wait` only trusts a transcript that contains every prompt we sent (`sent` counter in the index file).

## Known extension interference (not fixed here, see report)

cron-scheduler.ts and signal-bridge start in every pi process, including children.
Suggested one-line guard at the top of their `session_start` handlers: `if (process.env.HERDR_SUBAGENT) return;`

## Tests

`node --test herdr-subagent/herdr-subagent.test.mjs` inside a Herdr pane (about 10 min, a few cents on Haiku).
