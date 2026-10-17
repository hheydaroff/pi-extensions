# pi-extensions

Pi extensions. Edit here, never in `~/.pi/agent/extensions/`; ship with `bash deploy.sh`, then `/reload`.
Homelab gets it from the same repo (deploy.sh there). Commit when tests are green, before deploying.

## Tests (one command)
- All suites: `bash tests/run-all.sh` (each `tests/*/run.sh` has a 120 s hard cap).
- `security-boundary/`, `remote-approval/`: bundle the real `security.ts` and drive it with a fake pi API. Add a case whenever the guard prompts for a non-path or misses a real one.
- `vault-memory-lock/`, `content-filter-repair/`, `ai-review/`, `herdr-subagent/*.test.mjs`: see each folder.

## Gotchas
- Change source with the `edit` tool (not python/sed heredocs). macOS sed needs `sed -i ''`.
- Do not read or patch `~/.pi/agent/security.json` from bash (guarded). Read `tests/*/fixture/rules*.json` or use `security_manage action=list`.
- Test harnesses use fake timers; never run them without the run.sh cap.
- Remote approval timeout is 2 min (`REMOTE_DEFAULT_TIMEOUT_MS` in security.ts), TUI fuse 30 s.
