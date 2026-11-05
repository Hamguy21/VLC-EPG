/**
 * VLC EPG Web UI — EPG grid companion.
 *
 * A zero-dependency Node server that:
 *   - serves a single-page EPG grid UI
 *   - downloads/parses the M3U playlist and XMLTV guide (URL or local file)
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
const { spawn } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 8123;
const VLC = process.env.VLC_BIN || (
  process.platform === 'win32'
    ? 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'
    : 'vlc'
);

/* ------------------------------------------------------------------ */
/* fetch helper                                                        */
/* ------------------------------------------------------------------ */
function fetchText(src, timeoutMs = 20000) {
  const isUrl = /^https?:\/\//i.test(src);
  if (!isUrl) {
    // local file path
    if (!fs.existsSync(src)) throw new Error('file not found: ' + src);
    return fs.readFileSync(src, 'utf8');
  }
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(src, { signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + src);
        return r.text();
      })
      .then(resolve)
      .catch(e => reject(new Error(e.name === 'AbortError' ? 'timeout fetching ' + src : String(e.message || e))))
      .finally(() => clearTimeout(timer));
  });
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
/* XMLTV parser (browser/DOMParser not available → regex-based)        */
/* ------------------------------------------------------------------ */
const QUALITY = ['fhd','hd','uhd','4k','2k','8k','sd','hq','720p','360p','480p','576p','1080p','2160p','plus1','latin','mex','bar'];

function canonId(id) {
  let base = id.replace(/@[^@]*$/, '');
  const toks = base.toLowerCase().match(/[a-z0-9]+/g) || [];
  return toks.filter(t => !QUALITY.includes(t)).join('');
}
function normalize(s) {
  const toks = (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return toks.filter(t => !QUALITY.includes(t)).join(' ');
}
function loose(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function xmltvTime(ts) {
  const m = ts.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2}):?(\d{2})?$/);
  if (!m) return null;
  const [ , Y, Mo, D, H, Mi, S, sign, offH, offM] = m;
  const utc = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  const off = (sign[0] === '-' ? -1 : 1) * ((+(offH || 0)) * 3600 + (+(offM || 0)) * 60) * 1000;
  return utc - off; // ms epoch
}

function parseXMLTV(text) {
  const channels = {};   // id -> {id, displayNames:[], logos:[]}
  const programs = {};   // id -> [{start,stop,title,desc,cat}]
  const nameMap = {};    // "i:<canon>" -> id, "n:<norm>" -> id, "l:<loose>" -> id

  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = channelRe.exec(text))) {
    const attrs = m[1];
    const body = m[2];
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
    const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
    (programs[chId] = programs[chId] || []).push({
      start, stop, title: dec(title), desc: dec(desc), cat: dec(cat),
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
function playStream(url) {
  return new Promise((resolve, reject) => {
    if (vlcChild) { try { vlcChild.kill(); } catch (_) {} vlcChild = null; }
    const args = ['--fullscreen', url];
    const child = spawn(VLC, args, { detached: false });
    vlcChild = child;
    child.on('error', e => reject(new Error('failed to launch VLC: ' + e.message)));
    child.once('spawn', () => resolve({ launched: true, url }));
  });
}
function stopPlay() {
  if (vlcChild) { try { vlcChild.kill(); } catch (_) {} vlcChild = null; }
  return { stopped: true };
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (p === '/health') return sendJSON(res, 200, { ok: true, ts: Date.now() });

    if (p === '/parse/m3u' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const { src } = JSON.parse(body);
      const text = await fetchText(src);
      const parsed = parseM3U(text);
      return sendJSON(res, 200, parsed);
    }

    if (p === '/parse/xmltv' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const { src } = JSON.parse(body);
      const text = await fetchText(src);
      const parsed = parseXMLTV(text);
      return sendJSON(res, 200, {
        channelCount: Object.keys(parsed.channels).length,
        programCount: Object.values(parsed.programs).reduce((a, l) => a + l.length, 0),
        ...parsed,
      });
    }

    if (p === '/match' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const { m3u, xmltv } = JSON.parse(body);
      const m3uText = await fetchText(m3u);
      const xmlText = await fetchText(xmltv);
      const playlist = parseM3U(m3uText);
      const guide = parseXMLTV(xmlText);
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
      let body = '';
      for await (const c of req) body += c;
      const { url } = JSON.parse(body);
      const r = await playStream(url);
      return sendJSON(res, 200, r);
    }

    if (p === '/stop' && req.method === 'POST') return sendJSON(res, 200, stopPlay());

    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('VLC EPG Web UI  →  http://127.0.0.1:' + PORT);
  console.log('VLC binary: ' + VLC);
});
