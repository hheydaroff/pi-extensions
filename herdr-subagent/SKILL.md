---
name: herdr-subagent
description: Delegate work to a separate pi agent running in a visible Herdr pane, via the herdr-subagent CLI. Use when the user asks for a subagent/worker/scout/reviewer to run in parallel or in isolation, or to do a long task while you continue. Requires running inside Herdr (HERDR_ENV=1).
---

# herdr-subagent

Spawns a full pi agent in its own pane inside a dedicated `subagents` tab (created on demand, closed when the last child stops; the user's focus never moves). You control it with bash.

```bash
herdr-subagent spawn [--name n] [--tools read,grep,find,ls] [--cwd dir] "<self-contained prompt>"   # --here: beside you instead of the subagents tab
herdr-subagent wait <name> [--timeout 1800]   # blocks, prints the child's last reply
herdr-subagent send <name> "<message>"        # idle: new turn; working: steers (arrives after current tool call)
herdr-subagent send <name> --follow-up "..."  # working: queued until the run finishes
herdr-subagent list | status <name> | result <name> | peek <name> | stop <name>
```

Rules:
- The child shares no context with you. Put everything it needs in the prompt (paths, goal, output format).
- Read-only investigation: `--tools read,grep,find,ls`. Implementation: omit `--tools`.
- Provider, model and thinking level are inherited automatically. Do not pass PI_* variables.
- Do not pipe `wait` output through anything that hides the exit code. Exit codes: 0 reply printed, 1 child failed/was interrupted (message on stderr), 3 BLOCKED, 124 timeout (child keeps running).
- Exit 3 = the child is stopped at a security/approval dialog. Run `peek <name>`, tell the user immediately what it wants to do and that they must answer in the `subagents` tab. Never answer it yourself and never `send` (refused: its Enter would approve the dialog). `wait` only reports BLOCKED after the dialog survived 12 s (pi's AI review can clear some by itself). Unanswered dialogs expire after about 30 s and the child continues with a denial, so `wait` again afterwards; the user can also approve with Enter in the child's pane.
- Prompts starting with `/`, `!` or `-` are prefixed with "Task: " so they can never run as pi commands or bash. A message that begins with `--` needs a `--` separator: `send <name> -- "--flag looking text"`.
- Children run in the folder you give (`--cwd`, default: yours). Unless that folder is already trusted in pi, the child starts with `--no-approve` (project-local `.pi` files are ignored) so no trust dialog can appear.
- Several `spawn` calls in a row are fine, but wait for each pane to start (the CLI does) rather than launching in the same instant.
- Stop children you are done with (`stop`). The transcript is kept; `result` still works afterwards.
- A child cannot spawn children.
- Never use `herdr pane send-text` or `send-keys` on a child; use `send`.
