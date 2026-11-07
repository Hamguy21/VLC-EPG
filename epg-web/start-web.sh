#!/usr/bin/env bash
# VLC EPG web server launcher (macOS/Linux)
# Uses a system Node.js if present; otherwise downloads a portable Node into
# .node/ (no admin, no system install) on first run.
set -euo pipefail
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  exec node server.js
fi

VER=v20.19.4
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)      TGT="linux-x64" ;;
  Linux-aarch64)     TGT="linux-arm64" ;;
  Linux-arm64)       TGT="linux-arm64" ;;
  Darwin-x86_64)     TGT="darwin-x64" ;;
  Darwin-arm64)      TGT="darwin-arm64" ;;
  *) echo "unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac

DIR=".node/node-$VER-$TGT"
if [ ! -x "$DIR/bin/node" ]; then
  mkdir -p .node
  echo "Downloading portable Node.js (first run only)..."
  curl -sSL -o .node/node.tar.xz "https://nodejs.org/dist/$VER/node-$VER-$TGT.tar.xz"
  tar -xJf .node/node.tar.xz -C .node
  rm -f .node/node.tar.xz
fi

exec "$DIR/bin/node" server.js
