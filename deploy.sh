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

rsync -a --delete \
  --exclude='.git/' \
  --exclude='.gitignore' \
  --exclude='deploy.sh' \
  --exclude='README.md' \
  --exclude='node_modules/' \
  "$REPO_DIR/" "$TARGET/"

ok "~/.pi/agent/extensions/"

echo ""
dim "Done. Extensions deployed."
echo ""
