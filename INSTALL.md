# VLC EPG — Installation Guide

This adds an IPTV TV-guide to VLC 3.0.x: it fills the playlist columns with
"now/next" program info **and** opens a full web TV-guide (grid, favorites,
search, in-browser player) in your browser.

## What you need

| Requirement   | Notes                                                            |
|---------------|------------------------------------------------------------------|
| **VLC 3.0.x** | free from videolan.org — the *3.0.x* line (not 4.x)              |
| **Node.js**   | free from nodejs.org — version 16 or newer, for the web TV-guide |

> The Lua part (playlist columns) works without Node. Only the **web TV-guide**
> needs Node.js.

---

## Install — the short version

> Important: VLC loads the extension from a file placed **directly** inside its
> `extensions` folder. So you copy the **contents** of the downloaded folder —
> not the folder itself.

### Windows

1. Quit VLC completely.
2. Unzip the downloaded archive. Inside you'll see:
   - `vlc_epg.lua`
   - `web/` (a folder)
   - `INSTALL.md`
3. Copy **`vlc_epg.lua`** and the **`web/`** folder into:
   `C:\Users\<YourName>\AppData\Roaming\vlc\lua\extensions\`
   - Tip: press `Win + R`, paste
     `%APPDATA%\vlc\lua\extensions`, press Enter.
   - If the `extensions` folder doesn't exist, create it.
4. Start VLC. Open the **View** menu → **VLC EPG (IPTV)**.

> If the "View" menu is missing, enable it: **Tools → Customize Interface… → View**.

### macOS

1. Quit VLC.
2. Unzip. Copy `vlc_epg.lua` and the `web/` folder into:
   `~/Library/Application Support/org.videolan.vlc/lua/extensions/`
3. Start VLC → **VLC → Extensions → VLC EPG (IPTV)**.

### Linux

1. Quit VLC.
2. Unzip. Copy `vlc_epg.lua` and the `web/` folder into:
   `~/.local/share/vlc/lua/extensions/`
3. Start VLC → **View → VLC EPG (IPTV)**.

---

## First launch

The first time you open the extension it will try to start the web server and
open your browser. If nothing happens, check:

1. **Node.js is installed** — open a terminal and type `node -v`. If that
   errors, install Node.js and restart VLC.
2. **Your firewall/AV** didn't block the local server (port 8123).
3. If you see an error in VLC, the web UI is usually still usable directly at
   **http://127.0.0.1:8123/** — open that in any browser.

In the web TV-guide, paste your **M3U playlist** (file path or URL) and, if you
have one, your **XMLTV guide** URL. Press **Load**. The guide grid appears.

---

## Making it feel like yours (theming)

The whole look is controlled by one file of colors:

- `web\public\theme.css` — edit the `:root` color variables
  (`--bg`, `--accent`, `--text`, …) to re-skin everything.
- `web\public\style.css` — layout and component rules (for deeper changes).

Refresh the browser after editing.

---

## Troubleshooting

| Symptom                      | Fix                                                                                                  |
|------------------------------|------------------------------------------------------------------------------------------------------|
| "Web UI not found" in VLC    | Make sure the `web/` folder is right next to `vlc_epg.lua` in the extensions folder                  |
| Nothing opens in the browser | Verify Node.js and open http://127.0.0.1:8123/ manually                                              |
| Menu item missing            | The `.lua` must be directly in `extensions/` (not in a subfolder) — check the path                   |
| Port already in use (8123)   | Something else uses that port; stop it or run the web server manually from `web/` (`node server.js`) |

## License

MIT — see `LICENSE` in the repository.
