#!/usr/bin/env bash
# Concurrency test for vault-memory: 8 separate processes (what 8 open pi panes
# are) append to one memory file at the same instant. Asserts no append is lost,
# the frontmatter is not duplicated, and no .tmp/.lock file is left behind.
#
# Everything happens under tests/vault-memory-lock/scratch-home — the real vault
# is never touched, because MEMORY_PATH is derived from $HOME.
set -euo pipefail
cd "$(dirname "$0")"

# Generated artifacts only, inside this directory.
rm -rf node_modules vm-ext.cjs scratch-home
cp -R stubs node_modules

npx --no-install esbuild ../../vault-memory.ts \
  --format=cjs --bundle --platform=node \
  --external:@sinclair/typebox \
  --outfile=vm-ext.cjs

node harness.cjs run
