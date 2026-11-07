#!/usr/bin/env bash
# Rebuild dist/vlc_epg/ from the source tree (Lua + web UI).
set -euo pipefail
cd "$(dirname "$0")/.."
dist="dist/vlc_epg"
rm -rf "$dist" && mkdir -p "$dist"
cp src/vlc_epg.lua "$dist/"
mkdir -p "$dist/web"
(cd epg-web && tar --exclude=node_modules --exclude=data --exclude=backup \
     --exclude=shot.js --exclude=start.cmd --exclude=package-lock.json \
     -cf - .) | (cd "$dist/web" && tar -xf -)
echo "Built $dist"
