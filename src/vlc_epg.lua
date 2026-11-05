--[[
  VLC EPG for IPTV (single-file extension for VLC 3.0.x)

  Loads an M3U playlist (local file or HTTP/HTTPS URL) plus an XMLTV EPG
  guide, then loads the channels into VLC's own playlist and fills the
  playlist columns with program information:
      Description = running program (bold) + upcoming ones
      Genre       = category of the running program
      Album       = synopsis of the running program
      Author      = channel group
  It also shows an on-screen display (OSD) "now / next" popup whenever you
  switch to a channel that has guide data.

  To see the columns: right-click the playlist column header and enable
  Description, Genre, Album, Author.

  Install: copy this file to VLC's lua/extensions folder (Windows:
  %APPDATA%\vlc\lua\extensions), fully restart VLC, then open it from
  the View menu.  License: MIT.
]]

-----------------------------------------------------------------------------
-- Constants
-----------------------------------------------------------------------------
local CFG_NAME       = "vlc_epg.cfg"
local CACHE_NAME     = "vlc_epg_cache.txt"
local EPG_TTL        = 6 * 3600
local WINDOW_BEHIND  = 3600            -- keep programs that ended < 1h ago
local WINDOW_AHEAD   = 36 * 3600       -- keep programs starting within 36h
local OSD_DURATION   = 7000000         -- microseconds
local MAX_PROGRAMS   = 10
local SEPARATOR      = "  ||  "
local GENRE_FROM_CATEGORY = true
local ALBUM_FROM_SYNOPSIS = true
local OSD_SYNOPSIS_CHARS  = 160
local BOLD_CURRENT   = true

local DISPLAY_OPTIONS = {
  { id = 1, label = "2 programs",    mode = "count", n = 2  },
  { id = 2, label = "3 programs",    mode = "count", n = 3  },
  { id = 3, label = "5 programs",    mode = "count", n = 5  },
  { id = 4, label = "Next 2 hours",  mode = "hours", n = 2  },
  { id = 5, label = "Next 4 hours",  mode = "hours", n = 4  },
  { id = 6, label = "Next 8 hours",  mode = "hours", n = 8  },
  { id = 7, label = "Next 12 hours", mode = "hours", n = 12 },
}
local DEFAULT_DISPLAY = 3

-- Location of the companion web UI (Node server). Overridable in config.
local DEFAULT_WEB_DIR = "I:/AI/vlc-epg/epg-web"
local WEB_PORT = 8123
local WEB_URL = "http://127.0.0.1:" .. WEB_PORT

-- Built lazily (not at load time): VLC's extension *scan* runs the script in
-- a bare Lua state with no standard library, so top-level code must not call
-- functions like ipairs(). Runtime environment has the full library.
local DISPLAY_BY_ID
local function display_by_id()
  if not DISPLAY_BY_ID then
    DISPLAY_BY_ID = {}
    for i = 1, #DISPLAY_OPTIONS do
      local o = DISPLAY_OPTIONS[i]
      DISPLAY_BY_ID[o.id] = o
    end
  end
  return DISPLAY_BY_ID
end

-----------------------------------------------------------------------------
-- State
-----------------------------------------------------------------------------
local state = {
  m3u = "",
  epg = "",
  web_dir = DEFAULT_WEB_DIR,
  header_epg = nil,
  channels = {},
  groups = {},
  by_url = {},
  progs = {},
  name_map = {},
  osd = nil,
  guide_note = "",
  stats = { id = 0, name = 0 },
  display = DEFAULT_DISPLAY,
}
local ui = {}

-----------------------------------------------------------------------------
-- Small helpers
-----------------------------------------------------------------------------
local function trim(s)
  return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

local function data_path(name)
  return vlc.config.userdatadir() .. "/" .. name
end

local function is_windows()
  return package.config:sub(1, 1) == "\\"
end

local function shell_quote(s)
  if s:match("[^%w_%-%./:\\\\=@,]") then
    return "'" .. s:gsub("'", "'\\''") .. "'"
  end
  return s
end

local function native_path(p)
  if is_windows() then return p:gsub("/", "\\") end
  return p
end

local function run_shell(cmd)
  local ok = os.execute(cmd)
  return ok, (ok == true and 0 or 1)
end

local function expand_home(src)
  if src:sub(1, 1) == "~" then
    local home = os.getenv("HOME") or os.getenv("USERPROFILE") or ""
    return home .. src:sub(2)
  end
  return src
end

local function is_readable(path)
  local f = io.open(path, "rb")
  if not f then return false end
  f:close()
  return true
end

