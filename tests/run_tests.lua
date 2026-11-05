-- Test harness for vlc_epg.lua
-- Loads the extension with a mocked `vlc` global and exercises the pure
-- functions exposed via the _TEST_INTERNALS hook.  Run with:
--   lua tests/run_tests.lua src/vlc_epg.lua

local src_path = arg[1]
if not src_path then
  print("usage: lua tests/run_tests.lua src/vlc_epg.lua")
  os.exit(2)
end

-- ---- mock vlc global (enough for load-time) ----
vlc = {
  config = { userdatadir = function() return "." end },
  strings = { make_uri = function(s) return s end },
  stream = function() return nil end,
  playlist = { clear = function() end, add = function() end },
  osd = { channel_register = function() return {} end, message = function() end },
  input = { item = function() return nil end },
  dialog = function() return {} end,
  msg = { err = function() end, info = function() end },
  deactivate = function() end,
}

_TEST_INTERNALS = true
local mod = dofile(src_path)

local passed, failed = 0, 0
local function check(name, cond)
  if cond then
    passed = passed + 1
    print("  ok   " .. name)
  else
    failed = failed + 1
    print("  FAIL " .. name)
  end
end

local function section(t) print("\n== " .. t .. " ==") end

-- util
section("trim")
check("trim strips spaces", mod.trim("  hello  ") == "hello")
check("trim nil -> ''", mod.trim(nil) == "")

-- time
section("parse_xmltv_time")
-- 2025-11-05 12:00:00 UTC
check("parse UTC +0000", mod.parse_xmltv_time("20251105120000 +0000") == 1762344000)
check("parse Z", mod.parse_xmltv_time("20251105120000 Z") == 1762344000)
check("parse +0100 => 11:00 UTC", mod.parse_xmltv_time("20251105120000 +0100") == 1762340400)
check("parse -0500 => 17:00 UTC", mod.parse_xmltv_time("20251105120000 -0500") == 1762362000)
check("parse +01:00 colons", mod.parse_xmltv_time("20251105120000 +01:00") == 1762340400)
check("invalid returns nil", mod.parse_xmltv_time("not-a-date") == nil)

-- id/name normalization
section("normalization")
check("canon_id drops @SD", mod.canon_id("ATV.tr@SD") == "atvtr")
check("canon_id drops @HD", mod.canon_id("ATV.HD.tr") == "atvtr")
check("canon_id lowercase", mod.canon_id("CNN.us@SD") == "cnnus")
check("normalize strips quality words", mod.normalize("1+1 International HD") == "1 1 international")
check("normalize_loose", mod.normalize_loose("1+1 International") == "11international")

-- xml entities
section("decode_text")
check("entities", mod.decode_text("Fish &amp; Chips &lt;x&gt;") == "Fish & Chips <x>")
check("numeric entity", mod.decode_text("&#65;") == "A")

