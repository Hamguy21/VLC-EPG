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
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 8123;
const VLC = process.env.VLC_BIN || (
  process.platform === 'win32'
    ? 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'
    : 'vlc'
);
const MAX_BODY = 1 << 20;            // 1 MB request body cap
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const FETCH_TIMEOUT = 30000;
const MAX_REDIRECTS = 4;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAVE_DIR = path.join(__dirname, 'data');
const RELAY_DIR = path.join(SAVE_DIR, 'relay');
// Upper bound on how many bytes the relay withholds to build the buffer.
// Kept generous so high-bitrate streams (1080p+) and large buffer settings
// actually buffer as configured; relays are killed on channel switch, so a
// large ceiling is safe.
const MAX_RELAY_HOLD = 64 * 1024 * 1024;

// Resolve an FFmpeg binary (env override, PATH, or the bundled Hermes copy).
const FFMPEG = (() => {
  const cands = process.env.FFMPEG_BIN
    ? [process.env.FFMPEG_BIN]
    : ['ffmpeg', 'C:\\Users\\Ham\\AppData\\Local\\hermes\\tools\\ffmpeg-9.0.1-win32-x64\\bin\\ffmpeg.EXE'];
  for (const c of cands) {
    try { const r = spawnSync(c, ['-version'], { stdio: 'ignore' }); if (r.status === 0) return c; } catch (_) {}
  }
  return null;
})();

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  securityHeaders(res);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw Object.assign(new Error('request body exceeds 1 MB'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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

function isPrivateAddress(address) {
  const ip = String(address || '').toLowerCase().split('%')[0];
  if (net.isIPv4(ip)) {
    const a = ip.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127 ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && (a[1] === 168 || (a[1] === 0 && (a[2] === 0 || a[2] === 2)))) ||
      (a[0] === 198 && (a[1] === 18 || a[1] === 19 || (a[1] === 51 && a[2] === 100))) ||
      (a[0] === 203 && a[1] === 0 && a[2] === 113) || a[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
        /^fe[89ab]/.test(ip) || ip.startsWith('ff')) return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
  }
  return false;
}
async function validateRemoteUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw Object.assign(new Error('invalid source URL'), { status: 400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('source must be a public HTTP or HTTPS URL'), { status: 400 });
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }); }
  catch (_) { throw Object.assign(new Error('could not resolve source hostname'), { status: 400 }); }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw Object.assign(new Error('private or local network addresses are not allowed as remote sources'), { status: 403 });
  }
  return parsed;
}
async function readResponseLimited(response, maxBytes = MAX_SOURCE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw Object.assign(new Error('source exceeds the download size limit'), { status: 413 });
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('source exceeded the download size limit'), { status: 413 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
async function fetchBuffer(src, timeoutMs = FETCH_TIMEOUT) {
  if (typeof src !== 'string' || !src.trim() || src.length > 4096) {
    throw Object.assign(new Error('source must be a valid URL or local file path'), { status: 400 });
  }
  if (!/^https?:\/\//i.test(src)) {
    let stat;
    try { stat = await fs.promises.stat(src); }
    catch (_) { throw Object.assign(new Error('local source file not found'), { status: 404 }); }
    if (!stat.isFile()) throw Object.assign(new Error('local source must be a file'), { status: 400 });
    if (stat.size > MAX_SOURCE_BYTES) throw Object.assign(new Error('local source exceeds the download size limit'), { status: 413 });
    return fs.promises.readFile(src);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    let current = src;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const parsed = await validateRemoteUrl(current);
      const response = await fetch(parsed, { signal: ctrl.signal, redirect: 'manual',
        headers: { 'User-Agent': 'VLC-EPG/1.0' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) {
          throw Object.assign(new Error('too many or invalid source redirects'), { status: 502 });
        }
        current = new URL(location, parsed).href;
        continue;
      }
      if (!response.ok) throw Object.assign(new Error('source server returned HTTP ' + response.status), { status: 502 });
      return await readResponseLimited(response);
    }
    throw Object.assign(new Error('too many source redirects'), { status: 502 });
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('source request timed out'), { status: 504 });
    throw e;
  } finally { clearTimeout(timer); }
}
function decompress(buf) {
  if (!isGzipBuffer(buf)) return buf;
  try { return zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES }); }
  catch (e) {
    if (/maxOutputLength|larger than/.test(e.message || ''))
      throw Object.assign(new Error('decompressed source exceeds the allowed size limit'), { status: 413 });
    throw Object.assign(new Error('invalid or corrupted gzip source'), { status: 400 });
  }
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
  if (ttlMs > 0) {
    if (fetchCache.size >= 40) {
      const oldest = [...fetchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) fetchCache.delete(oldest[0]);
    }
    fetchCache.set(src, { ts: Date.now(), text });
  }
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
// Return the leading token sequence of a normalized name (e.g. "bbc one hd"
// -> "bbc one" after stripping quality). Used for fuzzy fallback.
function keyTokens(s) {
  const toks = normalize(s).split(/\s+/).filter(Boolean);
  return toks;
}
function sameFirstTokens(a, b) {
  const A = keyTokens(a), B = keyTokens(b);
  if (!A.length || !B.length) return false;
  const n = Math.min(A.length, B.length, 3);
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) return false;
  return true;
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
  if (+Mo < 1 || +Mo > 12 || +D < 1 || +D > 31 || +H > 23 || +Mi > 59 || +S > 59 ||
      (offH && (+offH > 14 || +(offM || 0) > 59))) return null;
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
  const firstMap = {}; // first normalized token -> [ids] for fuzzy fallback

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
    const first = keyTokens(ch.displayNames[0] || '')[0];
    if (first) { (firstMap[first] = firstMap[first] || []).push(id); }
  }

  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  while ((m = progRe.exec(text))) {
    const attrs = m[1];
    const body = m[2];
    const chId = (attrs.match(/channel="([^"]*)"/) || [])[1];
    if (!chId) continue;
    const start = xmltvTime((attrs.match(/start="([^"]*)"/) || [])[1] || '');
    const stop = xmltvTime((attrs.match(/stop="([^"]*)"/) || [])[1] || '');
    if (start == null || stop == null || stop <= start) continue;
    const title = ((body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const desc = ((body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || '').trim();
    // Collect all language variants so the UI can pick a preferred language.
    const titles = [];
    for (const t of body.matchAll(/<title[^>]*lang="([^"]*)"[^>]*>([\s\S]*?)<\/title>/g)) titles.push({ lang: t[1], text: dec(t[2].trim()) });
    if (!titles.some(t => t.text === title)) titles.unshift({ lang: (title.match(/\blang="([^"]*)"/) || [])[1] || '', text: dec(title) });
    const descs = [];
    for (const d of body.matchAll(/<desc[^>]*lang="([^"]*)"[^>]*>([\s\S]*?)<\/desc>/g)) descs.push({ lang: d[1], text: dec(d[2].trim()) });
    if (!descs.some(d => d.text === desc)) descs.unshift({ lang: '', text: dec(desc) });
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
      titles, descs, episodeNums, directors: directors.map(dec), actors: actors.map(dec),
      audio: audio.map(dec).filter(Boolean),
    });
  }
  for (const id of Object.keys(programs)) programs[id].sort((a, b) => a.start - b.start);
  return { channels, programs, nameMap, firstMap };
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */
function matchChannels(channels, guide) {
  const { programs, nameMap, firstMap } = guide;
  const stats = { id: 0, name: 0, fuzzy: 0 };
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
    // Fuzzy fallback: same leading tokens (e.g. "BBC One HD" vs "BBC One").
    if (!id && ch.name && firstMap) {
      const toks = keyTokens(ch.name);
      if (toks.length) {
        const cands = firstMap[toks[0]] || [];
        for (const cand of cands) {
          if (programs[cand] && sameFirstTokens(ch.name, (guide.channels[cand] || {}).displayNames?.[0] || cand)) {
            id = cand; how = 'fuzzy'; break;
          }
        }
      }
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
// Pluto/iPhone HLS manifests are strict about the client signature. Match the
// Chrome 133 Desktop (x86_64) UA the playlists use, keep a generous network
// cache, and add a live cache so ad-transition stalls don't drop the stream.
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// Extra HTTP headers for relay fetches. Pluto's stitch live feed keeps a
// longer session when the request carries a matching Referer/Origin.
function relayHeaders(url) {
  let h = 'X-Forwarded-For: 102.88.71.139\r\n';
  try {
    const u = new URL(url);
    if (/(^|\.)pluto\.tv$/i.test(u.hostname)) h += 'Referer: https://pluto.tv/\r\nOrigin: https://pluto.tv\r\n';
  } catch (_) {}
  return h;
}

// --- Pluto session refresher (prototype) ---
// Pluto's stitch/HLS playout is bounded per session: the feed ends when its
// pre-minted JWT session's playlist is exhausted. To keep a channel "live"
// we mint a fresh guest session from boot.pluto.tv and rebuild the playout
// URL with the new token + stitcherParams, so each relay/restart uses a new
// live session instead of replaying the same bounded (.
const plutoZen = new Map(); // channel -> {url, at}
async function plutoFreshUrl(masterUrl, force) {
  try {
    const m = String(masterUrl).match(/\/channel\/([^/]+)\/master\.m3u8/i);
    if (!m) return null;
    const ch = m[1];
    const cached = plutoZen.get(ch);
    if (!force && cached && Date.now() - cached.at < 15 * 1000) return cached.url;
    const cid = crypto.randomUUID();
    const qs = new URLSearchParams({
      appName: 'web', appVersion: '9.1.0', deviceVersion: '133.0.0',
      deviceModel: 'web', deviceMake: 'chrome', deviceType: 'web',
      ClientModelNumber: '1.0.0', clientID: cid, serverSideAds: 'false'
    });
    const r = await fetch('https://boot.pluto.tv/v4/start?' + qs.toString(), { headers: { 'User-Agent': DEFAULT_UA } });
    if (!r.ok) throw new Error('boot HTTP ' + r.status);
    const j = await r.json();
    // Keep the known-good playout path (api/tn/video/playout/...) and shape;
    // only the token/session/params come from the fresh boot.
    const sp = String(j.stitcherParams || '').replace(/^\?/, '');
    const fresh = 'https://ipv4.pluto.tv/api/tn/video/playout/v2/stitch/hls/channel/' + ch + '/master.m3u8?' + sp +
      '&jwt=' + encodeURIComponent(j.sessionToken) +
      '&quality=720p&deviceMake=chrome&deviceType=web&deviceModel=web&deviceVersion=133.0.0&architecture=x86_64&buildVersion=1.0.0&includeExtendedEvents=true&masterJWTPassthrough=true';
    plutoZen.set(ch, { url: fresh, at: Date.now() });
    sev('pluto_refresh', { channel: ch, host: 'ipv4.pluto.tv', len: fresh.length });
    return fresh;
  } catch (e) {
    sev('pluto_refresh_error', { msg: e.message });
    return null;
  }
}

// --- Pluto HLS proxy (dodges ffmpeg's ~4KB URL truncation) ---
// The relay talks only to short local /plproxy/<slug>/... URLs; the server
// holds the long stitcher URL and fetches/rewrites playlists + segments.
const plProxyMap = new Map(); // slug -> {host, channel, query}
function makeLocalProxy(longUrl) {
  try {
    const u = new URL(longUrl);
    const m = longUrl.match(/\/channel\/([^/]+)\/master\.m3u8/);
    if (!m) return longUrl;
    const slug = 'pp' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    plProxyMap.set(slug, { host: u.host, channel: m[1], query: u.search.slice(1) });
    sev('pl_proxy', { slug, len: longUrl.length });
    return 'http://127.0.0.1:' + PORT + '/plproxy/' + slug + '/master.m3u8';
  } catch (_) { return longUrl; }
}
// Intermittent upstream (silo) segment failures can kill a freshly-started
// relay. Retry once with a fresh session before giving up.
// Test whether an HTTP proxy answers CONNECT (ffmpeg's http_proxy uses HTTP proxies).
function probeProxy(host, port, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    let done = false;
    const req = http.request({ host, port, method: 'CONNECT', path: 'example.com:80', timeout: timeoutMs, headers: { Host: 'example.com' } });
    const finish = v => { if (!done) { done = true; try { req.destroy(); } catch (_) {} resolve(v); } };
    req.on('connect', res => finish(res.statusCode === 200 ? { ms: Date.now() - started } : null));
    req.on('error', () => finish(null));
    req.on('timeout', () => finish(null));
    req.end();
  });
}
async function startMp4WithRetry(url, opts) {
  try { return await startMp4Relay(url, opts); }
  catch (e) {
    if (e && e.status === 422 && !opts._retried) {
      opts._retried = true;
      // Some streams carry MP2 (or other non-AAC) audio; the aac_adtstoasc
      // bitstream filter only supports AAC, so drop it on the retry.
      if (/aac_adtstoasc|not supported by the bitstream filter|\bmp2\b/i.test(String(e.message || ''))) {
        opts.noBsf = true;
      }
      sev('relay_startup_retry', { noBsf: !!opts.noBsf });
      return startMp4Relay(url, opts);
    }
    throw e;
  }
}
async function plFetchProxied(proxy, rel) {
  let remote;
  if (/^https?:\/\//i.test(rel)) {
    // Absolute passthrough (signed segment/key URLs): use exactly as given,
    // never append our session query (it corrupts the signature).
    remote = rel;
  } else {
    if (!rel) throw new Error('empty relative path');
    remote = 'https://' + proxy.host + '/api/tn/video/playout/v2/stitch/hls/channel/' + proxy.channel + '/' + rel;
    const u = new URL(remote);
    if (!u.search) u.search = '?' + proxy.query;   // attach auth for rel subresources
    remote = u.toString();
  }
  const headers = { 'User-Agent': DEFAULT_UA, 'Referer': 'https://pluto.tv/', 'Origin': 'https://pluto.tv' };
  let resp = null, last = null;
  for (let a = 0; a < 3; a++) {
    try { resp = await fetch(remote, { headers }); if (resp.ok) break; last = resp.status; } catch (e) { last = e; }
    if (a < 2) await new Promise(r => setTimeout(r, 400));
  }
  if (!resp || !resp.ok) {
    sev('pl_fetch_fail', { remote: remote.slice(0, 130), status: last instanceof Error ? 'ERR' : last });
    throw new Error('upstream HTTP ' + (last instanceof Error ? last.message : last));
  }
  return resp;
}
function rewritePlutoPlaylist(text, slug, base) {
  const esc = encodeURIComponent;
  const prox = href => '/plproxy/' + slug + '/?u=' + esc(href);
  return text.split('\n').map(raw => {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (t.startsWith('#')) {
      if (/URI="[^"]+"/.test(line)) {
        return line.replace(/URI="([^"]+)"/g, (m, uri) => {
          try { return 'URI="' + prox(new URL(uri, base).href) + '"'; } catch (_) { return m; }
        });
      }
      return line;
    }
    if (!t) return line;
    try { return prox(new URL(t, base).href); } catch (_) { return line; }
  }).join('\n');
}
async function routePlProxy(res, p) {
  const rest = p.slice('/plproxy/'.length);
  const i = rest.indexOf('/');
  const slug = i < 0 ? rest : rest.slice(0, i);
  const proxy = plProxyMap.get(slug);
  if (!proxy) return null;
  const mu = p.match(/[?&]u=([^&]*)/);
  let rel = '';
  if (mu) {
    const dec = decodeURIComponent(mu[1]);
    if (!/^https?:\/\//i.test(dec)) return null;
    rel = dec; // exact signed URL (rewrite encoded it once; undo that once)
  } else {
    rel = i < 0 ? '' : rest.slice(i + 1);
  }
  if (/\.\.\//.test(rel)) return null;
  // base URL (directory) for resolving relative playlists URIs against
  let baseUrl;
  if (/^https?:\/\//i.test(rel)) baseUrl = rel;
  else baseUrl = 'https://' + proxy.host + '/api/tn/video/playout/v2/stitch/hls/channel/' + proxy.channel + '/' + rel;
  baseUrl = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  try {
    const r = await plFetchProxied(proxy, rel);
    const buf = Buffer.from(await r.arrayBuffer());
    const ctype = r.headers.get('content-type') || '';
    if (ctype.includes('mpegurl') || /\.m3u8(\?|$)/i.test(rel)) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(rewritePlutoPlaylist(buf.toString('utf8'), slug, baseUrl));
    } else {
      res.writeHead(200, { 'Content-Type': ctype || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    }
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy upstream: ' + e.message }));
  }
  return true;
}

function launchVlc(url, name, fullscreen, hw) {
  return new Promise((resolve, reject) => {
    if (vlcChild) { try { vlcChild.kill(); } catch (_) {} vlcChild = null; }
    const args = ['--no-video-title-show'];
    args.push('--network-caching=3000');
    args.push('--live-caching=1500');
    args.push('--http-user-agent=' + DEFAULT_UA);
    if (hw) args.push('--avcodec-hw=dxva2');
    if (fullscreen) args.push('--fullscreen');
    if (name) args.push('--meta-title=' + name);
    args.push(url);
    let child;
    try { child = spawn(VLC, args, { detached: false }); }
    catch (e) { return reject(new Error('failed to launch VLC: ' + e.message)); }
    vlcChild = child;
    const onErr = e => { if (vlcChild === child) vlcChild = null; reject(new Error('failed to launch VLC: ' + e.message)); };
    child.once('error', onErr);
    child.once('spawn', () => { child.removeListener('error', onErr); resolve({ launched: true, url }); });
    child.once('exit', () => { if (vlcChild === child) vlcChild = null; });
  });
}

function playStream(url, name, opts) {
  if (typeof url !== 'string' || url.length > 8192 || /[\u0000-\u001f\u007f]/.test(url) || url.startsWith('-')) {
    return Promise.reject(Object.assign(new Error('invalid stream URL'), { status: 400 }));
  }
  let parsed;
  try { parsed = new URL(url); }
  catch (_) { return Promise.reject(Object.assign(new Error('stream URL must be absolute'), { status: 400 })); }
  if (!['http:', 'https:', 'rtsp:', 'rtmp:', 'udp:', 'rtp:', 'mms:'].includes(parsed.protocol)) {
    return Promise.reject(Object.assign(new Error('unsupported stream protocol'), { status: 400 }));
  }
  if (typeof name === 'string') name = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  sev('play', { url: url.slice(0, 140), relay: false, hw: !!(opts && opts.hw) });
  return launchVlc(url, name, opts && opts.fullscreen, opts && opts.hw);
}

/* ---------- FFmpeg relay ---------- */
// Re-streams the upstream over a local HLS so VLC never talks to the origin
// (fixes header-sensitive sources like Pluto that drop direct connections).
let relayChild = null;
let relayDir = null;
function stopRelay() {
  if (relayChild) { try { relayChild.kill(); } catch (_) {} relayChild = null; }
  if (relayDir) { try { fs.rmSync(relayDir, { recursive: true, force: true }); } catch (_) {} relayDir = null; }
}
// Start an FFmpeg relay and wait until its HLS playlist exists. Returns the
// local play URL. Caller decides what plays it (VLC or a web player).
async function startRelay(url, opts = {}) {
  if (/pluto\.tv/i.test(url)) { try { const f = await plutoFreshUrl(url); if (f) url = f; } catch (_) {} }
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('FFmpeg is not available on this system'));
    stopRelay();
    const slug = 's' + Date.now().toString(36);
    const dir = path.join(RELAY_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    const playlist = path.join(dir, 'index.m3u8');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-user_agent', DEFAULT_UA,
      '-headers', relayHeaders(url),
      '-rw_timeout', '15000000',   // 15s network I/O timeout
      '-err_detect', 'ignore_err',
      '-i', url,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '2', '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
      playlist,
    ];
    const childEnv = { ...process.env };
    if (opts.proxy) { childEnv.http_proxy = opts.proxy; childEnv.https_proxy = opts.proxy; childEnv.all_proxy = opts.proxy; }
    let child;
    try { child = spawn(FFMPEG, args, { detached: false, env: childEnv }); }
    catch (e) { return reject(new Error('failed to start FFmpeg: ' + e.message)); }
    relayChild = child; relayDir = dir;
    const errLines = [];
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => { const s = String(d); errLines.push(s); if (errLines.length > 40) errLines.shift(); });
    let wait = null;
    let settled = false;
    const fail = msg => {
      if (settled) return; settled = true;
      if (wait) clearInterval(wait);
      stopRelay();
      console.error('[relay] failed:', msg);
      const er = new Error(msg); er.status = 422; reject(er);
    };
    const done = () => {
      if (settled) return; settled = true;
      if (wait) clearInterval(wait);
      resolve({ playUrl: `http://127.0.0.1:${PORT}/relay/${slug}/index.m3u8`, relay: true, slug });
    };
    const stderrSnippet = () => errLines.join('').replace(/\r/g, '').split('\n').filter(Boolean).slice(-6).join(' ').slice(0, 300);
    child.on('error', e => fail('FFmpeg failed to start: ' + e.message));
    child.on('exit', code => {
      if (relayChild === child) { relayChild = null; relayDir = null; }
      console.error('[relay] exit code=' + code, 'stderr:', stderrSnippet());
      setTimeout(() => {
        if (!fs.existsSync(playlist)) {
          const detail = stderrSnippet();
          fail('FFmpeg ' + (code === null ? 'exited unexpectedly' : 'exited (code ' + code + ')') + (detail ? ': ' + detail : ' before producing a stream'));
        }
      }, 60);
    });
    const t0 = Date.now();
    wait = setInterval(() => {
      if (fs.existsSync(playlist)) return done();
      if (Date.now() - t0 > 15000) {
        const lastErr = (errLines[errLines.length - 1] || '').slice(0, 200);
        fail('FFmpeg relay timed out: ' + lastErr);
      }
    }, 300);
  });
}
function playRelay(url, opts) {
  return startRelay(url).then(({ playUrl }) =>
    launchVlc(playUrl, opts && opts.name, opts && opts.fullscreen, opts && opts.hw)
      .then(() => ({ launched: true, url, relay: true, playUrl })));
}
function stopPlay() {
  if (vlcChild) { try { vlcChild.kill(); } catch (_) {} vlcChild = null; }
  stopRelay();
  stopMp4Relay();
  return { stopped: true };
}

/* ---------- MP4 relay (blob-free web playback) ---------- */
// Re-streams the upstream as a fragmented MP4 that a native <video> can play
// progressively without MediaSource/blob (works even where CSP blocks blob:).
let mp4Child = null;
let mp4File = null;
let mp4Slug = null;
let mp4BufferMs = 30000;
let mp4Head = [];   // accumulated ffmpeg stderr (all) for codec parsing
let mp4LiveMbps = 0;  // measured delivery throughput to the web client (Mbps)
let mp4Eof = false;    // set when the feed ended early (clean EOF shortly after start)
let mp4Watch = null;    // stall-watchdog interval
let mp4LastSize = 0;
let mp4LastGrow = 0;
let mp4TStart = 0;
let mp4ForceFresh = false; // force a fresh session on watchdog restart
let serverEvents = []; // ring buffer of server-side diagnostic events
function sev(msg, extra) {
  try { serverEvents.push(Object.assign({ t: Date.now(), msg }, extra || {})); if (serverEvents.length > 400) serverEvents.shift(); } catch (_) {}
}

// Shared bitrate estimate (bytes/sec) of the relay output, used to size the
// pre-roll and buffer windows in wall-clock terms.
const brEstimator = { bytes: 0, t0: 0, bps: 0 };
function brReset() { brEstimator.bytes = 0; brEstimator.t0 = 0; brEstimator.bps = 0; }
function brSample(size) {
  const now = Date.now();
  if (!brEstimator.t0) { brEstimator.t0 = now; brEstimator.bytes = size; return; }
  const dt = (now - brEstimator.t0) / 1000;
  if (dt >= 1) {
    brEstimator.bps = Math.max(50000, (size - brEstimator.bytes) / dt);
    brEstimator.t0 = now; brEstimator.bytes = size;
  }
}
function brBps() { return brEstimator.bps || 400000; }
function stopMp4Relay() {
  if (mp4Watch) { clearInterval(mp4Watch); mp4Watch = null; }
  if (mp4Child) { try { mp4Child.kill(); } catch (_) {} mp4Child = null; }
  if (mp4File) { try { fs.rmSync(mp4File, { force: true }); } catch (_) {} mp4File = null; }
  mp4Slug = null;
  mp4LiveMbps = 0;
  mp4Eof = false;
}
// Server-side stall watchdog: if the relay output stops growing for ~10s
// (upstream hang) after warm-up, kill it and pre-emptively restart with a
// fresh session so recovery is faster and zombies don't linger.
function startMp4Watchdog(url, opts) {
  clearInterval(mp4Watch);
  mp4LastSize = 0; mp4LastGrow = Date.now();
  mp4Watch = setInterval(() => {
    if (!mp4Child) { clearInterval(mp4Watch); mp4Watch = null; return; }
    let sz = 0; try { sz = fs.statSync(mp4File).size; } catch (_) {}
    if (sz !== mp4LastSize) { mp4LastSize = sz; mp4LastGrow = Date.now(); return; }
    const stuck = Date.now() - mp4LastGrow;
    if (stuck > 10000 && Date.now() - mp4TStart > 20000) {
      sev('watchdog_stall', { slug: mp4Slug, stuckMs: stuck });
      clearInterval(mp4Watch); mp4Watch = null;
      mp4ForceFresh = true;
      stopMp4Relay();
      startMp4Relay(url, opts)
        .then(() => sev('watchdog_restarted', {}))
        .catch(e => sev('watchdog_restart_failed', { msg: e.message }));
    }
  }, 2000);
}
async function startMp4Relay(url, opts) {
  if (/pluto\.tv/i.test(url)) { try { const f = await plutoFreshUrl(url, mp4ForceFresh); mp4ForceFresh = false; if (f) url = f; } catch (_) {} }
  mp4TStart = Date.now();
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('FFmpeg is not available on this system'));
    stopMp4Relay();
    const slug = 'm' + Date.now().toString(36);
    const dir = path.join(RELAY_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'live.mp4');
    const tStart = Date.now();
    const bufferMs = opts && opts.bufferMs ? Math.min(90000, Math.max(5000, +opts.bufferMs)) : 30000;
    const preRollSec = 10;   // buffer this much before starting playback
    brReset();
    mp4Head = [];
    mp4LiveMbps = 0;
    mp4Eof = false;
    const codecs = () => {
      const text = mp4Head.join('\n');
      let video = '', audio = '', res = '';
      const vm = text.match(/Video:\s*([^\s,]+)/); if (vm) video = vm[1];
      const am = text.match(/Audio:\s*([^\s,]+)/); if (am) audio = am[1];
      const rm = text.match(/(\d{2,5})x(\d{2,5})/); if (rm) res = rm[1] + '×' + rm[2];
      return { video, audio, res };
    };
    const tc = !!(opts && opts.tc);   // transcode to h264+aac for compatibility
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostdin',
      '-user_agent', DEFAULT_UA,
      '-headers', relayHeaders(url),
      '-rw_timeout', '15000000',
      '-err_detect', 'ignore_err',
      '-i', url,
    ];
    if (tc) {
      args.push('-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k');
    } else if (opts.noBsf) {
      args.push('-c', 'copy'); // non-AAC audio (e.g. MP2): aac_adtstoasc bsf unsupported
    } else {
      args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc'); // remux HLS AAC -> MP4
    }
    args.push('-fflags', '+genpts+flush_packets+discardcorrupt', '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '500000', file);
    const childEnv = { ...process.env };
    if (opts.proxy) { childEnv.http_proxy = opts.proxy; childEnv.https_proxy = opts.proxy; childEnv.all_proxy = opts.proxy; }
    let child;
    try { child = spawn(FFMPEG, args, { detached: false, env: childEnv }); }
    catch (e) { return reject(new Error('failed to start FFmpeg: ' + e.message)); }
    mp4Child = child; mp4File = file; mp4Slug = slug; mp4BufferMs = bufferMs;
    sev('relay_start', { slug, url });
    const errLines = [];
    const headLines = [];
    child.stderr.on('data', d => {
      const s = String(d);
      if (mp4Head.join('').length < 200000) mp4Head.push(s); // keep all for codec parse
      errLines.push(s); if (errLines.length > 40) errLines.shift();
    });
    let settled = false;
    const fail = msg => { if (settled) return; settled = true; stopMp4Relay(); const er = new Error(msg); er.status = 422; reject(er); };
    const done = () => { if (settled) return; settled = true; resolve({ url: `http://127.0.0.1:${PORT}/relaymp4/${slug}/live.mp4`, relay: true, slug, codecs: codecs() }); startMp4Watchdog(url, opts); };
    child.on('error', e => { sev('relay_error', { slug, msg: e.message }); fail('FFmpeg failed to start: ' + e.message); });
    child.on('exit', code => {
      if (mp4Child === child) mp4Child = null;
      const ms = Date.now() - tStart;
      sev('relay_exit', { slug, code, ms });
      if (code !== 0) sev('ffmpeg_exit_err', { slug, code, tail: errLines.join('\n').slice(-1200) });
      // Clean exit shortly after start = the upstream feed ended (EOF), not a
      // network blip. Flag it so the client can stop the reconnect loop.
      if (code === 0 && ms < 30000) { mp4Eof = true; sev('relay_eof', { slug, ms }); }
      setTimeout(() => { if (!fs.existsSync(file) || fs.statSync(file).size < 4096) fail('FFmpeg exited (code ' + code + ') ' + errLines.join(' ').slice(-200)); }, 60);
    });
    const t0 = Date.now();
    const wait = setInterval(() => {
      const elapsed = Date.now() - tStart;
      let sz = 0; try { sz = fs.statSync(file).size; } catch (_) {}
      brSample(sz);
      const preRollBytes = brBps() * preRollSec;
      const ready = sz >= Math.max(262144, Math.min(preRollBytes, brBps() * 60));
      const limit = tc ? 120000 : 60000;
      if (ready) { clearInterval(wait); done(); }
      else if (elapsed > limit) { clearInterval(wait); const m = 'MP4 relay timed out: ' + errLines.join(' ').slice(-200); sev('relay_timeout', { slug, msg: m }); fail(m); }
    }, 300);
  });
}
// Stream a growing file to res.
// - Pre-roll: never release data younger than ~preRollSec so playback starts
//   with that cushion already buffered.
// - Ramp: over the first ~10s of playback, hold increasingly more so the
//   client builds toward targetSec of buffer.
// - Network-adaptive: the target buffer is downgraded if delivery throughput
//   is low, so a weak link doesn't chase an unreachable buffer.
function streamGrowingFile(res, file, opts) {
  const o = opts || {};
  const preRollSec = Math.max(2, o.preRollSec || 10);
  const targetSec = Math.max(4, o.targetSec || 30);
  const rampMs = 10000;                 // build full buffer over ~10s of playback
  const startTs = Date.now();
  const samples = [];                    // [{size, t}] received watermarks
  let sentUpTo = 0;
  let outBytes = 0, outT0 = 0, outBps = 0;
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-store' });

  const recvBytes = () => samples.length ? samples[samples.length - 1].size : 0;
  const bps = () => brBps();

  // Effective delivery throughput to the client (network speed detector).
  const noteOut = n => {
    outBytes += n;
    const now = Date.now();
    if (!outT0) outT0 = now;
    const dt = (now - outT0) / 1000;
    if (dt >= 2) { outBps = outBytes / dt; outT0 = now; outBytes = 0; mp4LiveMbps = outBps / 125000; }
  };
  const networkCapSec = () => {
    if (!outBps) return targetSec;
    const m = outBps / 125000; // bytes/s -> Mbps
    if (m >= 8) return 30;
    if (m >= 5) return 24;
    if (m >= 3.2) return 18;
    if (m >= 1.8) return 12;
    return 8;
  };

  // Current hold-back (seconds) = preRoll, ramping to adaptive target.
  const holdSec = () => {
    const el = Date.now() - startTs;
    const target = Math.min(targetSec, networkCapSec());
    const t = Math.min(target, preRollSec + (target - preRollSec) * (el / rampMs));
    return Math.max(preRollSec * 0.5, t);
  };

  // Bytes we may release now (recent media is withheld to build the buffer).
  // The hold is capped at MAX_RELAY_HOLD so the buffer never grows unbounded
  // and playback never hangs behind an ever-growing withhold.
  const releaseOffset = () => {
    const recv = recvBytes();
    const holdBytes = Math.min(bps() * holdSec(), MAX_RELAY_HOLD);
    return Math.max(0, recv - holdBytes);
  };

  const pump = () => {
    if (res.writableEnded) return;
    try {
      const size = fs.statSync(file).size;
      if (size > (samples.length ? samples[samples.length - 1].size : 0)) samples.push({ size, t: Date.now() });
      const target = releaseOffset();
      if (target > sentUpTo) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(target - sentUpTo);
        fs.readSync(fd, buf, 0, buf.length, sentUpTo);
        fs.closeSync(fd);
        sentUpTo = target;
        res.write(buf);
        noteOut(buf.length);
      }
    } catch (_) {}
  };
  const iv = setInterval(pump, 250);
  pump();
  res.on('close', () => clearInterval(iv));
}

