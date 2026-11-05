/**
 * VLC EPG Web UI — EPG grid companion.
 *
 * A zero-dependency Node server that:
 *   - serves a single-page EPG grid UI (read fresh from disk per request)
 *   - downloads/parses the M3U playlist and XMLTV guide (URL or local file),
 *     including gzip-compressed sources (.gz / Content-Encoding: gzip)
 *   - matches channels to programs (tvg-id cleaned, then name)
 *   - drives VLC playback: clicking a program launches vlc.exe with the
 *     stream URL (kills the previous instance so it behaves like channel
 *     switching)
 *
 * Run:  node server.js   →  http://127.0.0.1:8123
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8123;
const VLC = process.env.VLC_BIN || (
  process.platform === 'win32'
    ? 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'
    : 'vlc'
);
const MAX_BODY = 1 << 20;            // 1 MB request body cap
const FETCH_TIMEOUT = 30000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  return body;
}
function parseJSON(text) {
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

/* ------------------------------------------------------------------ */
/* Fetch (with gzip support, timeout and optional in-memory cache)    */
/* ------------------------------------------------------------------ */
function isGzipBuffer(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function fetchBuffer(src, timeoutMs = FETCH_TIMEOUT) {
  const isUrl = /^https?:\/\//i.test(src);
  if (!isUrl) {
    if (!fs.existsSync(src)) throw Object.assign(new Error('file not found: ' + src), { status: 404 });
    return fs.readFileSync(src);
  }
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(src, { signal: ctrl.signal })
      .then(async r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + src);
        return Buffer.from(await r.arrayBuffer());
      })
      .then(resolve)
      .catch(e => reject(e.name === 'AbortError'
        ? new Error('timeout fetching ' + src)
        : e))
      .finally(() => clearTimeout(timer));
  });
}

function decompress(buf) {
  if (isGzipBuffer(buf)) return zlib.gunzipSync(buf);
  return buf;
}

const fetchCache = new Map(); // url -> { ts, text }

/**
 * Fetch a source as text. For http(s) URLs, an optional ttlMs enables a
 * short in-memory cache so repeat loads of big playlists/guides are fast.
 */
async function fetchText(src, timeoutMs, ttlMs = 0) {
  const isUrl = /^https?:\/\//i.test(src);
  if (!isUrl) return decompress(await fetchBuffer(src, timeoutMs)).toString('utf8');
  if (ttlMs > 0) {
    const hit = fetchCache.get(src);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.text;
  }
  const text = decompress(await fetchBuffer(src, timeoutMs)).toString('utf8');
  if (ttlMs > 0) fetchCache.set(src, { ts: Date.now(), text });
  return text;
}

/* ------------------------------------------------------------------ */
/* M3U parser                                                          */
/* ------------------------------------------------------------------ */
function parseM3U(text) {
  const channels = [];
  const groups = {};
  let headerEpg = null;
  let pending = null;
  const lines = text.split(/\r?\n/);

  const attr = (line, name) => {
    const m = line.match(new RegExp('[\\s]' + name + '="([^"]*)"')) ||
              line.match(new RegExp('^' + name + '="([^"]*)"'));
    return m ? m[1] : '';
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      headerEpg = attr(line, 'url-tvg') || attr(line, 'x-tvg-url') || attr(line, 'tvg-url') || null;
    } else if (line.startsWith('#EXTINF:')) {
      const body = line.slice(8);
      const comma = body.indexOf(',');
      const name = comma >= 0 ? body.slice(comma + 1).trim() : '';
      pending = {
        name, tvg_id: attr(body, 'tvg-id') || '',
        group: attr(body, 'group-title') || '',
        logo: attr(body, 'tvg-logo') || '',
        tvg_name: attr(body, 'tvg-name') || '',
        url: null,
      };
      if (!pending.name) pending.name = pending.tvg_name;
    } else if (line.startsWith('#EXTGRP:') && pending) {
      // EXTGRP is a fallback for playlists that omit group-title on EXTINF
      if (!pending.group) pending.group = line.slice(8).trim();
    } else if (!line.startsWith('#') && pending) {
      pending.url = line;
      if (!pending.name) {
        const base = line.split('/').pop();
        pending.name = base.replace(/\.m3u8?$/i, '').replace(/[_%+]/g, ' ');
      }
      channels.push(pending);
      if (pending.group) groups[pending.group] = true;
      pending = null;
    }
  }
  return { channels, groupList: Object.keys(groups), headerEpg };
}

