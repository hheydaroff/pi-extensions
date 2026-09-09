#!/usr/bin/env bash
# Boundary-extraction regression test for security.ts.
#
# Bundles the real extension, drives it with a fake pi API against a fixture
# rules file (harness.cjs points at tests/security-boundary/fixture/rules.json),
# and asserts which commands would prompt for outside-workspace access.
# Nothing is executed; only the guard runs.
#
# Add a case to harness.cjs whenever the guard prompts for something that is
# not a path, or fails to prompt for something that is.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf node_modules sec-ext.cjs
cp -R stubs node_modules

npx --no-install esbuild ../../security.ts \
  --format=cjs --bundle --platform=node \
  --external:@sinclair/typebox \
  --external:@earendil-works/pi-coding-agent \
  --external:@earendil-works/pi-ai \
  --outfile=sec-ext.cjs

node harness.cjs