/* ------------------------------------------------------------------ */
/* Auto XMLTV grabber                                                  */
/* ------------------------------------------------------------------ */
// Country/region name -> ISO code (lowercase key). Covers major countries,
// US states, provinces, and regions so playlist groups resolve to a guide.
const COUNTRY_MAP = {
  // Major countries
  'australia':'AU','brazil':'BR','canada':'CA','china':'CN','germany':'DE',
  'france':'FR','united kingdom':'GB','uk':'GB','britain':'GB','great britain':'GB',
  'hong kong':'HK','indonesia':'ID','india':'IN','japan':'JP','malaysia':'MY',
  'new zealand':'NZ','philippines':'PH','russia':'RU','singapore':'SG',
  'taiwan':'TW','united states':'US','usa':'US','america':'US','vietnam':'VN',
  'south africa':'ZA','albania':'AL','algeria':'DZ','anguilla':'AI',
  'antigua and barbuda':'AG','argentina':'AR','armenia':'AM','aruba':'AW',
  'austria':'AT','azerbaijan':'AZ','bahamas':'BS','bahrain':'BH','bangladesh':'BD',
  'barbados':'BB','belarus':'BY','belgium':'BE','belize':'BZ','benin':'BJ',
  'bermuda':'BM','bhutan':'BT','bolivia':'BO','bonaire':'BQ','bosnia and herzegovina':'BA',
  'botswana':'BW','brunei':'BN','bulgaria':'BG','burkina faso':'BF','burundi':'BI',
  'cambodia':'KH','cameroon':'CM','cape verde':'CV','chile':'CL','colombia':'CO',
  'congo':'CG','costa rica':'CR','croatia':'HR','cuba':'CU','cyprus':'CY',
  'czech republic':'CZ','denmark':'DK','djibouti':'DJ','dominica':'DM',
  'dominican republic':'DO','ecuador':'EC','egypt':'EG','el salvador':'SV',
  'england':'GB','scotland':'GB','wales':'GB','northern ireland':'GB','ireland':'IE',
  'estonia':'EE','ethiopia':'ET','fiji':'FJ','finland':'FI','gabon':'GA',
  'gambia':'GM','georgia':'GE','ghana':'GH','greece':'GR','grenada':'GD',
  'guatemala':'GT','guinea':'GN','guyana':'GY','haiti':'HT','honduras':'HN',
  'hungary':'HU','iceland':'IS','iraq':'IQ','israel':'IL','italy':'IT',
  'ivory coast':'CI','jamaica':'JM','jordan':'JO','kazakhstan':'KZ','kenya':'KE',
  'kosovo':'XK','kuwait':'KW','kyrgyzstan':'KG','laos':'LA','latvia':'LV',
  'lebanon':'LB','lesotho':'LS','liberia':'LR','libya':'LY','liechtenstein':'LI',
  'lithuania':'LT','luxembourg':'LU','madagascar':'MG','malawi':'MW','maldives':'MV',
  'mali':'ML','malta':'MT','mauritania':'MR','mauritius':'MU','mexico':'MX',
  'moldova':'MD','monaco':'MC','mongolia':'MN','montenegro':'ME','morocco':'MA',
  'mozambique':'MZ','myanmar':'MM','namibia':'NA','nepal':'NP','netherlands':'NL',
  'nicaragua':'NI','niger':'NE','nigeria':'NG','north macedonia':'MK','norway':'NO',
  'oman':'OM','pakistan':'PK','palestine':'PS','panama':'PA','papua new guinea':'PG',
  'paraguay':'PY','peru':'PE','poland':'PL','portugal':'PT','qatar':'QA',
  'romania':'RO','rwanda':'RW','saudi arabia':'SA','senegal':'SN','serbia':'RS',
  'sierra leone':'SL','slovakia':'SK','slovenia':'SI','somalia':'SO','south korea':'KR',
  'south sudan':'SS','spain':'ES','sri lanka':'LK','sudan':'SD','suriname':'SR',
  'swaziland':'SZ','sweden':'SE','switzerland':'CH','syria':'SY','tajikistan':'TJ',
  'tanzania':'TZ','thailand':'TH','togo':'TG','trinidad and tobago':'TT',
  'tunisia':'TN','turkey':'TR','turkmenistan':'TM','uganda':'UG','ukraine':'UA',
  'united arab emirates':'AE','uruguay':'UY','uzbekistan':'UZ','venezuela':'VE',
  'yemen':'YE','zambia':'ZM','zimbabwe':'ZW',
  // US states
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
  // Canadian provinces
  'alberta':'CA','british columbia':'CA','manitoba':'CA','new brunswick':'CA',
  'newfoundland':'CA','nova scotia':'CA','ontario':'CA','prince edward island':'CA',
  'quebec':'CA','saskatchewan':'CA','nunavut':'CA','northwest territories':'CA',
  'yukon':'CA',
  // India states / major regions
  'andhra pradesh':'IN','assam':'IN','bihar':'IN','gujarat':'IN','haryana':'IN',
  'karnataka':'IN','kerala':'IN','madhya pradesh':'IN','maharashtra':'IN',
  'orissa':'IN','punjab':'IN','rajasthan':'IN','tamil nadu':'IN','telangana':'IN',
  'uttar pradesh':'IN','west bengal':'IN','delhi':'IN','mumbai':'IN',
  // Brazil states
  'sao paulo':'BR','rio de janeiro':'BR','minas gerais':'BR','bahia':'BR',
  'parana':'BR','rio grande do sul':'BR','pernambuco':'BR','ceara':'BR',
  'goias':'BR','amazonas':'BR','espirito santo':'BR','santa catarina':'BR',
  // Mexico states / Argentina provinces / Peru regions / etc.
  'baja california':'MX','baja california sur':'MX','chihuahua':'MX',
  'jalisco':'MX','nuevo leon':'MX','puebla':'MX','sonora':'MX','sinaloa':'MX',
  'veracruz':'MX','yucatan':'MX','mexico city':'MX','distrito federal':'MX',
  'buenos aires':'AR','cordoba':'AR','santa fe':'AR','mendoza':'AR',
  'tucuman':'AR','salta':'AR','entre rios':'AR','misiones':'AR',
  'ancash':'PE','arequipa':'PE','apurimac':'PE','cajamarca':'PE','cusco':'PE',
  'junin':'PE','la libertad':'PE','lambayeque':'PE','lima':'PE','piura':'PE',
  'puno':'PE','san martin':'PE','tacna':'PE','ucayali':'PE','ayacucho':'PE',
  'loreto':'PE','iquitos':'PE','huancavelica':'PE','huánuco':'PE',
  'antioquia':'CO','cundinamarca':'CO','valle del cauca':'CO','atlantico':'CO',
  'bolivar':'CO','caldas':'CO','quindio':'CO','risaralda':'CO','santander':'CO',
  'norte de santander':'CO','huila':'CO','magdalena':'CO','meta':'CO',
  'andorra':'AD','liechtenstein':'LI','monaco':'MC','san marino':'SM',
  'vatican':'VA','palau':'PW','marshall islands':'MH',
  'alto parana':'PY','caaguazu':'PY','boqueron':'PY','central':'PY',
  'busan-gwangyeoksi':'KR','seoul':'KR','incheon':'KR','daegu':'KR',
  'gwangju':'KR','daejeon':'KR','ulsan':'KR','gyeonggi':'KR',
  'biobio':'CL','atacama':'CL','metropolitana':'CL','valparaiso':'CL',
  'araucania':'CL','los lagos':'CL','osorno':'CL',
  'aragua':'VE','carabobo':'VE','merida':'VE','tachira':'VE','zulia':'VE',
  'miguel':'PT','lisboa':'PT','porto':'PT','algarve':'PT',
  'attiki':'GR','kriti':'GR','thessaloniki':'GR','makedonia':'GR',
  'andalucia':'ES','catalunya':'ES','madrid':'ES','valencia':'ES',
  'galicia':'ES','pais vasco':'ES','castilla y leon':'ES','aragon':'ES',
  'canarias':'ES','asturias':'ES','extremadura':'ES','murcia':'ES',
  'aceh':'ID','bali':'ID','banten':'ID','jakarta':'ID','jawa barat':'ID',
  'jawa tengah':'ID','jawa timur':'ID','kalimantan':'ID','lampung':'ID',
  'nusa tenggara':'ID','papua':'ID','riau':'ID','sulawesi':'ID',
  'sumatera':'ID','sumatera barat':'ID','sumatera selatan':'ID',
  'sumatera utara':'ID','yogyakarta':'ID','bengkulu':'ID','gorontalo':'ID',
  'jambi':'ID','kalimantan barat':'ID','kalimantan selatan':'ID',
  'kalimantan tengah':'ID','kalimantan timur':'ID','kepulauan riau':'ID',
  'maluku':'ID','maluku utara':'ID','nusa tenggara barat':'ID',
  'nusa tenggara timur':'ID','sulawesi barat':'ID','sulawesi selatan':'ID',
  'sulawesi tengah':'ID','sulawesi tenggara':'ID','sulawesi utara':'ID',
  'sumatera selatan':'ID','kepulauan bangka belitung':'ID',
};