/* ------------------------------------------------------------------ */
/* XMLTV parser                                                        */
/* ------------------------------------------------------------------ */
const QUALITY = ['fhd','hd','uhd','4k','2k','8k','sd','hq','720p','360p','480p','576p','1080p','2160p','plus1','latin','mex','bar'];

function canonId(id) {
  const toks = id.replace(/@[^@]*$/, '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return toks.filter(t => !QUALITY.includes(t)).join('');
}
function normalize(s) {
  const toks = (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return toks.filter(t => !QUALITY.includes(t)).join(' ');
}
function loose(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse an XMLTV timestamp. Accepts:
 *   20240101120000 +0200      (with numeric offset)
 *   20240101120000 +02:00     (with colon offset)
 *   20240101120000            (no offset -> interpreted as UTC)
 * Returns epoch ms, or null if the string is unparseable.
 */
function xmltvTime(ts) {
  if (!ts) return null;
  const m = ts.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2}):?(\d{2})?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, sign, offH, offM] = m;
  const utc = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  if (!sign) return utc; // no offset given: assume UTC
  const off = (sign === '-' ? -1 : 1) * ((+(offH || 0)) * 3600 + (+(offM || 0)) * 60) * 1000;
  return utc - off;
}

const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

function parseXMLTV(text) {
  const channels = {};
  const programs = {};
  const nameMap = {};

  // Handles both <channel ...>...</channel> and self-closing <channel .../>
  const channelRe = /<channel\b([^>]*?)(?:\/>|>([\s\S]*?)<\/channel>)/g;
  let m;
  while ((m = channelRe.exec(text))) {
    const attrs = m[1];
    const body = m[2] || '';
    const id = (attrs.match(/id="([^"]*)"/) || [])[1];
    if (!id) continue;
    const ch = { id, displayNames: [], logos: [] };
    for (const dn of body.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)) ch.displayNames.push(dn[1]);
    for (const lg of body.matchAll(/<icon[^>]*src="([^"]*)"/g)) ch.logos.push(lg[1]);
    channels[id] = ch;
    nameMap['i:' + canonId(id)] = id;
    for (const dn of ch.displayNames) { nameMap['n:' + normalize(dn)] = id; nameMap['l:' + loose(dn)] = id; }
  }

  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  while ((m = progRe.exec(text))) {
    const attrs = m[1];
    const body = m[2];
    const chId = (attrs.match(/channel="([^"]*)"/) || [])[1];
    if (!chId) continue;
    const start = xmltvTime((attrs.match(/start="([^"]*)"/) || [])[1] || '');
    const stop = xmltvTime((attrs.match(/stop="([^"]*)"/) || [])[1] || '');
    if (!start || !stop) continue;
    const title = ((body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const desc = ((body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || '').trim();
    const cat = ((body.match(/<category[^>]*>([\s\S]*?)<\/category>/) || [])[1] || '').trim();
    const icon = ((body.match(/<icon[^>]*src="([^"]*)"/) || [])[1] || '').trim();
    const sub = ((body.match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/) || [])[1] || '').trim();
    const year = ((body.match(/<date[^>]*>([\s\S]*?)<\/date>/) || [])[1] || '').trim();
    const lang = (title.match(/\blang="([^"]*)"/) || [])[1] || '';
    const rating = ((body.match(/<rating[^>]*>([\s\S]*?)<\/rating>/) || [])[1] || '').trim();
    const ratingVal = ((rating.match(/<value>([\s\S]*?)<\/value>/) || [])[1] || '').trim();
    const episodeNums = [];
    for (const en of body.matchAll(/<episode-num\b([^>]*)>([\s\S]*?)<\/episode-num>/g)) {
      episodeNums.push({ system: (en[1].match(/system="([^"]*)"/) || [])[1] || '', num: en[2].trim() });
    }
    const directors = [], actors = [];
    for (const d of body.matchAll(/<director[^>]*>([\s\S]*?)<\/director>/g)) directors.push(d[1].trim());
    for (const a of body.matchAll(/<actor[^>]*>([\s\S]*?)<\/actor>/g)) actors.push(a[1].trim());
    const audio = [];
    for (const au of body.matchAll(/<audio[^>]*>([\s\S]*?)<\/audio>/g)) {
      for (const sub of au[1].matchAll(/<([a-z-]+)[^>]*>([\s\S]*?)<\/\1>/g)) audio.push(sub[2].trim());
    }
    (programs[chId] = programs[chId] || []).push({
      start, stop, title: dec(title), desc: dec(desc), cat: dec(cat), icon: dec(icon),
      sub: dec(sub), year: dec(year), lang, rating: dec(ratingVal),
      episodeNums, directors: directors.map(dec), actors: actors.map(dec),
      audio: audio.map(dec).filter(Boolean),
    });
  }
  for (const id of Object.keys(programs)) programs[id].sort((a, b) => a.start - b.start);
  return { channels, programs, nameMap };
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */
function matchChannels(channels, guide) {
  const { programs, nameMap } = guide;
  const stats = { id: 0, name: 0 };
  for (const ch of channels) {
    let id = null, how = null;
    if (ch.tvg_id && programs[ch.tvg_id]) { id = ch.tvg_id; how = 'id'; }
    else if (ch.tvg_id && nameMap['i:' + canonId(ch.tvg_id)] && programs[nameMap['i:' + canonId(ch.tvg_id)]]) {
      id = nameMap['i:' + canonId(ch.tvg_id)]; how = 'id';
    }
    if (!id && ch.name && nameMap['n:' + normalize(ch.name)] && programs[nameMap['n:' + normalize(ch.name)]]) {
      id = nameMap['n:' + normalize(ch.name)]; how = 'name';
    }
    if (!id && ch.name && nameMap['l:' + loose(ch.name)] && programs[nameMap['l:' + loose(ch.name)]]) {
      id = nameMap['l:' + loose(ch.name)]; how = 'name';
    }
    ch.epg = id; ch.matchHow = how;
    if (how) stats[how]++;
    ch.programs = id ? (programs[id] || []) : [];
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/* VLC playback                                                        */
/* ------------------------------------------------------------------ */
let vlcChild = null;
function playStream(url, name) {
  return new Promise((resolve, reject) => {
    if (vlcChild) { try { vlcChild.kill(); } catch (_) {} vlcChild = null; }
    const args = ['--fullscreen'];
    if (name) args.push('--meta-title=' + name);
    args.push(url);
    let child;
    try {
      child = spawn(VLC, args, { detached: false });
    } catch (e) {
      return reject(new Error('failed to launch VLC: ' + e.message));
    }
    vlcChild = child;
    const onErr = e => {
      if (vlcChild === child) vlcChild = null;
      reject(new Error('failed to launch VLC: ' + e.message));
    };
    child.once('error', onErr);
    child.once('spawn', () => {
      child.removeListener('error', onErr);
      resolve({ launched: true, url });
    });
    child.once('exit', () => { if (vlcChild === child) vlcChild = null; });
  });
}
function stopPlay() {
  if (vlcChild) { try { vlcChild.kill(); } catch (_) {} vlcChild = null; }
  return { stopped: true };
}

/* ------------------------------------------------------------------ */
/* Auto XMLTV grabber                                                  */
/* ------------------------------------------------------------------ */
// Country/region name -> ISO code for epg.pw per-country guides.
const COUNTRY_MAP = {
  'australia':'AU','brazil':'BR','canada':'CA','china':'CN','germany':'DE',
  'france':'FR','united kingdom':'GB','uk':'GB','britain':'GB','great britain':'GB',
  'hong kong':'HK','indonesia':'ID','india':'IN','japan':'JP','malaysia':'MY',
  'new zealand':'NZ','philippines':'PH','russia':'RU','singapore':'SG',
  'taiwan':'TW','united states':'US','usa':'US','america':'US','vietnam':'VN',
  'south africa':'ZA',
  'alabama':'US','alaska':'US','arizona':'US','arkansas':'US','california':'US',
  'colorado':'US','connecticut':'US','delaware':'US','florida':'US','georgia':'US',
  'hawaii':'US','idaho':'US','illinois':'US','indiana':'US','iowa':'US',
  'kansas':'US','kentucky':'US','louisiana':'US','maine':'US','maryland':'US',
  'massachusetts':'US','michigan':'US','minnesota':'US','mississippi':'US',
  'missouri':'US','montana':'US','nebraska':'US','nevada':'US','new hampshire':'US',
  'new jersey':'US','new mexico':'US','new york':'US','north carolina':'US',
  'north dakota':'US','ohio':'US','oklahoma':'US','oregon':'US','pennsylvania':'US',
  'rhode island':'US','south carolina':'US','south dakota':'US','tennessee':'US',
  'texas':'US','utah':'US','vermont':'US','virginia':'US','washington':'US',
  'west virginia':'US','wisconsin':'US','wyoming':'US','district of columbia':'US',
  'alberta':'CA','british columbia':'CA','manitoba':'CA','new brunswick':'CA',
  'newfoundland':'CA','nova scotia':'CA','ontario':'CA','prince edward island':'CA',
  'quebec':'CA','saskatchewan':'CA','nunavut':'CA','northwest territories':'CA',
  'yukon':'CA',
  'andhra pradesh':'IN','assam':'IN','bihar':'IN','gujarat':'IN','haryana':'IN',
  'karnataka':'IN','kerala':'IN','madhya pradesh':'IN','maharashtra':'IN',
  'orissa':'IN','punjab':'IN','rajasthan':'IN','tamil nadu':'IN','telangana':'IN',
  'uttar pradesh':'IN','west bengal':'IN','delhi':'IN','mumbai':'IN',
  'sao paulo':'BR','rio de janeiro':'BR','minas gerais':'BR','bahia':'BR',
  'parana':'BR','rio grande do sul':'BR','pernambuco':'BR','ceara':'BR',
  'goias':'BR','amazonas':'BR','espirito santo':'BR','santa catarina':'BR',
  'england':'GB','scotland':'GB','wales':'GB','northern ireland':'GB','ireland':'GB',
};

const EPGPW = code => `https://epg.pw/xmltv/epg_${code}.xml.gz`;

const guideCache = new Map(); // code -> { ts, parsed }

function resolveCountry(name) {
  const key = String(name || '').toLowerCase().trim();
  return COUNTRY_MAP[key] || null;
}

function groupCountries(groups) {
  const set = new Set();
  for (const g of groups) {
    const code = resolveCountry(g);
    if (code) set.add(code);
    else {
      const low = g.toLowerCase();
      for (const [k, v] of Object.entries(COUNTRY_MAP)) {
        if (k.length > 3 && low.includes(k)) { set.add(v); break; }
      }
    }
  }
  return [...set];
}

async function fetchGuide(code) {
  const cached = guideCache.get(code);
  const now = Date.now();
  if (cached && now - cached.ts < 6 * 3600 * 1000) return cached.parsed;
  const text = await fetchText(EPGPW(code));
  const parsed = parseXMLTV(text);
  guideCache.set(code, { ts: now, parsed });
  return parsed;
}

async function grabEPG(m3u, requestedCountries) {
  const playlistText = await fetchText(m3u, undefined, 15 * 60 * 1000);
  const playlist = parseM3U(playlistText);

  let codes;
  if (Array.isArray(requestedCountries) && requestedCountries.length) {
    codes = requestedCountries.map(c => resolveCountry(c)).filter(Boolean);
    codes = [...new Set(codes)];
  } else {
    codes = groupCountries(playlist.groupList);
  }
  if (!codes.length) {
    return {
      total: playlist.channels.length, matched: 0, codes: [],
      stats: { id: 0, name: 0 }, groups: playlist.groupList,
      channels: playlist.channels.map(c => ({ ...c, programs: [], epg: null, matchHow: null })),
    };
  }

  const merged = { channels: {}, programs: {}, nameMap: {} };
  const failures = [];
  for (const code of codes) {
    try {
      const g = await fetchGuide(code);
      Object.assign(merged.channels, g.channels);
      Object.assign(merged.programs, g.programs);
      Object.assign(merged.nameMap, g.nameMap);
    } catch (e) {
      failures.push(code + ':' + e.message.slice(0, 60));
    }
  }

  const stats = matchChannels(playlist.channels, merged);
  const matched = playlist.channels.filter(c => c.epg).length;
  return {
    total: playlist.channels.length,
    matched, codes, failures,
    stats, groups: playlist.groupList,
    channels: playlist.channels,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
function serveIndex(req, res) {
  // Read fresh on every request so UI edits don't require a server restart.
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, buf) => {
    if (err) return sendJSON(res, 500, { error: 'index.html missing' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  });
}

const M3U_TTL = 15 * 60 * 1000;    // playlists change rarely
const XMLTV_TTL = 30 * 60 * 1000;  // guides update a few times per day

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return serveIndex(req, res);
    if (p === '/health') return sendJSON(res, 200, { ok: true, ts: Date.now() });

    if (p === '/parse/m3u' && req.method === 'POST') {
      const { src } = parseJSON(await readBody(req));
      if (!src) throw Object.assign(new Error('src is required'), { status: 400 });
      const parsed = parseM3U(await fetchText(src, undefined, M3U_TTL));
      return sendJSON(res, 200, parsed);
    }

    if (p === '/parse/xmltv' && req.method === 'POST') {
      const { src } = parseJSON(await readBody(req));
      if (!src) throw Object.assign(new Error('src is required'), { status: 400 });
      const parsed = parseXMLTV(await fetchText(src, undefined, XMLTV_TTL));
      return sendJSON(res, 200, {
        channelCount: Object.keys(parsed.channels).length,
        programCount: Object.values(parsed.programs).reduce((a, l) => a + l.length, 0),
        ...parsed,
      });
    }

    if (p === '/match' && req.method === 'POST') {
      const { m3u, xmltv } = parseJSON(await readBody(req));
      if (!m3u || !xmltv) throw Object.assign(new Error('m3u and xmltv are required'), { status: 400 });
      const playlist = parseM3U(await fetchText(m3u, undefined, M3U_TTL));
      const guide = parseXMLTV(await fetchText(xmltv, undefined, XMLTV_TTL));
      const stats = matchChannels(playlist.channels, guide);
      const matched = playlist.channels.filter(c => c.epg).length;
      return sendJSON(res, 200, {
        channels: playlist.channels,
        groups: playlist.groupList,
        headerEpg: playlist.headerEpg,
        matched, stats, total: playlist.channels.length,
      });
    }

    if (p === '/play' && req.method === 'POST') {
      const { url, name } = parseJSON(await readBody(req));
      if (!url) throw Object.assign(new Error('url is required'), { status: 400 });
      const r = await playStream(url, name);
      return sendJSON(res, 200, r);
    }

    if (p === '/stop' && req.method === 'POST') return sendJSON(res, 200, stopPlay());

    if (p === '/grab' && req.method === 'POST') {
      const { m3u, countries } = parseJSON(await readBody(req));
      if (!m3u) throw Object.assign(new Error('m3u is required'), { status: 400 });
      const result = await grabEPG(m3u, countries);
      return sendJSON(res, 200, result);
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    return sendJSON(res, status, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('VLC EPG Web UI  →  http://127.0.0.1:' + PORT);
  console.log('VLC binary: ' + VLC);
});

// Graceful shutdown: kill VLC child too.
function shutdown() {
  stopPlay();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
