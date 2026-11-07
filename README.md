# VLC EPG (IPTV)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![VLC](https://img.shields.io/badge/VLC-3.0.x-009c3f.svg)
![Node.js ≥ 16](https://img.shields.io/badge/Node.js-%3E%3D16-00a000.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)

A single-file [VLC](https://www.videolan.org/vlc/) 3.0.x Lua extension that loads
an IPTV **M3U playlist** and an **XMLTV EPG guide**, then fills VLC's playlist
columns with program information and shows a "now/next" on-screen popup when you
switch channels.

![columns](images/columns.png)

<img width="812" height="480" alt="drawer-open" src="https://github.com/user-attachments/assets/e795c64b-33a2-4100-bcc0-9fb158425917" />


## What it does

- Parses an M3U playlist from a **local file path** or **HTTP/HTTPS URL**
  (tvg-id, tvg-name, group-title, header `url-tvg`/`x-tvg-url`/`tvg-url`).
- Streams an XMLTV guide (local file, URL, or gzip-compressed `.xml.gz`) and
  keeps only the programmes for channels in your playlist, so a multi-megabyte
  guide parses in seconds.
- Matches channels to programs by `tvg-id` (cleaned, so `ATV.tr@SD` matches
  `ATV.HD.tr`), then falls back to channel-name matching.
- Loads the channels into VLC's **native playlist** and fills the columns:

  | Column      | Shows                                                       |
  |-------------|-------------------------------------------------------------|
  | Description | running program (bold) + upcoming programs                  |
  | Genre       | category of the running program                             |
  | Album       | synopsis of the running program                             |
  | Author      | channel group                                               |
- Caches the parsed guide locally and refreshes it every 6 hours (or on demand).
- Shows an OSD popup: "NOW / NEXT" with category and synopsis when you switch
  to a channel that has guide data.
- Remembers your playlist/guide URLs and display preferences between sessions.

## Install

1. Quit VLC completely.
2. Copy `vlc_epg.lua` into VLC's user **extensions** folder:

   | OS      | Folder                                                           |
   |---------|------------------------------------------------------------------|
   | Windows | `%APPDATA%\vlc\lua\extensions\`                                  |
   | Linux   | `~/.local/share/vlc/lua/extensions/`                             |
   | macOS   | `~/Library/Application Support/org.videolan.vlc/lua/extensions/` |

   > Do **not** put it inside the VLC app folder — VLC only reads user
   > extensions from the path above, and app updates wipe it.
3. Restart VLC and open **View → VLC EPG (IPTV)** (Windows/Linux) or
   **VLC → Extensions → VLC EPG (IPTV)** (macOS).
4. Enter your playlist address (file path or URL) and, optionally, the guide
   address. Leave the guide empty to use the `url-tvg` declared in your
   playlist header.
5. Press **Load into playlist**.
6. Enable the columns: right-click the playlist column header → check
   **Description, Genre, Album, Author**. Drag column edges to resize.

## Example

A public playlist to try (guides vary by provider; grab one that matches your
channels' `tvg-id`s):

```
Playlist: https://iptv-org.github.io/iptv/index.m3u
Guide:     (leave empty, or your own XMLTV URL)
```

For local development, generate the bundled sample pair:

```
python examples/make_test_epg.py
```

then load `examples/test.m3u` with `examples/test_epg.xml`.

## Development

The project includes a test suite that runs under a stock Lua 5.1 interpreter
(the same version VLC embeds). The core parsing/matching logic is pure and
testable without VLC.

```
lua tests/run_tests.lua src/vlc_epg.lua
lua tests/run_integration.lua src/vlc_epg.lua examples/test.m3u examples/test_epg.xml
```

Syntax check: `luac -p src/vlc_epg.lua`.

## VLC EPG Web UI (grid)

VLC 3.0's native Lua dialogs cannot render an interactive EPG grid. A
companion web app (`epg-web/`) provides a TV-guide grid — channel
logos/names, a time axis, colored program blocks, a live "now" line — and
plays the selected channel in VLC:

```
cd epg-web && node server.js    # → http://127.0.0.1:8123
```

See `epg-web/README.md` for details.

## How it works

- **`parse_m3u_lines`** — streaming M3U parser (pure, line-iterator based).
- **`parse_epg_stream`** — windowed XMLTV scanner. It accumulates a buffer and
  pulls out complete `<channel>`/`<programme>` elements as they arrive, so it
  only ever holds a small slice of the file in memory. Programmes outside the
  recency window (last hour → next 36h) are discarded.
- **`canon_id` / `normalize`** — token-based channel ID/name canonicalization
  that strips quality tokens (`HD`, `SD`, `4K`, `+1`, …) so ID and name
  matching are forgiving.
- **`apply_epg`** — one pass over the playlist resolving each channel to a
  guide channel, tracking whether matches were by ID or by name.
- **guide cache** — stores matched channels/programs keyed by a playlist
  signature so reloads are instant within the TTL.

## Notes / limits

- Loading **replaces the current VLC playlist**.
- The Description column is a snapshot at load time; press **Load into
  playlist** again to refresh (or **Re-download guide** to bypass the cache).
- Bold current program uses Unicode bold characters (A–Z, a–z, 0–9).
- For HTTPS/gzip sources that VLC's stream API can't read directly, the
  extension shells out to `curl` (ships with Windows 10+/macOS/Linux) and, on
  Windows, PowerShell for gzip decompression.
- Requires VLC **3.0.x** (the Lua dialog List widget used by fancier guides is
  not functional until VLC 4, so this extension uses the native playlist
  columns instead).

## License

MIT — see [LICENSE](LICENSE).

## Web UI (companion TV guide)

The repo also ships a zero-dependency Node web app (`epg-web/`) that renders the
same channels as a full TV-guide grid with an in-browser player (FFmpeg relay),
search/favorites, translation, and settings:

```text
vlc-epg/
├── src/vlc_epg.lua        -> VLC extension (single file)
├── epg-web/               -> the website / web UI
│   ├── server.js          -> Node HTTP server (port 8123)
│   ├── package.json       -> `npm start` runs the server
│   └── public/
│       ├── index.html     -> the app shell
│       ├── style.css      -> layout & component styles
│       └── theme.css      -> ★ edit this to re-skin (colors/variables)
├── tests/                 -> Lua unit + integration tests
├── examples/              -> sample playlist/guide fixtures
└── dist/vlc_epg/          -> ★ ready-to-drop-in single folder (below)
```

### Single-folder install (drag-and-drop)

The **`dist/vlc_epg/`** folder is the whole thing — the Lua extension **and**
the web UI together — ready to drop into VLC:

```text
dist/vlc_epg/
├── vlc_epg.lua      <- the extension
├── web/             <- the website (server.js + public/)
└── README.txt
```

1. Quit VLC.
2. Open `dist/vlc_epg/` and copy its **contents** (`vlc_epg.lua` and the
   `web/` folder) into your user extensions folder:
   `%APPDATA%\vlc\lua\extensions\` (Windows). The extension **finds the
   bundled `web/` folder next to itself** and starts the server automatically.
   No paths to configure.
3. Restart VLC → **View → VLC EPG (IPTV)**.
4. Requires Node.js ≥ 16.

> Note: VLC loads extension entry-points placed **directly** in `extensions/`
> (a `vlc_epg.lua` file), so drop the folder's contents — not the folder
> itself — into `extensions/`.

`scripts/package.sh` rebuilds `dist/vlc_epg/` from the source tree.

### Run the web UI

```bash
cd epg-web
npm start          # -> http://127.0.0.1:8123
```

(The server itself is zero-dependency — `npm start` is just a convenience
wrapper around `node server.js`; you don't need to `npm install` to run it.)

### Customizing the look & feel

All colors and most styling knobs live in **`public/theme.css`** — a single
`:root` block of CSS variables. Edit it to re-skin the whole app without
touching any markup or logic:

```css
:root {
  --bg:#0f1115; --panel:#161a21; --panel2:#1d222b; --border:#2a313d;
  --text:#e6e9ef; --muted:#8b93a3; --accent:#5673f5; --accent2:#6b8aff;
  --now:#ff4d5e; --grid:#232a35; --star:#f5c542;
}
```

Layout and component rules live separately in `public/style.css` for deeper
changes.
#   V L C - E P G 
 
 
