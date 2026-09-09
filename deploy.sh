#!/usr/bin/env bash
# deploy.sh — sync pi extensions to ~/.pi/agent/extensions/
#
# Usage:
#   bash deploy.sh          full sync (mirrors repo → target, deletes removed extensions)
#
# Never edit extensions directly in ~/.pi/agent/extensions/.
# Edit here, then run deploy.sh.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.pi/agent/extensions"

GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

ok()  { echo -e "${GREEN}✓${RESET} $*"; }
dim() { echo -e "${DIM}$*${RESET}"; }

echo ""
echo "Deploying pi extensions"
echo "  from: $REPO_DIR"
echo "  to:   $TARGET"
echo ""

mkdir -p "$TARGET"

# Repo-only paths, plus paths that exist ONLY in the target because another tool
# owns them. An --exclude also shields the target copy from --delete
# (verified on macOS openrsync 2.6.9-compatible).
EXCLUDES=(
  --exclude='.git/'
  --exclude='.gitignore'
  --exclude='deploy.sh'
  --exclude='tests/'
  --exclude='README.md'
  --exclude='node_modules/'
  --exclude='herdr-agent-state.ts'   # owner: `herdr integration install pi`
  --exclude='.pi-subagents/'         # owner: pi-subagents (missions + artifacts)
  --exclude='cache-graph/'           # owner: separate git clone, not this repo
)

# --delete must never silently remove something this repo does not own.
# List the deletions first and stop; override with FORCE_DELETE=1.
deletions=$(rsync -an --delete --itemize-changes "${EXCLUDES[@]}" "$REPO_DIR/" "$TARGET/" | grep '^\*deleting' || true)
if [[ -n "$deletions" ]]; then
  if [[ "${FORCE_DELETE:-0}" != "1" ]]; then
    echo "" >&2
    echo "Refusing to deploy: these exist only in the target and would be deleted:" >&2
    echo "$deletions" >&2
    echo "" >&2
    echo "  stale leftover  -> delete it yourself, then re-run" >&2
    echo "  another tool's  -> add an --exclude above" >&2
    echo "  really mean it  -> FORCE_DELETE=1 bash deploy.sh" >&2
    exit 1
  fi
  dim "FORCE_DELETE=1, deleting:"
  echo "$deletions"
fi

rsync -a --delete "${EXCLUDES[@]}" "$REPO_DIR/" "$TARGET/"

ok "~/.pi/agent/extensions/"

echo ""
dim "Done. Extensions deployed."
echo ""
