# VLC EPG Web UI (TV guide)

A companion web app that renders an **EPG grid** and controls
VLC playback. VLC 3.0's native Lua dialogs cannot render an interactive grid
(their HTML widget is a static label), so the guide is a local web UI that
talks to VLC on the same machine.

## Features

- Full grid: channel logos down the left, a time axis across the top, program
  blocks colored per channel, and a live red "now" line.
- Click any program block → plays that channel in **VLC** (kills the previous
  instance so it behaves like channel switching).
- Group filter (from M3U `group-title`) and a viewing window (±2/3/6/12 h).
- Loads your M3U playlist and XMLTV EPG from URLs or local file paths (gzip
  supported via curl fallback for remote, plain file for local).
- Channel matching: cleaned `tvg-id` first, then name fallback — identical
  rules to the Lua extension.

## Run

```
node server.js          # → http://127.0.0.1:8123
```

Then open that URL in a browser. Enter your playlist and EPG addresses, or
hit **Sample** (uses the public IPTV-org playlist).

## Playback

The server launches VLC directly (`vlc.exe <stream-url>`) as your user — no
VLC HTTP-interface password setup required. Set `VLC_BIN` to override the
binary path.

## Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/` | — | the grid UI |
| POST | `/parse/m3u` | `{src}` | channels, groups, header EPG |
| POST | `/parse/xmltv` | `{src}` | channel/program counts |
| POST | `/match` | `{m3u, xmltv}` | matched channels + programs |
| POST | `/play` | `{url}` | launches VLC |
| POST | `/stop` | — | stops VLC |
| GET | `/health` | — | ok |

## Dev

Zero runtime dependencies (Node built-ins only). Parse/match logic mirrors the
Lua extension (`src/vlc_epg.lua`); keep the two in sync when changing matching
rules.