-- M3U parsing
section("parse_m3u_lines")
local m3u = [[
#EXTM3U url-tvg="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="CNN.us@SD" tvg-name="CNN" group-title="News",CNN
https://stream.example/cnn.m3u8
#EXTINF:-1 tvg-id="BBC.uk@HD" group-title="General",BBC One HD
https://stream.example/bbc.m3u8
#EXTINF:-1 tvg-logo="http://logo/x.png" group-title="Music",MTV
http://stream.example/mtv.m3u8
]]
local info = {}
local lines = {}
for ln in m3u:gmatch("[^\r\n]+") do lines[#lines+1] = ln end
local i = 0
local channels, groups, by_url, header_epg = mod.parse_m3u_lines(
  function() i = i + 1; return lines[i] end, info)

check("3 channels", #channels == 3)
check("header_epg picked up", header_epg == "https://example.com/epg.xml.gz")
check("ch1 tvg-id", channels[1].tvg_id == "CNN.us@SD")
check("ch1 name", channels[1].name == "CNN")
check("ch1 group", channels[1].group == "News")
check("ch2 name", channels[2].name == "BBC One HD")
check("ch3 group from attr", channels[3].group == "Music")
check("ch3 url", channels[3].url == "http://stream.example/mtv.m3u8")
check("by_url keyed", by_url["https://stream.example/cnn.m3u8"] == channels[1])
check("groups set", groups["News"] and groups["General"] and groups["Music"])

-- plain URL list (no EXTINF)
section("parse_m3u_lines plain list")
lines = { "https://a.example/x.m3u8", "https://b.example/y.m3u8" }
i = 0
local ch2 = mod.parse_m3u_lines(function() i = i + 1; return lines[i] end, {})
check("2 plain channels", #ch2 == 2)
check("derived name", ch2[1].name == "x")

-- XMLTV parsing (streaming over a big string with partial tags)
section("parse_epg_stream")
local now = os.time()
local function xmltime(ep) return os.date("!%Y%m%d%H%M%S", ep) .. " +0000" end
local wanted = { ["CNN.us@SD"] = true, ["BBC.uk@HD"] = true }
local keys = { ["i:cnnus"] = true, ["i:bbchuk"] = true, ["n:cnn"] = true }
local cnn1_s, cnn1_e = now - 3600, now + 3600   -- running now
local cnn2_s, cnn2_e = now + 3600, now + 7200   -- next
local bbc_s, bbc_e = now - 1800, now + 1800
local other_s, other_e = now - 1800, now + 1800
local xml = string.format([[
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <channel id="CNN.us@SD"><display-name>CNN</display-name></channel>
  <channel id="BBC.uk@HD"><display-name>BBC One HD</display-name></channel>
  <channel id="OTHER.xx@SD"><display-name>Other</display-name></channel>
  <programme start="%s" stop="%s" channel="CNN.us@SD">
    <title lang="en">Morning Show</title>
    <category lang="en">News</category>
    <desc lang="en">The latest headlines &amp; analysis.</desc>
  </programme>
  <programme start="%s" stop="%s" channel="CNN.us@SD">
    <title lang="en">Afternoon Report</title>
  </programme>
  <programme start="%s" stop="%s" channel="BBC.uk@HD">
    <title lang="en">Midday News</title>
  </programme>
  <programme start="%s" stop="%s" channel="OTHER.xx@SD">
    <title lang="en">Should Not Match</title>
  </programme>
</tv>
]], xmltime(cnn1_s), xmltime(cnn1_e),
   xmltime(cnn2_s), xmltime(cnn2_e),
   xmltime(bbc_s), xmltime(bbc_e),
   xmltime(other_s), xmltime(other_e))

-- feed in small chunks to exercise the streaming assembly
local pos = 1
local s = { read = function(_, n)
  if pos > #xml then return nil end
  local part = xml:sub(pos, pos + (n or 4096) - 1)
  pos = pos + #part
  return part
end }
local progs, name_map = mod.parse_epg_stream(s, wanted, keys)
check("progs has CNN", progs["CNN.us@SD"] ~= nil)
check("progs has BBC", progs["BBC.uk@HD"] ~= nil)
check("progs does NOT have OTHER", progs["OTHER.xx@SD"] == nil)
check("CNN has 2 programs", #progs["CNN.us@SD"] == 2)
local p1 = progs["CNN.us@SD"][1]
check("program1 title decoded", p1.title == "Morning Show")
check("program1 category", p1.cat == "News")
check("program1 desc decoded", p1.desc == "The latest headlines & analysis.")
check("program1 start parse", p1.start == cnn1_s - (cnn1_s % 60))
check("name_map id", name_map["i:cnnus"] == "CNN.us@SD")
check("name_map display-name", name_map["n:cnn"] == "CNN.us@SD")

-- now_next
section("now_next")
state = mod.state
state.progs = progs
local ch = { epg = "CNN.us@SD" }
local t = now + 1800  -- 30 min into the running Morning Show
local cur, nxt = mod.now_next(ch, t)
check("now_next current", cur.title == "Morning Show")
check("now_next next", nxt.title == "Afternoon Report")
local t2 = now - 7200  -- before any program starts
local cur2, nxt2 = mod.now_next(ch, t2)
check("now_next before start -> no current", cur2 == nil)
check("now_next before start -> next = Morning", nxt2.title == "Morning Show")

-- apply_epg matching
section("apply_epg")
state.name_map = name_map
state.channels = {
  { tvg_id = "CNN.us@SD", name = "CNN", epg = nil },
  { tvg_id = "BBC.uk@HD", name = "BBC One HD", epg = nil },
  { tvg_id = "ZZZ.xx@SD", name = "Zzz", epg = nil },
}
mod.apply_epg()
check("match by id (CNN)", state.channels[1].epg == "CNN.us@SD")
check("match by id (BBC)", state.channels[2].epg == "BBC.uk@HD")
check("no match for ZZZ", state.channels[3].epg == nil)
check("stats id matches = 2", state.stats.id == 2)

-- to_bold (round-trips via decode/simple check)
section("to_bold")
local bold = mod.to_bold("ABC")
check("bold produces non-ascii", bold:byte(1) > 127)

print(string.format("\n%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
