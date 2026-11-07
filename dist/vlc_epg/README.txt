VLC EPG (IPTV) - single-folder install
=========================================

WHAT THIS IS
  A VLC 3.0.x extension + a companion web TV-guide UI. The Lua extension
  fills VLC's playlist columns (now/next, genre, synopsis) and opens the web
  UI (grid, favorites, search, web player) in your browser.

INSTALL (drag-and-drop)
  1. Quit VLC completely.
  2. Copy THIS ENTIRE folder (vlc_epg) into VLC's user extensions folder:
        Windows: %APPDATA%\vlc\lua\extensions\
        Linux:   ~/.local/share/vlc/lua/extensions/
        macOS:   ~/Library/Application Support/org.videolan.vlc/lua/extensions/
     So the result is ...\extensions\vlc_epg\vlc_epg.lua
  3. Restart VLC. Open View -> VLC EPG (IPTV) (Windows/Linux) or
     VLC -> Extensions -> VLC EPG (IPTV) (macOS).
  4. The extension finds the bundled web/ folder next to itself and starts the
     server automatically (requires Node.js installed). No paths to set up.

REQUIREMENTS
  - VLC 3.0.x
  - Node.js (>= 16) on PATH for the web UI
  - For the Lua-side EPG (playlist columns) you can also use the legacy dialog.

CUSTOMIZING THE LOOK
  Edit web/public/theme.css - colors are CSS variables in one :root block.
  Layout/component rules are in web/public/style.css.

More docs + source: see the repository README.md
