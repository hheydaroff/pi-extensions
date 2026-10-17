#!/usr/bin/env bash
# Remote-approval (Matrix leg) test for security.ts.
# Bundles the real extension, drives it with a fake pi API, a controllable fake ctx.ui.confirm and a fake
# bridge on a temp unix socket. Nothing is executed; fake timers stand in for the 30 s / 2 min fuses.
# Run with: bash tests/remote-approval/run.sh
set -euo pipefail
cd "$(dirname "$0")"

rm -rf node_modules sec-ext.cjs
cp -R stubs node_modules

npx --no-install esbuild "${SEC_TS:-../../security.ts}" \
  --format=cjs --bundle --platform=node \
  --external:@sinclair/typebox \
  --external:@earendil-works/pi-coding-agent \
  --external:@earendil-works/pi-ai \
  --outfile=sec-ext.cjs --log-level=warning

# hard cap: a deadlocked fake-timer test must not hang the session (macOS has no `timeout`)
perl -e 'alarm 120; exec @ARGV' node harness.cjs
