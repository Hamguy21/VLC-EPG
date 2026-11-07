# GitHub release assets

## Repository description (blurb)

> A single-folder VLC 3.0.x add-on that turns any IPTV M3U playlist into a TV guide — fills VLC's playlist columns with now/next program info and launches a full web TV-guide (grid, search, favorites, translation, in-browser player).

*(Short, 1–2 sentences — paste into the repo's "About" description.)*

---

## Release body (v1.1.0)

**VLC EPG (IPTV) — v1.1.0**

A single-folder add-on for VLC 3.0.x that turns your IPTV playlist into a real TV-guide: it fills VLC's playlist columns with **now/next** program info, and opens a full **web TV-guide** (grid, search, favorites, translation, in-browser player) in your browser.

### What's in the box
- **VLC extension** (`vlc_epg.lua`) — playlist columns + OSD now/next popup.
- **Web TV-guide** (`web/`) — zero-dependency Node server, opens automatically; grid, favorites, search, optional auto-translate, settings, a built-in player with an FFmpeg relay for streams the browser alone can't play.

### Install (≈1 minute)
1. Quit VLC.
2. Unzip, then copy the **contents** (`vlc_epg.lua` + the `web/` folder) into your VLC extensions folder:
   - Windows: `%APPDATA%\vlc\lua\extensions\`
   - macOS: `~/Library/Application Support/org.videolan.vlc/lua/extensions/`
   - Linux: `~/.local/share/vlc/lua/extensions/`
3. Restart VLC → **View → VLC EPG (IPTV)**.

Full walkthrough + troubleshooting: `INSTALL.md`.

### Requirements
- VLC **3.0.x**
- Node.js ≥ 16 (for the web TV-guide)

### Make it look like yours
Edit `web/public/theme.css` — every color is a single `:root` block of CSS variables. Deeper layout changes live in `web/public/style.css`.

### What's new in this release
- **One-folder distribution** — extension + web UI together; no paths to configure (self-locating launcher).
- **Separate themable CSS** — colors in `theme.css`, layout in `style.css`.
- Earlier in this line: per-channel error notes, fresh-debug reset, proxy support, relay MP2 fix, failing channels no longer close the player, reconnect forward-skip + ad backoff.

### Notes / limits
- Free playlist sources can be dead or geo-gated — a failed channel now shows *why* instead of closing the player.
- Some protected feeds (e.g. Pluto ads) are structurally unplayable in the web player; use the VLC path for those.

**License:** MIT

---

## Suggested release settings
- **Tag:** `v1.1.0`
- **Asset:** `vlc_epg-1.1.0.zip` (build with `scripts/package.sh`)
- **Target:** branch `main`
