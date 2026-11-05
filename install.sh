#!/usr/bin/env bash
# Install/remove vlc_epg.lua to/from VLC's user extensions folder.
# Usage: ./install.sh [--uninstall]
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/src/vlc_epg.lua"
MODE="${1:-install}"

case "$(uname -s)" in
  Darwin) DEST="$HOME/Library/Application Support/org.videolan.vlc/lua/extensions" ;;
  Linux)
    if [ -n "${XDG_DATA_HOME:-}" ]; then DEST="$XDG_DATA_HOME/vlc/lua/extensions"
    else DEST="$HOME/.local/share/vlc/lua/extensions"; fi ;;
  MINGW*|MSYS*|CYGWIN*) DEST="$APPDATA/vlc/lua/extensions" ;;
  *) echo "unsupported OS" >&2; exit 1 ;;
esac

if [ "$MODE" = "--uninstall" ]; then
  rm -f "$DEST/vlc_epg.lua"
  echo "Removed $DEST/vlc_epg.lua"
else
  mkdir -p "$DEST"
  cp "$SRC" "$DEST/vlc_epg.lua"
  echo "Installed to $DEST/vlc_epg.lua"
  echo "Restart VLC, then open View > VLC EPG (IPTV)."
fi