const EPGPW = code => `https://epg.pw/xmltv/epg_${code}.xml.gz`;
const XMLTVLIVE = code => `https://xmltv.live/epg/${code.toLowerCase()}.xml.gz`;

// epg.pw only publishes guides for these 20 countries; querying it for any
// other code is a guaranteed 404/hang. xmltv.live covers far more.
const EPGPW_CODES = new Set(['AU','BR','CA','CN','DE','FR','GB','HK','ID','IN','JP','MY','NZ','PH','RU','SG','TW','US','VN','ZA']);

// Per-country provider list, epg.pw first where it exists, xmltv.live always.
const providerForCode = code => {
  const provs = [];
  if (EPGPW_CODES.has(code)) provs.push({ name: 'epg.pw', url: EPGPW });
  provs.push({ name: 'xmltv.live', url: XMLTVLIVE });
  return provs;
};

const GUIDE_TIMEOUT = 15000; // per-guide fetch timeout
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

  let lastErr = null;
  for (const prov of providerForCode(code)) {
    try {
      const text = await fetchText(prov.url(code), undefined, GUIDE_TIMEOUT);
      const parsed = parseXMLTV(text);
      if (Object.keys(parsed.channels).length) {
        guideCache.set(code, { ts: now, parsed });
        return parsed;
      }
      lastErr = new Error(prov.name + ': empty guide');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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

  const merged = { channels: {}, programs: {}, nameMap: {}, firstMap: {} };
  const failures = [];

  // Merge a fetched guide into the aggregate.
  const absorb = g => {
    Object.assign(merged.channels, g.channels);
    Object.assign(merged.programs, g.programs);
    Object.assign(merged.nameMap, g.nameMap);
    for (const [k, v] of Object.entries(g.firstMap || {})) {
      merged.firstMap[k] = (merged.firstMap[k] || []).concat(v);
    }
  };

  // Fetch guides with bounded concurrency so a slow host can't stall the whole
  // grab. Each code resolves independently (success or failure).
  const CONCURRENCY = 6;
  let cursor = 0;
  let covered = 0, missing = 0;
  async function worker() {
    while (cursor < codes.length) {
      const code = codes[cursor++];
      try {
        absorb(await fetchGuide(code));
        covered++;
      } catch (e) {
        // A 404 just means no guide exists for that country (expected) —
        // don't report it as an error. Only real failures are surfaced.
        if (/404/i.test(e.message)) missing++;
        else failures.push(code + ':' + e.message.slice(0, 60));
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, codes.length) }, worker);
  await Promise.all(workers);

  const stats = matchChannels(playlist.channels, merged);
  const matched = playlist.channels.filter(c => c.epg).length;

  // Persist the grabbed (matched) guide as a local XMLTV file so the UI can
  // save it as a source and skip re-grabbing on future loads.
  let savedFile = null;
  try {
    savedFile = saveMergedGuide(merged, playlist.channels);
  } catch (e) { /* non-fatal: the grab still succeeded */ }

  return {
    total: playlist.channels.length,
    matched, codes, failures, covered, missing,
    stats, groups: playlist.groupList,
    channels: playlist.channels,
    savedFile,
  };
}

/* Serialize the merged guide for matched channels into an XMLTV file. */
function saveMergedGuide(merged, channels) {
  const wanted = new Set(channels.filter(c => c.epg).map(c => c.epg));
  if (!wanted.size) return null;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="vlc-epg-auto">\n';

  for (const id of wanted) {
    const ch = merged.channels[id];
    if (!ch) continue;
    const displayName = (ch.displayNames && ch.displayNames[0]) || id;
    const logo = ch.logos && ch.logos[0];
    xml += `  <channel id="${esc(id)}">\n`;
    xml += `    <display-name>${esc(displayName)}</display-name>\n`;
    if (logo) xml += `    <icon src="${esc(logo)}"/>\n`;
    xml += `  </channel>\n`;

    for (const p of (merged.programs[id] || [])) {
      const st = new Date(p.start);
      const en = new Date(p.stop);
      const fmt = d => {
        const p2 = n => String(n).padStart(2, '0');
        return `${d.getUTCFullYear()}${p2(d.getUTCMonth()+1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())} +0000`;
      };
      xml += `  <programme start="${fmt(st)}" stop="${fmt(en)}" channel="${esc(id)}">\n`;
      xml += `    <title lang="en">${esc(p.title)}</title>\n`;
      if (p.desc) xml += `    <desc lang="en">${esc(p.desc)}</desc>\n`;
      if (p.cat) xml += `    <category lang="en">${esc(p.cat)}</category>\n`;
      if (p.sub) xml += `    <sub-title lang="en">${esc(p.sub)}</sub-title>\n`;
      if (p.year) xml += `    <date>${esc(p.year)}</date>\n`;
      if (p.icon) xml += `    <icon src="${esc(p.icon)}"/>\n`;
      xml += `  </programme>\n`;
    }
  }
  xml += '</tv>\n';

  const hash = crypto.createHash('sha1').update(xml).digest('hex').slice(0, 12);
  const file = path.join(SAVE_DIR, `epg_${hash}.xml`);
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(file, xml);
  return file;
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
function serveIndex(req, res) {
  // Read fresh on every request so UI edits don't require a server restart.
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, buf) => {
    if (err) return sendJSON(res, 500, { error: 'index.html missing' });
    securityHeaders(res);
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const M3U_TTL = 15 * 60 * 1000;    // playlists change rarely
const XMLTV_TTL = 30 * 60 * 1000;  // guides update a few times per day

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    securityHeaders(res);
    const origin = req.headers.origin;
    if (origin) {
      let parsedOrigin;
      try { parsedOrigin = new URL(origin); }
      catch (_) { throw Object.assign(new Error('invalid request origin'), { status: 403 }); }
      if (parsedOrigin.host !== req.headers.host || !['http:', 'https:'].includes(parsedOrigin.protocol))
        throw Object.assign(new Error('cross-origin requests are not allowed'), { status: 403 });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw Object.assign(new Error('cross-site requests are not allowed'), { status: 403 });
    if (p === '/' || p === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw Object.assign(new Error('method not allowed'), { status: 405 });
      return serveIndex(req, res);
    }
    if (p === '/health') return sendJSON(res, 200, { ok: true, ts: Date.now() });

    // Tiny echo endpoint for round-trip latency measurement.
    if (p === '/ping' && req.method === 'GET') return sendJSON(res, 200, { ok: true, ts: Date.now() });

    // Upload speed test: drain the request body, report bytes received.
    if (p === '/uploadtest' && req.method === 'POST') {
      let total = 0;
      req.on('data', d => { total += d.length; });
      req.on('end', () => sendJSON(res, 200, { received: total }));
      return;
    }

    // Simple download speed test: stream 8MB and let the client time it.
    if (p === '/speedtest' && req.method === 'GET') {
      const mb = 8;
      const payload = Buffer.alloc(mb * 1024 * 1024, 0x5a);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
      res.end(payload);
      return;
    }

    if (p === '/parse/m3u' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { src } = parseJSON(await readBody(req));
      if (typeof src !== 'string' || !src.trim()) throw Object.assign(new Error('src is required'), { status: 400 });
      const parsed = parseM3U(await fetchText(src, undefined, M3U_TTL));
      return sendJSON(res, 200, parsed);
    }

    if (p === '/parse/xmltv' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { src } = parseJSON(await readBody(req));
      if (typeof src !== 'string' || !src.trim()) throw Object.assign(new Error('src is required'), { status: 400 });
      const parsed = parseXMLTV(await fetchText(src, undefined, XMLTV_TTL));
      return sendJSON(res, 200, {
        channelCount: Object.keys(parsed.channels).length,
        programCount: Object.values(parsed.programs).reduce((a, l) => a + l.length, 0),
        ...parsed,
      });
    }

    if (p === '/match' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { m3u, xmltv } = parseJSON(await readBody(req));
      if (typeof m3u !== 'string' || !m3u.trim() || typeof xmltv !== 'string' || !xmltv.trim()) throw Object.assign(new Error('m3u and xmltv are required'), { status: 400 });
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
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { url, name, fullscreen, networkCaching, userAgent, relay, hw } = parseJSON(await readBody(req));
      if (typeof url !== 'string' || !url.trim()) throw Object.assign(new Error('url is required'), { status: 400 });
      let r;
      if (relay) r = await playRelay(url, { name, fullscreen: !!fullscreen, hw: !!hw });
      else r = await playStream(url, name, { fullscreen: !!fullscreen, networkCaching, userAgent, hw: !!hw });
      return sendJSON(res, 200, r);
    }

    // Start an FFmpeg relay and return the local play URL for a web player
    // (does NOT launch VLC).
    if (p === '/stream' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { url, proxy } = parseJSON(await readBody(req));
      if (typeof url !== 'string' || !url.trim()) throw Object.assign(new Error('url is required'), { status: 400 });
      const r = await startRelay(url, { proxy: proxy || '' });
      return sendJSON(res, 200, r);
    }

    // Server-side diagnostic log (for Debug mode export).
    if (p === '/debuglog' && req.method === 'GET') {
      return sendJSON(res, 200, { now: Date.now(), events: serverEvents });
    }

    // Probe free HTTP proxies (clarketm/proxy-list) — best-effort helper for
    // geo-blocked streams. Returns only proxies that answer an HTTP CONNECT.
    if (p === '/proxylist' && req.method === 'GET') {
      const q = (req.url.split('?')[1] || '');
      const getI = (k, d) => { const m = q.match(new RegExp('[?&]' + k + '=(\\d+)')); return m ? parseInt(m[1], 10) : d; };
      const limit = Math.max(1, Math.min(30, getI('limit', 10)));
      const timeout = Math.max(1000, Math.min(6000, getI('timeout', 3500)));
      let list = [];
      try {
        const buf = await fetchBuffer('https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt', 15000);
        list = buf.toString('utf-8').split(/\r?\n/).map(s => s.trim())
          .filter(s => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s));
      } catch (_) {}
      // shuffle then sample
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      const sample = list.slice(0, Math.min(limit * 3, list.length));
      const results = [];
      let cursor = 0;
      const workers = Math.min(6, sample.length);
      await Promise.all(Array.from({ length: workers }, async () => {
        while (cursor < sample.length && results.length < limit) {
          const idx = cursor++;
          const [host, port] = sample[idx].split(':');
          const pr = await probeProxy(host, parseInt(port, 10), timeout);
          if (pr) results.push({ host, port: +port, ms: pr.ms });
        }
      }));
      results.sort((a, b) => a.ms - b.ms);
      return sendJSON(res, 200, { total: list.length, proxies: results.slice(0, limit) });
    }

    // Pluto HLS proxy: short local URLs that relay the long stitcher feed.
    if (p.startsWith('/plproxy/')) {
      const handled = await routePlProxy(res, p);
      if (handled) return;
    }

    // Current relay codec info (for Stats-for-nerds).
    if (p === '/relayinfo' && req.method === 'GET') {
      const text = mp4Head.join('\n');
      let video = '', audio = '', resStr = '';
      const vm = text.match(/Video:\s*([^\s,]+)/); if (vm) video = vm[1];
      const am = text.match(/Audio:\s*([^\s,]+)/); if (am) audio = am[1];
      const rm = text.match(/(\d{2,5})x(\d{2,5})/); if (rm) resStr = rm[1] + '×' + rm[2];
      return sendJSON(res, 200, { active: !!mp4Child, ended: mp4Eof, connectionMbps: mp4LiveMbps, codecs: { video, audio, res: resStr } });
    }

    // Start an FFmpeg MP4 relay (native, blob-free web playback).
    if (p === '/streammp4' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { url, buffer, tc, proxy } = parseJSON(await readBody(req));
      if (typeof url !== 'string' || !url.trim()) throw Object.assign(new Error('url is required'), { status: 400 });
      const r = await startMp4WithRetry(url, { bufferMs: (Number(buffer) || 30) * 1000, tc: !!tc, proxy: proxy || '' });
      return sendJSON(res, 200, r);
    }

    if (p === '/stop' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      await readBody(req);
      return sendJSON(res, 200, stopPlay());
    }

    if (p === '/grab' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
        throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
      const { m3u, countries } = parseJSON(await readBody(req));
      if (typeof m3u !== 'string' || !m3u.trim()) throw Object.assign(new Error('m3u is required'), { status: 400 });
      const result = await grabEPG(m3u, countries);
      return sendJSON(res, 200, result);
    }

    // Translate text to a target language (best-effort). Uses MyMemory
    // (free, auto-detect) with Google as a fallback.
    if (p === '/translate' && req.method === 'POST') {
      const { text, to } = parseJSON(await readBody(req));
      if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      if (typeof to !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(to)) throw Object.assign(new Error('invalid target language'), { status: 400 });
      const q = encodeURIComponent(text.slice(0, 1500));
      // Try MyMemory first (auto-detect source).
      try {
        const u = `https://api.mymemory.translated.net/get?q=${q}&langpair=autodetect|${to}`;
        const buf = await fetchBuffer(u, 12000);
        const data = JSON.parse(buf.toString('utf-8'));
        const st = Number(data && data.responseStatus);
        const out = data && data.responseData && data.responseData.translatedText;
        const outS = String(out || '').trim();
        // MyMemory returns 403 + a junk string ("PLEASE SELECT TWO DISTINCT
        // LANGUAGES") when the auto-detected source == target. Treat non-200
        // or obvious error strings as failure and fall through to Google.
        if (st === 200 && outS && !/MYMEMORY WARNING/i.test(outS)
            && !/PLEASE SELECT TWO DISTINCT LANGUAGES/i.test(outS)) {
          return sendJSON(res, 200, { text: outS, from: (data.responseData.detectedLanguage) || 'auto' });
        }
      } catch (_) { /* fall through to google */ }
      // Fallback: Google translate (auto-detect).
      const g = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${q}`;
      const gbuf = await fetchBuffer(g, 12000);
      const gdata = JSON.parse(gbuf.toString('utf-8'));
      const gout = Array.isArray(gdata) && Array.isArray(gdata[0])
        ? gdata[0].map(seg => (seg && seg[0]) || '').join('')
        : text;
      return sendJSON(res, 200, { text: gout, from: (gdata && gdata[2]) || 'auto' });
    }

    // Serve bundled vendor assets (e.g. hls.min.js) from public/vendor.
    if (p.startsWith('/vendor/')) {
      const abs = path.join(PUBLIC_DIR, path.normalize(p.slice(1)));
      if (!abs.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
      fs.readFile(abs, (err, buf) => {
        if (err) return sendJSON(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'Content-Type': abs.endsWith('.js') ? 'application/javascript' : 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'max-age=86400',
        });
        res.end(buf);
      });
      return;
    }

    // Serve local HLS segments produced by the FFmpeg relay.
    if (p.startsWith('/relay/')) {
      const rel = p.slice('/relay/'.length);
      const abs = path.join(RELAY_DIR, path.normalize(rel));
      if (!abs.startsWith(RELAY_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
      fs.readFile(abs, (err, buf) => {
        if (err) return sendJSON(res, 404, { error: 'not found' });
        const type = abs.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
          : abs.endsWith('.ts') ? 'video/mp2t'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }

    // Stream the growing MP4 relay file (native web playback).
    if (p.startsWith('/relaymp4/')) {
      const rel = p.slice('/relaymp4/'.length);
      const abs = path.join(RELAY_DIR, path.normalize(rel));
      if (!abs.startsWith(RELAY_DIR + path.sep) || !fs.existsSync(abs)) return sendJSON(res, 404, { error: 'not found' });
      streamGrowingFile(res, abs, { preRollSec: 10, targetSec: mp4BufferMs / 1000 });
      return;
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    const status = Number.isInteger(e.status) ? e.status : 500;
    sev('http_error', { path: p, method: req.method, status });
    if (status >= 500) console.error(new Date().toISOString(), req.method, p, e.stack || e);
    return sendJSON(res, status, { error: status >= 500 ? 'internal server error' : String(e.message || e) });
  }
});

server.requestTimeout = 65000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
const numericPort = Number(PORT);
if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)
  throw new Error('PORT must be an integer between 1 and 65535');
server.listen(numericPort, '127.0.0.1', () => {
  console.log('VLC EPG Web UI  →  http://127.0.0.1:' + PORT);
  console.log('VLC binary: ' + VLC);
});

// Graceful shutdown: kill VLC child too.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPlay();
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
}
server.on('error', err => {
  console.error('HTTP server error:', err.message);
  if (err.code === 'EADDRINUSE') console.error('Port ' + numericPort + ' is already in use.');
  process.exitCode = 1;
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