local function first_line_of(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local line = f:read("*l")
  f:close()
  line = trim(line or "")
  if line == "" then return nil end
  return line
end

-----------------------------------------------------------------------------
-- UTF-8 helpers (for fake-bold in the Description column)
-----------------------------------------------------------------------------
local function utf8_char(cp)
  if cp > 1114111 then return "?" end
  if cp < 128 then return string.char(cp) end
  local bytes = {}
  if cp < 0x800 then
    bytes[1] = 0xC0 + math.floor(cp / 0x40)
    bytes[2] = 0x80 + (cp % 0x40)
  elseif cp < 0x10000 then
    bytes[1] = 0xE0 + math.floor(cp / 0x1000)
    bytes[2] = 0x80 + math.floor((cp % 0x1000) / 0x40)
    bytes[3] = 0x80 + (cp % 0x40)
  else
    bytes[1] = 0xF0 + math.floor(cp / 0x40000)
    bytes[2] = 0x80 + math.floor((cp % 0x40000) / 0x1000)
    bytes[3] = 0x80 + math.floor((cp % 0x1000) / 0x40)
    bytes[4] = 0x80 + (cp % 0x40)
  end
  return string.char(unpack(bytes))
end

local BOLD = {
  ["a"] = 0x1D5EE, ["A"] = 0x1D5D4,
  ["b"] = 0x1D5EF, ["B"] = 0x1D5D5,
  ["c"] = 0x1D5F0, ["C"] = 0x1D5D6,
  ["d"] = 0x1D5F1, ["D"] = 0x1D5D7,
  ["e"] = 0x1D5F2, ["E"] = 0x1D5D8,
  ["f"] = 0x1D5F3, ["F"] = 0x1D5D9,
  ["g"] = 0x1D5F4, ["G"] = 0x1D5DA,
  ["h"] = 0x1D5F5, ["H"] = 0x1D5DB,
  ["i"] = 0x1D5F6, ["I"] = 0x1D5DC,
  ["j"] = 0x1D5F7, ["J"] = 0x1D5DD,
  ["k"] = 0x1D5F8, ["K"] = 0x1D5DE,
  ["l"] = 0x1D5F9, ["L"] = 0x1D5DF,
  ["m"] = 0x1D5FA, ["M"] = 0x1D5E0,
  ["n"] = 0x1D5FB, ["N"] = 0x1D5E1,
  ["o"] = 0x1D5FC, ["O"] = 0x1D5E2,
  ["p"] = 0x1D5FD, ["P"] = 0x1D5E3,
  ["q"] = 0x1D5FE, ["Q"] = 0x1D5E4,
  ["r"] = 0x1D5FF, ["R"] = 0x1D5E5,
  ["s"] = 0x1D600, ["S"] = 0x1D5E6,
  ["t"] = 0x1D601, ["T"] = 0x1D5E7,
  ["u"] = 0x1D602, ["U"] = 0x1D5E8,
  ["v"] = 0x1D603, ["V"] = 0x1D5E9,
  ["w"] = 0x1D604, ["W"] = 0x1D5EA,
  ["x"] = 0x1D605, ["X"] = 0x1D5EB,
  ["y"] = 0x1D606, ["Y"] = 0x1D5EC,
  ["z"] = 0x1D607, ["Z"] = 0x1D5ED,
  ["0"] = 0x1D7EC, ["1"] = 0x1D7ED,
  ["2"] = 0x1D7EE, ["3"] = 0x1D7EF,
  ["4"] = 0x1D7F0, ["5"] = 0x1D7F1,
  ["6"] = 0x1D7F2, ["7"] = 0x1D7F3,
  ["8"] = 0x1D7F4, ["9"] = 0x1D7F5,
}

local function to_bold(s)
  return (s:gsub("[%w]", function(c)
    local m = BOLD[c]
    if m then return utf8_char(m) end
    return c
  end))
end

-----------------------------------------------------------------------------
-- Time handling (XMLTV timestamps -> UTC epoch, independent of local TZ)
-----------------------------------------------------------------------------
local function parse_xmltv_time(input)
  input = trim(tostring(input or ""))
  local date, offset = input:match("^(%d%d%d%d%d%d%d%d%d%d%d%d%d%d)(.*)$")
  if not date then return nil end
  local y = tonumber(date:sub(1, 4))
  local mo = tonumber(date:sub(5, 6))
  local d = tonumber(date:sub(7, 8))
  local h = tonumber(date:sub(9, 10))
  local mi = tonumber(date:sub(11, 12))
  -- days since epoch (civil algorithm)
  local function days_from_civil(yy, mm, dd)
    yy = yy - (mm <= 2 and 1 or 0)
    local era = math.floor((yy >= 0 and yy or yy - 399) / 400)
    local yoe = yy - era * 400
    local doy = math.floor((153 * (mm + (mm > 2 and -3 or 9)) + 2) / 5) + dd - 1
    local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
    return era * 146097 + doe - 719468
  end
  local epoch = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60
  -- offset e.g. "+0100" or "+01:00" or "Z"
  offset = trim(offset)
  if offset and offset ~= "" then
    local sign, oh, om = offset:match("^([%+%-])(%d%d):?(%d%d)$")
    if sign then
      local s = sign == "-" and -1 or 1
      epoch = epoch - s * (tonumber(oh) * 3600 + tonumber(om) * 60)
    end
  end
  return epoch
end

local function fmt_time(epoch)
  return os.date("%H:%M", epoch)
end

-----------------------------------------------------------------------------
-- Channel-name / id normalization
-----------------------------------------------------------------------------
local QUALITY_WORDS = {
  "fhd", "hd", "uhd", "4k", "2k", "8k", "sd", "hq", "720p", "360p",
  "480p", "576p", "1080p", "2160p", "plus1", "+1", "latin", "mex", "bar",
}

local function canon_id(id)
  -- "ATV.tr@SD" -> "atvtr" (drops quality suffix and inner quality words)
  local base = id:match("^(.*)@[^@]*$") or id
  local parts = {}
  for tok in base:lower():gmatch("[%w]+") do
    local is_quality = false
    for _, w in ipairs(QUALITY_WORDS) do
      if tok == w then is_quality = true break end
    end
    if not is_quality then parts[#parts + 1] = tok end
  end
  return table.concat(parts)
end

local function normalize(s)
  local parts = {}
  for tok in (s or ""):lower():gmatch("[%w]+") do
    local is_quality = false
    for _, w in ipairs(QUALITY_WORDS) do
      if tok == w then is_quality = true break end
    end
    if not is_quality then parts[#parts + 1] = tok end
  end
  return table.concat(parts, " ")
end

local function normalize_loose(s)
  s = (s or ""):lower()
  s = s:gsub("[^%w]", "")
  return s
end

-----------------------------------------------------------------------------
-- Configuration
-----------------------------------------------------------------------------
local function load_config()
  local f = io.open(data_path(CFG_NAME), "r")
  if not f then return end
  for line in f:lines() do
    local k, v = line:match("^([%w_]+)=(.*)$")
    if k == "m3u" then state.m3u = trim(v) end
    if k == "epg" then state.epg = trim(v) end
    if k == "web_dir" and v ~= "" then state.web_dir = trim(v) end
    if k == "display" then
      local id = tonumber(v)
      if id and display_by_id()[id] then state.display = id end
    end
  end
  f:close()
end

local function save_config()
  local f = io.open(data_path(CFG_NAME), "w")
  if not f then return false end
  f:write("m3u=", state.m3u, "\n")
  f:write("epg=", state.epg, "\n")
  f:write("web_dir=", state.web_dir, "\n")
  f:write("display=", state.display, "\n")
  f:close()
  return true
end

-----------------------------------------------------------------------------
-- M3U parsing (line iterator based, pure & testable)
-----------------------------------------------------------------------------
local function get_attr(line, name)
  return line:match("[%s]" .. name .. "=\"([^\"]*)\"")
      or line:match("^" .. name .. "=\"([^\"]*)\"")
end

local function decode_text(s)
  if not s then return "" end
  s = s:gsub("&amp;", "&")
  s = s:gsub("&lt;", "<")
  s = s:gsub("&gt;", ">")
  s = s:gsub("&quot;", '"')
  s = s:gsub("&#39;", "'")
  s = s:gsub("&apos;", "'")
  s = s:gsub("&#(%d+);", function(n) return utf8_char(tonumber(n)) end)
  s = s:gsub("&(%w+);", "&%1;")
  return s
end

local function clean_field(s, maxlen)
  s = trim(decode_text(s))
  if maxlen and #s > maxlen then s = s:sub(1, maxlen - 1) .. "…" end
  return s
end

local function parse_m3u_lines(iter, info)
  local channels, groups, by_url, header_epg = {}, {}, {}, nil
  local pending = nil
  local lines = 0
  for line in iter do
    lines = lines + 1
    if not info.first and trim(line) ~= "" then info.first = trim(line):sub(1, 60) end
    if line:sub(1, 7) == "#EXTM3U" then
      local u = get_attr(line, "url%-tvg")
            or get_attr(line, "x%-tvg%-url")
            or get_attr(line, "tvg%-url")
      if u and u ~= "" then
        local cand = trim(u:match("^[^,]+") or "")
        if cand ~= "" then header_epg = cand end
      end
    elseif line:sub(1, 8) == "#EXTINF:" then
      local body = line:sub(9)
      local name = body:match("^[^,]*,(.*)$")
      pending = {
        name = clean_field(name, 200),
        tvg_id = get_attr(body, "tvg%-id") or "",
        group = get_attr(body, "group%-title") or "",
        logo = get_attr(body, "tvg%-logo") or "",
        tvg_name = get_attr(body, "tvg%-name") or "",
        url = nil,
      }
      if pending.name == "" then pending.name = pending.tvg_name end
      if pending.group == "" then
        local g = body:match("group%-title=\"([^\"]*)\"") or body:match("group-title=(%S+)")
        if g then pending.group = trim(g) end
      end
      pending.group = clean_field(pending.group, 100)
    elseif line:sub(1, 1) ~= "#" and trim(line) ~= "" then
      local url = trim(line)
      if pending then
        pending.url = url
        if pending.name == "" then
          local base = url:match("([^/]+)$") or url
          pending.name = clean_field(base:gsub("%.m3u8?$", ""):gsub("[_%%+]", " "), 200)
        end
        local ch = pending
        channels[#channels + 1] = ch
        if ch.group ~= "" then groups[ch.group] = true end
        by_url[url] = ch
        pending = nil
      elseif url:match("^%a[%w+.-]*://") then
        local base = url:match("([^/]+)$") or url
        local ch = {
          name = clean_field(base:gsub("%.m3u8?$", ""):gsub("[_%%+]", " "), 200),
          tvg_id = "", group = "", logo = "", tvg_name = "", url = url,
        }
        channels[#channels + 1] = ch
        by_url[url] = ch
      end
    end
  end
  info.lines = lines
  return channels, groups, by_url, header_epg
end

local function parse_m3u_stream(s, info)
  local iter
  if s.readline then
    iter = function() return s:readline() end
  else
    local lines = {}
    for ln in s:gmatch("[^\r\n]+") do lines[#lines + 1] = ln end
    local i = 0
    iter = function() i = i + 1; return lines[i] end
  end
  return parse_m3u_lines(iter, info or {})
end

-----------------------------------------------------------------------------
-- XMLTV parsing (streaming, keeps only channels the playlist wants)
-----------------------------------------------------------------------------
local function build_wanted()
  local wanted, keys = {}, {}
  for _, ch in ipairs(state.channels) do
    if ch.tvg_id ~= "" then
      wanted[ch.tvg_id] = true
      keys["i:" .. canon_id(ch.tvg_id)] = true
    end
    if ch.tvg_name ~= "" then keys["n:" .. normalize(ch.tvg_name)] = true end
    if ch.name ~= "" then
      keys["n:" .. normalize(ch.name)] = true
      keys["l:" .. normalize_loose(ch.name)] = true
    end
  end
  return wanted, keys
end

local function parse_epg_stream(s, wanted, keys)
  local progs, name_map = {}, {}
  local lo = os.time() - WINDOW_BEHIND
  local hi = os.time() + WINDOW_AHEAD
  local count = 0

  local function handle_channel(tag)
    local id = get_attr(tag, "id")
    if id then
      name_map["i:" .. canon_id(id)] = id
      for dn in tag:gmatch("<display%-name[^>]*>(.-)</display%-name>") do
        local text = decode_text(dn)
        name_map["n:" .. normalize(text)] = id
        name_map["l:" .. normalize_loose(text)] = id
      end
    end
  end

  local function handle_programme(tag)
    local ch = get_attr(tag, "channel")
    if ch and (wanted[ch] or keys["i:" .. canon_id(ch)]) then
      local st = parse_xmltv_time(get_attr(tag, "start"))
      local en = parse_xmltv_time(get_attr(tag, "stop"))
      if st and en and en > lo and st < hi then
        local title = tag:match("<title[^>]*>(.-)</title>")
        local desc = tag:match("<desc[^>]*>(.-)</desc>")
        local category = tag:match("<category[^>]*>(.-)</category>")
        local list = progs[ch]
        if not list then list = {}; progs[ch] = list end
        list[#list + 1] = {
          start = st,
          stop = en,
          title = clean_field(title, 200),
          desc = clean_field(desc, 400),
          cat = clean_field(category, 60),
        }
        count = count + 1
      end
    end
  end

  -- Buffer-based scanner: accumulate text, pull out complete <channel> and
  -- <programme> elements (opening tag through matching closing tag).
  local buf = ""
  local bytes = 0

  local function feed(text)
    buf = buf .. text
    bytes = bytes + #text
    while true do
      local open_start, open_end = buf:find("<channel[ >]")
      local prog_start, prog_end = buf:find("<programme[ >]")
      local os_ = open_start or math.huge
      local ps_ = prog_start or math.huge
      local first = math.min(os_, ps_)
      if first == math.huge then break end
      local is_channel = (os_ <= ps_)
      local close_tag = is_channel and "</channel>" or "</programme>"
      local close_start, close_end = buf:find(close_tag, first)
      if not close_start then
        -- element not complete yet; keep buffering
        break
      end
      local element = buf:sub(open_start or prog_start, close_end)
      if is_channel then handle_channel(element) else handle_programme(element) end
      buf = buf:sub(close_end + 1)
    end
    -- avoid unbounded growth: drop leading cruft before the oldest open tag
    local earliest = buf:find("<channel[ >]") or buf:find("<programme[ >]")
    if earliest and earliest > 65536 then buf = buf:sub(earliest) end
  end

  if s.read then
    local bufsize = 65536
    while true do
      local part = s:read(bufsize)
      if not part or part == "" then break end
      feed(part)
    end
  else
    feed(s)
  end

  if bytes == 0 then return nil, nil, "empty" end
  for _, list in pairs(progs) do
    table.sort(list, function(a, b) return a.start < b.start end)
  end
  return progs, name_map
end

-----------------------------------------------------------------------------
-- Stream / file open
-----------------------------------------------------------------------------
local function wrap_file(f)
  return {
    read = function(_, n) return f:read(n) end,
    readline = function() return f:read("*l") end,
    close = function() f:close() end,
  }
end

local function open_stream(src)
  src = expand_home(src)
  if src:match("^%a[%w+.-]*://") then
    local st = vlc.stream(src)
    if st then return st end
    return nil, "VLC could not open " .. src
  end
  local f, err = io.open(src, "rb")
  if f then return wrap_file(f) end
  local st = vlc.stream(vlc.strings.make_uri(src))
  if st then return st end
  return nil, tostring(err or ("cannot open " .. src))
end

local shell_fetch

local function set_status(text)
  if ui.status then
    ui.status:set_text(text)
    if ui.dialog then ui.dialog:update() end
  end
end

-----------------------------------------------------------------------------
-- Shell fetch fallback (curl / powershell)
-----------------------------------------------------------------------------
local function is_gzip_file(path)
  local f = io.open(path, "rb")
  if not f then return false end
  local magic = f:read(2)
  f:close()
  return magic == "\1\139"
end

shell_fetch = function(src)
  if not (os and os.execute) then
    return nil, "Shell commands are not available in this VLC"
  end
  local win = is_windows()
  local tmp = native_path(data_path("vlc_epg_download.tmp"))
  local out = native_path(data_path("vlc_epg_download.xml"))
  local errfile = native_path(data_path("vlc_epg_download.err"))
  os.remove(tmp)
  os.remove(out)
  os.remove(errfile)

  local ok, code
  if src:match("^https?://") then
    local curl = win and "curl.exe" or "curl"
    ok, code = run_shell(curl .. " -fsSL --max-time 180 -o " .. shell_quote(tmp)
                         .. " " .. shell_quote(src) .. " 2>" .. shell_quote(errfile))
  elseif win then
    ok, code = run_shell("copy /Y " .. shell_quote(native_path(expand_home(src)))
                         .. " " .. shell_quote(tmp) .. " >nul 2>" .. shell_quote(errfile))
  else
    ok, code = run_shell("cp " .. shell_quote(expand_home(src)) .. " " .. shell_quote(tmp)
                         .. " 2>" .. shell_quote(errfile))
  end

  if not is_readable(tmp) then
    local reason = first_line_of(errfile) or ("exit code " .. tostring(code))
    os.remove(errfile)
    return nil, "download failed (" .. reason .. ")"
  end
  os.remove(errfile)

  if is_gzip_file(tmp) then
    local gok, gcode
    if win then
      local ps_quote = function(path) return (path:gsub("'", "''")) end
      local script = "$i=[IO.File]::OpenRead('" .. ps_quote(tmp) .. "');"
        .. "$g=New-Object IO.Compression.GZipStream($i,[IO.Compression.CompressionMode]::Decompress);"
        .. "$o=[IO.File]::Create('" .. ps_quote(out) .. "');"
        .. "$g.CopyTo($o);$o.Close();$g.Close();$i.Close()"
      gok, gcode = run_shell('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "'
                           .. script .. '"')
    else
      gok, gcode = run_shell("gzip -dc " .. shell_quote(tmp) .. " > " .. shell_quote(out))
    end
    os.remove(tmp)
    if not is_readable(out) then
      return nil, "could not decompress the guide (exit code " .. tostring(gcode) .. ")"
    end
    return out
  end
  return tmp
end

-----------------------------------------------------------------------------
-- Guide cache
-----------------------------------------------------------------------------
local function playlist_signature()
  local MOD = 2147483629
  local h = 7
  local function add(str)
    for i = 1, #str do h = (h * 31 + str:byte(i)) % MOD end
  end
  for _, ch in ipairs(state.channels) do
    add(ch.url or "")
    add("\0")
    add(ch.tvg_id or "")
    add("\0")
    add(ch.name or "")
  end
  return h
end

local function flat(s)
  return (s:gsub("[\r\n\t]", " "))
end

local function save_cache(src, sig, progs, name_map)
  local f = io.open(data_path(CACHE_NAME), "w")
  if not f then return end
  f:write("#v3\t", os.time(), "\t", flat(src), "\t", sig, "\n")
  for n, id in pairs(name_map) do
    f:write("N\t", flat(n), "\t", id, "\n")
  end
  for id, list in pairs(progs) do
    for _, p in ipairs(list) do
      f:write("P\t", id, "\t", p.start, "\t", p.stop, "\t",
               flat(p.title), "\t", flat(p.desc), "\t", flat(p.cat), "\n")
    end
  end
  f:close()
end

local function load_cache(src, sig, channels)
  local wanted = {}
  for _, ch in ipairs(channels) do
    if ch.tvg_id ~= "" then wanted[ch.tvg_id] = true end
  end
  local f = io.open(data_path(CACHE_NAME), "r")
  if not f then return end
  local line = f:read("*l")
  local ts, cached_src, cached_sig
  if line and line:sub(1, 4) == "#v3" then
    ts, cached_src, cached_sig = line:match("^#v3\t(%d+)\t(.-)\t(%d+)$")
  end
  if not ts or cached_src ~= flat(src) or tonumber(cached_sig) ~= sig then
    f:close()
    return
  end
  local progs, name_map = {}, {}
  for l in f:lines() do
    local kind = l:sub(1, 1)
    if kind == "N" then
      local n, id = l:match("^N\t([^\t]*)\t(.*)$")
      if n then name_map[n] = id end
    elseif kind == "P" then
      local id, st, en, title, desc, cat =
        l:match("^P\t([^\t]*)\t(%d+)\t(%d+)\t(.-)\t(.-)\t(.*)$")
      if id and wanted[id] then
        local list = progs[id]
        if not list then list = {}; progs[id] = list end
        list[#list + 1] = {
          start = tonumber(st), stop = tonumber(en),
          title = title, desc = desc, cat = cat,
        }
      end
    end
  end
  f:close()
  for _, list in pairs(progs) do
    table.sort(list, function(a, b) return a.start < b.start end)
  end
  return progs, name_map, tonumber(ts)
end

-----------------------------------------------------------------------------
-- Guide matching
-----------------------------------------------------------------------------
local function apply_epg()
  local progs, map = state.progs, state.name_map
  state.stats = { id = 0, name = 0 }
  for _, ch in ipairs(state.channels) do
    local id, how = nil, nil
    if ch.tvg_id ~= "" then
      if progs[ch.tvg_id] then
        id, how = ch.tvg_id, "id"
      else
        local m = map["i:" .. canon_id(ch.tvg_id)]
        if m and progs[m] then id, how = m, "id" end
      end
    end
    if not id and ch.name ~= "" then
      local m = map["n:" .. normalize(ch.name)]
      if m and progs[m] then id, how = m, "name" end
    end
    if not id and ch.name ~= "" then
      local m = map["l:" .. normalize_loose(ch.name)]
      if m and progs[m] then id, how = m, "name" end
    end
    ch.epg = id
    if how then state.stats[how] = state.stats[how] + 1 end
  end
end

local function now_next(ch, t)
  if not ch.epg then return nil, nil end
  local list = state.progs[ch.epg]
  if not list then return nil, nil end
  for i = 1, #list do
    local p = list[i]
    if p.stop > t then
      if p.start <= t then return p, list[i + 1] end
      return nil, p
    end
  end
  return nil, nil
end

-----------------------------------------------------------------------------
-- Guide fetch/load
-----------------------------------------------------------------------------
local function fetch_epg(src)
  local s, oerr = open_stream(src)
  local progs, name_map, err
  if s then
    local wanted, keys = build_wanted()
    progs, name_map, err = parse_epg_stream(s, wanted, keys)
  end
  if progs then return progs, name_map end
  if s == nil or err == "empty" then
    set_status("Fetching guide with curl...")
    local path, serr = shell_fetch(src)
    if not path then return nil, serr end
    local s2 = open_stream(path)
    if not s2 then
      os.remove(path)
      return nil, "Cannot open the downloaded guide"
    end
    local wanted, keys = build_wanted()
    local p2, n2, e2 = parse_epg_stream(s2, wanted, keys)
    os.remove(path)
    s2:close()
    if p2 then return p2, n2 end
    if e2 == "empty" then return nil, "guide is empty or not XMLTV" end
    return nil, "could not parse guide"
  end
  return nil, err or oerr or "could not read guide"
end

local function guide_summary()
  local matched, programs = 0, 0
  for _, ch in ipairs(state.channels) do
    if ch.epg then matched = matched + 1 end
  end
  for _, list in pairs(state.progs) do programs = programs + #list end
  if programs == 0 then
    return "guide: no programs found for your channels (check tvg-id values / guide source)"
  end
  local st = state.stats or { id = 0, name = 0 }
  return string.format("guide: %d programs, %d of %d channels matched (%d by id, %d by name)",
                       programs, matched, #state.channels, st.id, st.name)
end

local function parse_m3u(src)
  local s, serr = open_stream(src)
  local info = {}
  if s then
    local channels, groups, by_url, header_epg = parse_m3u_stream(s, info)
    s:close()
    return channels, groups, by_url, header_epg, info
  end
  return nil, serr or ("cannot open " .. src)
end

local function load_into_playlist(force)
  local ok, channels, groups, by_url, header_epg, info = pcall(parse_m3u, state.m3u)
  if not ok then
    set_status("Playlist failed: " .. tostring(channels))
    return
  end
  if not channels then
    set_status(tostring(groups))
    return
  end
  if #channels == 0 then
    if info.lines == 0 then
      set_status("No channels found. The address returned no data.")
    else
      set_status("No channels found. First line: \"" .. tostring(info.first) .. "\"")
    end
    return
  end

  state.channels = channels
  state.groups = groups
  state.by_url = by_url
  state.header_epg = header_epg
  state.guide_note = ""

  -- resolve guide source
  local src = state.epg
  if src == "" then src = state.header_epg or "" end
  if src == "" then
    state.progs, state.name_map = {}, {}
    apply_epg()
    state.guide_note = "no guide source set (enter an XMLTV URL)"
  else
    local cache_used = false
    local sig = playlist_signature()
    if not force then
      local cp, cn, _ = load_cache(src, sig, channels)
      if cp then
        state.progs, state.name_map = cp, cn
        apply_epg()
        state.guide_note = "guide (cached). " .. guide_summary()
        cache_used = true
      end
    end
    if not cache_used then
      set_status("Fetching guide...")
      local p, n, err = pcall(fetch_epg, src)
      if ok and p then
        state.progs, state.name_map = p, n
        save_cache(src, sig, p, n)
        apply_epg()
        state.guide_note = guide_summary()
      else
        apply_epg()
        state.guide_note = "guide failed: " .. tostring(ok and n or p)
      end
    end
  end

  -- build playlist items with metadata
  local items = {}
  for _, ch in ipairs(channels) do
    local item = {
      path = ch.url,
      name = ch.name,
      meta = {},
    }
    local t = os.time()
    local cur = now_next(ch, t)
    if cur then
      if GENRE_FROM_CATEGORY and cur.cat and cur.cat ~= "" then
        item.meta.genre = cur.cat
      end
      if ALBUM_FROM_SYNOPSIS and cur.desc and cur.desc ~= "" then
        item.meta.album = cur.desc
      end
    end
    items[#items + 1] = item
  end

  vlc.playlist.clear()
  vlc.playlist.add(items)

  local opt = display_by_id()[state.display] or display_by_id()[DEFAULT_DISPLAY]
  local msg = string.format("%d channels added (%s).", #items, opt.label)
  if state.guide_note ~= "" then msg = msg .. " " .. state.guide_note end
  set_status(msg)
end

-----------------------------------------------------------------------------
-- OSD
-----------------------------------------------------------------------------
local function osd_for(ch)
  if not ch then return end
  if not state.osd then state.osd = vlc.osd.channel_register() end
  local t = os.time()
  local cur, nxt = now_next(ch, t)
  local lines = {}
  lines[#lines + 1] = trim(ch.name)
  if cur then
    local head = string.format("NOW  %s-%s  %s", fmt_time(cur.start), fmt_time(cur.stop), cur.title)
    if cur.cat and cur.cat ~= "" then head = head .. "  [" .. cur.cat .. "]" end
    lines[#lines + 1] = head
    if cur.desc and cur.desc ~= "" then
      lines[#lines + 1] = cur.desc:sub(1, OSD_SYNOPSIS_CHARS)
    end
  else
    lines[#lines + 1] = "No program info available"
  end
  if nxt then
    lines[#lines + 1] = string.format("NEXT %s  %s", fmt_time(nxt.start), nxt.title)
  end
  vlc.osd.message(table.concat(lines, "\n"), state.osd, "top-left", OSD_DURATION)
end

-----------------------------------------------------------------------------
-- Dialog
-----------------------------------------------------------------------------
local function strip_quotes(s)
  s = trim(s)
  return (s:gsub('^"(.*)"$', "%1"):gsub("^'(.*)'$", "%1"))
end

local function read_fields()
  state.m3u = strip_quotes(ui.in_m3u:get_text())
  state.epg = strip_quotes(ui.in_epg:get_text())
  if ui.display then
    local id = ui.display:get_value()
    if type(id) == "number" and display_by_id()[id] then state.display = id end
  end
  save_config()
end

local function on_load()
  read_fields()
  load_into_playlist(false)
end

local function on_refresh()
  read_fields()
  load_into_playlist(true)
end

local function create_dialog()
  local d = vlc.dialog("VLC EPG (IPTV)")
  ui.dialog = d
  ui.status = d:add_label("Enter your playlist, then press Load.", 1, 1, 8, 1)
  d:add_label("Playlist: M3U file path or URL", 1, 2, 8, 1)
  ui.in_m3u = d:add_text_input(state.m3u, 1, 3, 8, 1)
  d:add_label("Guide: XMLTV file path or URL (optional)", 1, 4, 8, 1)
  ui.in_epg = d:add_text_input(state.epg, 1, 5, 8, 1)
  d:add_label("Show in Description:", 1, 6, 3, 1)
  ui.display = d:add_dropdown(4, 6, 5, 1)
  local current = state.display
  if not display_by_id()[current] then current = DEFAULT_DISPLAY end
  for _, o in ipairs(DISPLAY_OPTIONS) do
    ui.display:add_value(o.label, o.id)
  end
  d:add_button("Load into playlist", on_load, 1, 7, 4, 1)
  d:add_button("Re-download guide", on_refresh, 5, 7, 4, 1)
  d:add_button("Open Web EPG", on_open_web, 1, 8, 4, 1)
  d:add_button("Stop Web server", on_stop_web, 5, 8, 4, 1)
  d:update()
end

-----------------------------------------------------------------------------
-- Web UI launcher
-----------------------------------------------------------------------------
local function web_running()
  local tmp = native_path(data_path("vlc_web_probe.txt"))
  os.remove(tmp)
  run_shell('netstat -ano | findstr ":' .. WEB_PORT .. '" | findstr LISTENING > "' .. tmp .. '"')
  local f = io.open(tmp, "r")
  local line = f and f:read("*l") or ""
  if f then f:close() end
  os.remove(tmp)
  return line ~= ""
end

local function launch_web()
  local dir = native_path(state.web_dir)
  local srv = dir .. "\\server.js"
  local f = io.open(srv, "r")
  if not f then
    return false, "web UI not found at " .. state.web_dir .. " (set web_dir in vlc_epg.cfg)"
  end
  f:close()

  if not web_running() then
    if is_windows() then
      run_shell('start "" /D "' .. dir .. '" cmd /c "node server.js"')
    else
      run_shell('cd "' .. dir .. '" && nohup node server.js >/dev/null 2>&1 &')
    end
  end

  if is_windows() then
    run_shell('start "" "' .. WEB_URL .. '"')
  else
    run_shell('xdg-open "' .. WEB_URL .. '" >/dev/null 2>&1')
  end
  return true, WEB_URL
end

local function stop_web()
  if not is_windows() then return end
  run_shell('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ' .. WEB_PORT ..
            ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"')
end

local function on_open_web()
  local ok, msg = launch_web()
  if ui.status then ui.status:set_text(ok and ("Web EPG opened: " .. msg) or ("Web launch failed: " .. tostring(msg))) end
end

local function on_stop_web()
  stop_web()
  if ui.status then ui.status:set_text("Web server stopped.") end
end

-----------------------------------------------------------------------------
-- VLC extension entry points
-----------------------------------------------------------------------------
function descriptor()
  return {
    title = "VLC EPG (IPTV)",
    version = "1.1.0",
    author = "Hermes",
    shortdesc = "VLC EPG (IPTV)",
    description = "Loads an M3U playlist and an XMLTV guide; fills playlist columns and opens the Web EPG UI.",
    capabilities = { "input-listener" },
  }
end

function activate()
  load_config()
  -- Launch the Web EPG (starts the server if needed) — this
  -- is now the primary UI; the legacy playlist dialog is not shown.
  local ok, msg = launch_web()
  if not ok then
    -- fall back to the dialog only if the web UI is unavailable
    ui.status = nil
    create_dialog()
    if ui.status then ui.status:set_text("Web launch failed: " .. tostring(msg)) end
  end
end

function deactivate()
  if ui.dialog then pcall(function() ui.dialog:delete() end) end
  ui = {}
end

function close()
  vlc.deactivate()
end

function input_changed()
  pcall(function()
    local item = vlc.input.item()
    if not item then return end
    local uri = item:uri()
    local ch = state.by_url[uri]
    if not ch and vlc.strings and vlc.strings.decode_uri then
      ch = state.by_url[vlc.strings.decode_uri(uri)]
    end
    if ch then osd_for(ch) end
  end)
end

-- Test hook: when the module is loaded by the test harness (not by VLC),
-- return the internal functions for unit testing.  VLC ignores the return
-- value, so this is harmless in production.
if _TEST_INTERNALS then
  return {
    trim = trim,
    parse_xmltv_time = parse_xmltv_time,
    canon_id = canon_id,
    normalize = normalize,
    normalize_loose = normalize_loose,
    decode_text = decode_text,
    clean_field = clean_field,
    parse_m3u_lines = parse_m3u_lines,
    parse_epg_stream = parse_epg_stream,
    to_bold = to_bold,
    now_next = now_next,
    apply_epg = apply_epg,
    build_wanted = build_wanted,
    state = state,
  }
end
