#!/usr/bin/env bash
# Rebuild the release: dist/vlc_epg/ (single drop-in folder) + .zip archive.
set -euo pipefail
cd "$(dirname "$0")/.."
dist="dist/vlc_epg"
rm -rf "$dist" && mkdir -p "$dist"
cp src/vlc_epg.lua "$dist/"
mkdir -p "$dist/web"
# copy the web UI, excluding dev/runtime junk
(cd epg-web && tar --exclude=node_modules --exclude=data --exclude=backup \
     --exclude=shot.js --exclude=start.cmd --exclude=package-lock.json \
     -cf - .) | (cd "$dist/web" && tar -xf -)
chmod +x "$dist/web/start-web.sh"
cp INSTALL.md "$dist/INSTALL.md"
# release zip (name from the extension version)
ver=$(grep -oE 'version = "[0-9.]+"' src/vlc_epg.lua | grep -oE '[0-9.]+' | head -1)
ver=${ver:-1.1.0}
zip="dist/vlc_epg-${ver}.zip"
rm -f "$zip"
(cd "$dist" && python -c "import zipfile,os,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f),os.path.join(os.path.relpath(r,'.'),f)) for r,d,fs in os.walk('.') for f in fs]; z.close()" "../$(basename "$zip")")
echo "Built $dist + $zip"
