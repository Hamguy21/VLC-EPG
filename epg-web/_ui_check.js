
const $ = id => document.getElementById(id);
const stage = $('stage');
const state = { channels: [], groups: [], now: Date.now(), fav: new Set(), current: null };
let timer = null;
const LS_SOURCES = 'vlcEpgSources';
const LS_FAV = 'vlcEpgFavorites';

function loadFav() { try { state.fav = new Set(JSON.parse(localStorage.getItem(LS_FAV) || '[]')); } catch (_) {} }
function saveFav() { localStorage.setItem(LS_FAV, JSON.stringify([...state.fav])); }

function toast(msg, isErr) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  t.style.background = isErr ? '#3a2226' : '#222a38';
  setTimeout(() => t.classList.remove('show'), 3200);
}
async function post(path, body) {
  const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function setStatus(text, kind) {
  const s = $('status'); s.textContent = text; s.className = 'status ' + (kind || '');
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(ms) {
  const d = new Date(ms);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function nowProgram(ch, at) {
  for (const p of (ch.programs || [])) {
    if (p.start <= at && p.stop > at) return p;
    if (p.start > at) break;
  }
  return null;
}

/* ---------- sources (add / load / rename / delete) ---------- */
function savedSources() { try { return JSON.parse(localStorage.getItem(LS_SOURCES) || '[]'); } catch (_) { return []; } }
function writeSources(list) { localStorage.setItem(LS_SOURCES, JSON.stringify(list)); }
function selectedSource() {
  const name = $('saved').value;
  return savedSources().find(s => s.name === name) || null;
}
function refreshSavedDropdown(selectedName) {
  const dd = $('saved'); const list = savedSources();
  dd.innerHTML = '<option value="">— none —</option>' + list.map(s =>
    `<option ${s.name === selectedName ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
}
// Save current playlist/EPG as a named source (add or overwrite)
$('saveSrc').addEventListener('click', () => {
  const m3u = $('m3u').value.trim();
  const xmltv = $('xmltv').value.trim();
  if (!m3u) { toast('Enter a playlist first', true); return; }
  let name = prompt('Name this saved source:', '');
  if (!name) return;
  name = name.trim();
  if (!name) return;
  const list = savedSources();
  const existing = list.findIndex(s => s.name === name);
  if (existing >= 0) {
    if (!confirm('A source named "' + name + '" already exists. Overwrite it?')) return;
    list[existing] = { name, m3u, xmltv };
  } else {
    list.push({ name, m3u, xmltv });
  }
  writeSources(list);
  refreshSavedDropdown(name);
  toast('Saved: ' + name);
});
// Load the selected source into the inputs and fetch it
$('loadSaved').addEventListener('click', () => {
  const s = selectedSource();
  if (!s) { toast('Select a saved source first', true); return; }
  $('m3u').value = s.m3u;
  $('xmltv').value = s.xmltv || '';
  loadGuide();
});
// Delete the selected source
$('delSaved').addEventListener('click', () => {
  const s = selectedSource();
  if (!s) { toast('Select a saved source first', true); return; }
  if (!confirm('Delete source "' + s.name + '"?')) return;
  writeSources(savedSources().filter(x => x.name !== s.name));
  refreshSavedDropdown('');
  toast('Deleted: ' + s.name);
});
// Rename the selected source
$('editSaved').addEventListener('click', () => {
  const s = selectedSource();
  if (!s) { toast('Select a saved source first', true); return; }
  const name = prompt('New name for "' + s.name + '":', s.name);
  if (!name) return;
  const nn = name.trim();
  if (!nn) return;
  const list = savedSources().filter(x => x.name !== s.name);
  list.push({ name: nn, m3u: s.m3u, xmltv: s.xmltv });
  writeSources(list);
  refreshSavedDropdown(nn);
  toast('Renamed: ' + nn);
});

/* ---------- loaders ---------- */
async function loadGuide() {
  const m3u = $('m3u').value.trim();
  const xmltv = $('xmltv').value.trim();
  if (!m3u) { toast('Enter an M3U playlist address first', true); return; }
  setStatus('Parsing playlist + downloading EPG…');
  showLoading(true);
  try {
    let guide = xmltv;
    const m = await post('/parse/m3u', { src: m3u });
    if (!guide && m.headerEpg) { guide = m.headerEpg; $('xmltv').value = guide; }
    if (!guide) {
      state.channels = m.channels.map((c, i) => ({ ...c, _src: i, programs: [], epg: null, matchHow: null }));
      state.groups = m.groupList;
      render();
      setStatus(m.channels.length + ' channels loaded (no EPG source auto-found). Click a channel to play.');
      return;
    }
    const match = await post('/match', { m3u, xmltv: guide });
    state.channels = match.channels.map((c, i) => ({ ...c, _src: i }));
    state.groups = match.groups;
    render();
    const withEpg = match.channels.filter(c => c.epg).length;
    setStatus(match.channels.length + ' channels · ' + match.matched + ' with EPG (' +
      match.stats.id + ' by id, ' + match.stats.name + ' by name). Click any channel to play.');
  } catch (e) {
    setStatus('Failed: ' + e.message, 'err');
    toast('Load failed: ' + e.message, true);
  } finally { showLoading(false); }
}

async function sample() {
  $('m3u').value = 'https://iptv-org.github.io/iptv/index.m3u';
  $('xmltv').value = '';
  await loadGuide();
}

// Auto-grab: ask the server to find matching EPG guides for the current playlist.
async function autoGrab() {
  const m3u = $('m3u').value.trim();
  if (!m3u) { toast('Enter an M3U playlist first', true); return; }
  setStatus('Auto-grabbing EPG guides… (this may take a few seconds)');
  showLoading(true);
  try {
    const j = await post('/grab', { m3u });
    state.channels = j.channels.map((c, i) => ({ ...c, _src: i }));
    state.groups = j.groups;
    $('xmltv').value = ''; // clears the manual source; the grab result is in memory
    render();
    const msg = j.matched + ' of ' + j.total + ' channels matched (' +
      j.stats.id + ' by id, ' + j.stats.name + ' by name) from ' +
      j.codes.length + ' guide(s)';
    setStatus(j.failures && j.failures.length ? msg + ' · errors: ' + j.failures.join('; ') : msg);
    toast('Auto EPG: ' + msg);
  } catch (e) {
    setStatus('Auto-grab failed: ' + e.message, 'err');
    toast('Auto-grab failed: ' + e.message, true);
  } finally {
    showLoading(false);
  }
}

/* ---------- rendering ---------- */
function showLoading(on) {
  let el = document.querySelector('.loading');
  if (on) {
    if (el) return;
    el = document.createElement('div'); el.className = 'loading';
    el.innerHTML = '<div style="display:flex;gap:10px;align-items:center"><div class="spin"></div> Loading…</div>';
    stage.appendChild(el);
  } else if (el) el.remove();
}

function buildRuler(halfHours, pxPerHour, now) {
  let html = '<div class="ruler">';
  for (let h = -halfHours; h <= halfHours; h++) {
    const t = new Date(now + h * 3600e3);
    const left = (h + halfHours) * pxPerHour;
    const label = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
    html += `<div class="tick" style="left:${left}px">${label}</div>`;
  }
  return html + '</div>';
}
function favKey(ch) { return ch.tvg_id || ch.name; }

function render() {
  const now = Date.now();
  const halfHours = parseInt($('window').value, 10);
  const pxPerHour = 240;
  const totalW = halfHours * 2 * pxPerHour;
  const start = now - halfHours * 3600e3;
  const end = now + halfHours * 3600e3;

  const selGroup = $('group').value;
  const filterMode = $('filter').value;
  const q = $('q').value.trim().toLowerCase();
  let channels = state.channels;
  if (selGroup) channels = channels.filter(c => c.group === selGroup);
  if (filterMode === 'fav') channels = channels.filter(c => state.fav.has(favKey(c)));
  if (filterMode === 'epg') channels = channels.filter(c => c.epg);
  if (q) {
    channels = channels.filter(c => c.name.toLowerCase().includes(q) ||
      (c.programs || []).some(p => p.title.toLowerCase().includes(q)));
  }

  const grp = $('group');
  grp.innerHTML = '<option value="">All channels</option>' +
    state.groups.map(g => `<option ${g===selGroup?'selected':''}>${escapeHtml(g)}</option>`).join('');

  let html = buildRuler(halfHours, pxPerHour, now);
  html += '<div class="grid" style="width:' + totalW + 'px">';

  channels.forEach((ch, idx) => {
    const isFav = state.fav.has(favKey(ch));
    const np = nowProgram(ch, now);
    const isPlaying = state.current && state.current.url === ch.url;

    html += '<div class="row' + (isPlaying ? ' playing' : '') + '" id="row-' + idx + '" data-src="' + (ch._src != null ? ch._src : idx) + '">';
    html += '<div class="ch">';
    if (ch.logo) html += `<img src="${escapeHtml(ch.logo)}" loading="lazy" onerror="this.style.display='none'">`;
    html += '<div class="cinfo">';
    html += '<div class="name">' + escapeHtml(ch.name) + '</div>';
    if (np) html += `<div class="nowprog"><span class="t">${fmtTime(np.start)}–${fmtTime(np.stop)}</span> ${escapeHtml(np.title)}</div>`;
    else if (ch.epg) html += '<div class="nowprog" style="color:var(--muted)">no program at this time</div>';
    else html += '<div class="nowprog" style="color:var(--muted)">no EPG info</div>';
    if (ch.group) html += `<div class="group">${escapeHtml(ch.group)}</div>`;
    html += '</div>';
    html += `<button class="star ${isFav?'on':''}" data-idx="${idx}" title="Favorite">★</button>`;
    html += '</div>'; // ch

    const progs = (ch.programs || []).filter(p => p.stop > start && p.start < end);
    if (progs.length === 0) {
      const CH_W = 240; // sticky channel column width; start fallback to its right
      html += `<div class="prog noinfo" style="left:${CH_W}px;width:${totalW - CH_W}px">${ch.epg ? 'No program in this window' : 'No EPG data — click the channel to play anyway'}</div>`;
    }
    for (const p of progs) {
      const left = Math.max(0, (p.start - start) / 3600e3) * pxPerHour;
      const right = Math.min(totalW, (p.stop - start) / 3600e3) * pxPerHour;
      const w = right - left;
      if (w < 6) continue;
      const isNow = p.start <= now && p.stop > now;
      const tl = `${fmtTime(p.start)}–${fmtTime(p.stop)}`;
      html += `<div class="prog ${isNow?'now':''}" style="left:${left}px;width:${w}px" ` +
        `data-idx="${idx}" data-tt="${escapeHtml(p.title)}" data-desc="${escapeHtml(p.desc||'')}" data-cat="${escapeHtml(p.cat||'')}" data-start="${p.start}" data-stop="${p.stop}">` +
        `<div class="t">${tl}</div>` +
        `<div class="tt">${escapeHtml(p.title)}</div>` +
        (p.cat ? `<div class="d">${escapeHtml(p.cat)}</div>` : '') +
        '</div>';
    }
    html += '</div>'; // row
  });

  // now-line must live inside the grid so it spans the full content height
  const nowLeft = halfHours * pxPerHour;
  html += `<div class="nowline" style="left:${nowLeft}px"></div>`;
  html += '</div>'; // grid

  stage.innerHTML = html;
  stage.scrollLeft = Math.max(0, nowLeft - stage.clientWidth / 2);

  // click channel row -> show channel details (unless clicking star)
  stage.querySelectorAll('.row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.star')) return;
      const idx = parseInt(row.id.split('-')[1], 10);
      const ch = channels[idx];
      if (!ch) return;
      showChannelDetails(ch);
    });
  });

  // click program -> details panel
  stage.querySelectorAll('.prog:not(.noinfo)').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.idx, 10);
      const ch = channels[idx];
      showDetails(ch, {
        title: el.dataset.tt, desc: el.dataset.desc, cat: el.dataset.cat,
        start: parseInt(el.dataset.start,10), stop: parseInt(el.dataset.stop,10)
      });
    });
  });

  stage.querySelectorAll('.star').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const ch = channels[parseInt(el.dataset.idx,10)];
      if (!ch) return;
      const k = favKey(ch);
      if (state.fav.has(k)) state.fav.delete(k); else state.fav.add(k);
      saveFav(); render();
      toast(state.fav.has(k) ? '★ Added to favorites' : 'Removed from favorites');
    });
  });

  clearInterval(timer);
  timer = setInterval(() => {
    const nl = stage.querySelector('.nowline');
    if (nl) nl.style.left = ($('window').value * 240) + 'px';
  }, 60000);
}

/* ---------- play + details ---------- */
function playChannel(ch) {
  if (!ch || !ch.url) { toast('No stream URL for this channel', true); return; }
  state.current = { url: ch.url, name: ch.name };
  render();
  Promise.resolve(post('/play', { url: ch.url }))
    .then(() => {
      updateNowBar(ch);
      toast('▶ ' + ch.name);
    })
    .catch(e => toast('Play failed: ' + e.message, true));
}

function updateNowBar(ch) {
  const bar = $('nowbar');
  bar.style.display = 'flex';
  $('nbCh').textContent = ch.name;
  const np = nowProgram(ch, Date.now());
  $('nbProg').textContent = np ? ('Now: ' + np.title) : '▶ playing';
  $('nbTime').textContent = np ? (fmtTime(np.start) + '–' + fmtTime(np.stop)) : '';
}

function openDetails() { $('details').classList.add('open'); }
function closeDetails() { $('details').classList.remove('open'); }

// Show an image card in the drawer when a usable (http/https) icon exists.
function setDrawerIcon(url) {
  const wrap = $('dIcon'), img = $('dIconImg');
  const usable = url && /^https?:\/\//i.test(url);
  img.classList.add('hidden');
  if (usable) {
    img.onerror = () => { wrap.style.display = 'none'; };
    img.onload = () => { wrap.style.display = 'block'; img.classList.remove('hidden'); };
    img.src = url;
  } else {
    img.onerror = null; img.onload = null; img.removeAttribute('src');
    wrap.style.display = 'none';
  }
}

function showDetails(ch, p) {
  $('dTitle').textContent = p.title || ch.name;
  $('dSub').textContent = ch.name + (p.cat ? ' · ' + p.cat : '');
  $('dTime').textContent = (p.start && p.stop) ? (fmtTime(p.start) + ' – ' + fmtTime(p.stop)) : '';
  $('dDesc').textContent = p.desc || 'No synopsis available.';
  $('dList').innerHTML = '';
  setDrawerIcon((p.icon && p.icon.trim()) || (ch.logo && ch.logo.trim()));
  $('dPlay').onclick = () => { playChannel(ch); };
  openDetails();
}

// Clicking a channel opens the bottom drawer: channel info, now program, upcoming list.
function showChannelDetails(ch) {
  const np = nowProgram(ch, Date.now());
  $('dTitle').textContent = ch.name;
  $('dSub').textContent = (ch.group ? ch.group : '') + (ch.epg ? ' · has EPG' : ' · no EPG');
  $('dTime').textContent = np ? ('Now: ' + np.title + '  ' + fmtTime(np.start) + '–' + fmtTime(np.stop)) : '';
  $('dDesc').textContent = np ? (np.desc || '') : 'No program information available for this channel.';
  setDrawerIcon((np && np.icon && np.icon.trim()) || (ch.logo && ch.logo.trim()));
  // upcoming program list
  const now = Date.now();
  const upcoming = (ch.programs || []).filter(p => p.stop > now).slice(0, 10);
  if (upcoming.length) {
    $('dList').innerHTML = '<div class="dl-head">Upcoming</div>' + upcoming.map(p =>
      `<div class="dl-item" data-start="${p.start}" data-stop="${p.stop}" ` +
      `data-tt="${escapeHtml(p.title)}" data-desc="${escapeHtml(p.desc||'')}" ` +
      `data-cat="${escapeHtml(p.cat||'')}"><span class="dl-time">${fmtTime(p.start)}</span> ${escapeHtml(p.title)}</div>`).join('');
    $('dList').querySelectorAll('.dl-item').forEach(it => {
      it.addEventListener('click', () => {
        showDetails(ch, { title: it.dataset.tt, desc: it.dataset.desc, cat: it.dataset.cat,
          start: +it.dataset.start, stop: +it.dataset.stop });
      });
    });
  } else {
    $('dList').innerHTML = '';
  }
  $('dPlay').onclick = () => { playChannel(ch); };
  openDetails();
}

/* events */
$('load').addEventListener('click', loadGuide);
$('sample').addEventListener('click', sample);
$('grab').addEventListener('click', autoGrab);
$('group').addEventListener('change', () => { if (state.channels.length) render(); });
$('filter').addEventListener('change', () => { if (state.channels.length) render(); });
$('q').addEventListener('input', () => { if (state.channels.length) render(); });
$('window').addEventListener('change', () => { if (state.channels.length) render(); });
$('m3u').addEventListener('keydown', e => { if (e.key === 'Enter') loadGuide(); });
$('xmltv').addEventListener('keydown', e => { if (e.key === 'Enter') loadGuide(); });
$('dClose').addEventListener('click', closeDetails);

// Horizontal wheel-scroll over the timeline (scroll rows left/right).
stage.addEventListener('wheel', (e) => {
  // Only intercept when there's horizontal overflow and the pointer is over the
  // program area (right of the sticky channel column).
  if (stage.scrollWidth <= stage.clientWidth) return;
  const r = stage.getBoundingClientRect();
  if (e.clientX - r.left < 240) return; // over the channel column -> keep vertical
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    stage.scrollLeft += e.deltaY;
  }
}, { passive: false });

/* ---------- jump-to-channel autocomplete ---------- */
(function setupJump() {
  const input = document.getElementById('chJump');
  const box = document.getElementById('chJumpResults');
  if (!input || !box) return;

  const LIMIT = 60;
  let active = -1;
  let matches = [];

  function close() { box.classList.remove('open'); box.innerHTML = ''; active = -1; }

  function renderResults() {
    if (!matches.length) {
      box.innerHTML = '<div class="jr-none">no channel matches</div>';
    } else {
      box.innerHTML = matches.map((m, i) =>
        `<div class="jr ${i===active?'active':''}" data-i="${i}">${escapeHtml(m.name)}` +
        (m.group ? `<span class="g">${escapeHtml(m.group)}</span>` : '') + '</div>').join('');
    }
    box.classList.add('open');
  }

  function jumpTo(m) {
    close();
    input.value = '';
    // clear filters so the channel is visible, then scroll
    $('group').value = ''; $('filter').value = 'all'; $('q').value = '';
    render();
    const el = document.querySelector(`.row[data-src="${m._src}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    matches = state.channels.filter(c => c.name.toLowerCase().includes(q)).slice(0, LIMIT);
    active = -1;
    renderResults();
  });

  input.addEventListener('keydown', (e) => {
    if (!box.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); renderResults(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderResults(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[active]) jumpTo(matches[active]); else if (matches[0]) jumpTo(matches[0]); }
    else if (e.key === 'Escape') { close(); }
  });

  box.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.jr');
    if (it) jumpTo(matches[parseInt(it.dataset.i, 10)]);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
})();

loadFav();
refreshSavedDropdown('');
