const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const el = (t, p = {}, ...c) => { const e = Object.assign(document.createElement(t), p); e.append(...c); return e; };
const clean = e => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const dur = s => { if (!s || s < 0) return 'LIVE'; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const HELP = `Install yt-dlp to play videos when Piped is blocked by YouTube:

  mkdir -p ~/.local/bin
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ~/.local/bin/yt-dlp
  chmod +x ~/.local/bin/yt-dlp

Then restart MyTube. Settings → Test yt-dlp checks that it works. (Node.js is used as yt-dlp's JavaScript runtime.)`;

// errors from anywhere end up in the app log (Logs tab)
window.addEventListener('error', e => api.logUi('error', `${e.message} @${String(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => api.logUi('error', 'unhandled: ' + clean(e.reason || 'unknown')));
const origErr = console.error; console.error = (...a) => { api.logUi('error', a.map(String).join(' ')); origErr(...a); };
const fail = (ctx, e) => { const m = clean(e); api.logUi('warn', `${ctx}: ${m.split('\n')[0]}`); setTimeout(() => maybeSuggest(), 0); return m; };

let P, view = 'home', mode = 'feed', limit = 0, catLabel = null, current = null, tries = [], tryIdx = 0, unbindFns = [], plOpen = null, pickRef = null;
let S = { q: '', type: 'videos', next: null, items: [] };
let C = { id: null, name: '', next: null, items: [], playlistsTab: null, pl: null }, chTab = 'videos', chSort = 'latest';
let Y = { id: null, name: '', next: null, items: [] };
let subSort = 'latest', subFilter = null, subsManage = false, auto = null, autoTimer = null;
const setStatus = t => { $('#status').textContent = t || ''; };
const isSub = id => P.subscriptions.some(c => c.id === id);
const orderedSubs = () => [...P.subscriptions.filter(c => c.pinned), ...P.subscriptions.filter(c => !c.pinned)];
const videoRef = v => ({ id: v.id, title: v.title, channelId: v.channelId, channelName: v.channelName, thumbnail: v.thumbnail, duration: v.duration });
const shuffled = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function sortVideos(items, m) {
  const a = [...items];
  if (m === 'popular') return a.sort((x, y) => (y.views || 0) - (x.views || 0));
  const dated = a.every(v => v.published);
  if (m === 'oldest') return dated ? a.sort((x, y) => x.published - y.published) : a.reverse();
  return dated ? a.sort((x, y) => y.published - x.published) : a;
}

// ---------- settings schema (drives Settings and both Algorithm modes) ----------
const FIELDS = [
  { g: 'Appearance', k: 'navLayout', l: 'Navigation', t: 'select', o: [['top', 'Top bar'], ['sidebar', 'Sidebar']] },
  { g: 'Appearance', k: 'sidebarSide', l: 'Sidebar position', t: 'select', o: [['left', 'Left'], ['right', 'Right']] },
  { g: 'Appearance', k: 'sidebarAuto', l: 'Sidebar auto-collapse', t: 'select', o: [['off', 'Never'], ['narrow', 'When the window is narrow'], ['hover', 'Icons only, expand on hover']] },
  { g: 'Appearance', k: 'windowFrame', l: 'Window bar (restart to apply)', t: 'select', o: [['custom', 'MyTube (drag from bar or sidebar)'], ['system', 'System']] },
  { g: 'Appearance', k: 'theme', l: 'Theme', t: 'select', o: ['dark', 'light', 'system'] },
  { g: 'Appearance', k: 'accent', l: 'Accent color', t: 'color' },
  { g: 'Appearance', k: 'cardSize', l: 'Card size (px)', t: 'range', min: 180, max: 420, step: 10 },
  { g: 'Appearance', k: 'showChannelNames', l: 'Show channel names', t: 'check' },
  { g: 'Subscriptions', k: 'showSubsList', l: 'Show channel list', t: 'check' },
  { g: 'Subscriptions', k: 'subsVisibleCount', l: 'Channels shown before "Show all"', t: 'range', min: 0, max: 40, step: 1 },
  { g: 'Feed', k: 'feedSize', l: 'Videos per page', t: 'range', min: 20, max: 200, step: 10 },
  { g: 'Feed', k: 'shortsEnabled', l: 'Show Shorts', t: 'check' },
  { g: 'Feed', k: 'regions', l: 'Trending regions (up to 4, e.g. US, NO, GB)', t: 'text' },
  { g: 'Feed', k: 'refreshMinutes', l: 'Auto-refresh every (min)', t: 'range', min: 5, max: 120, step: 5 },
  { g: 'Playback', k: 'autoplay', l: 'Autoplay', t: 'check' },
  { g: 'Playback', k: 'defaultQuality', l: 'Quality', t: 'select', o: [['auto', 'Auto (adapts to your connection)'], [360, '360p'], [480, '480p'], [720, '720p'], [1080, '1080p']] },
  { g: 'Playback', k: 'ytdlpFallback', l: 'Allow direct YouTube access when Piped fails (yt-dlp, RSS)', t: 'check' },
  { g: 'Playback', dev: true, k: 'autoMaxQuality', l: 'Auto: highest quality allowed', t: 'select', o: [[480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '1440p']] },
  { g: 'Playback', dev: true, k: 'playbackSource', l: 'Stream source', t: 'select', o: [['piped', 'Piped first (more private)'], ['ytdlp', 'yt-dlp first (more reliable)']] },
  { g: 'Playback', dev: true, k: 'ytdlpPath', l: 'yt-dlp path', t: 'text' },
  { g: 'Playback', dev: true, k: 'ytdlpArgs', l: 'Extra yt-dlp arguments', t: 'text' },
  { g: 'Debug', dev: true, k: 'logLevel', l: 'App log detail', t: 'select', o: ['debug', 'info', 'warn'] },
  { g: 'Debug', dev: true, k: 'logFullIds', l: 'Log full video/channel IDs (default: short tags)', t: 'check' },
  { g: 'Developer', k: 'devMode', l: 'Developer mode (Instances, Logs, advanced options)', t: 'check' },
  // simple algorithm controls
  { g: 'Simple', k: 'explorationRatio', l: 'Variety (mix in new channels)', t: 'range', min: 0, max: 0.6, step: 0.05 },
  { g: 'Simple', k: 'subShare', l: 'Share of the feed from my subscriptions', t: 'range', min: 0, max: 0.8, step: 0.05 },
  { g: 'Simple', k: 'recencyWeight', l: 'Prefer new uploads', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Simple', k: 'maxPerChannel', l: 'Max videos per channel on a page', t: 'select', o: [[1, '1'], [2, '2'], [3, '3'], [5, '5'], [0, 'No limit']] },
  { g: 'Simple', k: 'interestHalfLifeDays', l: 'How fast your interests change', t: 'select', o: [[7, 'Fast (1 week)'], [21, 'Normal (3 weeks)'], [45, 'Slow (6 weeks)']] },
  { g: 'Simple', k: 'likeWeight', l: 'How strongly likes/dislikes steer the feed', t: 'select', o: [[1.5, 'Gentle'], [3, 'Normal'], [6, 'Strong']], also: v => ({ dislikeWeight: +(v * 1.3).toFixed(1) }) },
  // advanced algorithm controls (developer mode)
  { g: 'Algorithm', k: 'wChannel', l: 'Weight: channel you watch', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Algorithm', k: 'wTag', l: 'Weight: tags / title words', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Algorithm', k: 'wCategory', l: 'Weight: category', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Algorithm', k: 'likeWeight', l: 'Like counts as N full watches', t: 'range', min: 0, max: 10, step: 0.5 },
  { g: 'Algorithm', k: 'dislikeWeight', l: 'Dislike counts as N full watches (negative)', t: 'range', min: 0, max: 15, step: 0.5 },
  { g: 'Algorithm', k: 'subBoost', l: 'Score boost for subscribed channels', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Algorithm', k: 'channelRepeatPenalty', l: 'Penalty: same channel repeated', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Algorithm', k: 'categoryRepeatPenalty', l: 'Penalty: same category repeated', t: 'range', min: 0, max: 1, step: 0.05 },
  { g: 'Algorithm', k: 'minWatchRatio', l: 'Minimum credit per watch', t: 'range', min: 0, max: 0.5, step: 0.05 },
  { g: 'Algorithm', k: 'interestHalfLifeDays', l: 'Interest half-life (days)', t: 'range', min: 1, max: 120, step: 1 },
  { g: 'Algorithm', k: 'historyRetentionDays', l: 'Keep watch history (days)', t: 'range', min: 1, max: 365, step: 1 },
];
const PRESETS = {
  balanced: { label: 'Balanced', s: { explorationRatio: .2, channelRepeatPenalty: .25, categoryRepeatPenalty: .15, wChannel: .45, wTag: .35, wCategory: .2, interestHalfLifeDays: 21, subBoost: .3, subShare: .4, recencyWeight: .25, maxPerChannel: 2, likeWeight: 3, dislikeWeight: 4 } },
  focused: { label: 'Stay on topic', s: { explorationRatio: .08, channelRepeatPenalty: .1, categoryRepeatPenalty: .05, wChannel: .55, wTag: .3, wCategory: .15, interestHalfLifeDays: 30, subBoost: .4, subShare: .3, recencyWeight: .15, maxPerChannel: 3, likeWeight: 3, dislikeWeight: 4 } },
  discover: { label: 'Discover more', s: { explorationRatio: .4, channelRepeatPenalty: .4, categoryRepeatPenalty: .3, wChannel: .3, wTag: .35, wCategory: .35, interestHalfLifeDays: 14, subBoost: .2, subShare: .5, recencyWeight: .4, maxPerChannel: 1, likeWeight: 3, dislikeWeight: 4 } },
};
function applyUi(s) {
  const r = document.documentElement;
  r.dataset.theme = s.theme; r.style.setProperty('--acc', s.accent); r.style.setProperty('--card-min', s.cardSize + 'px');
  document.body.classList.toggle('hide-ch', !s.showChannelNames);
}
async function loadProfile() { P = await api.profile(); applyUi(P.settings); }
async function setSetting(patch) { await api.setSettings(patch); await loadProfile(); renderNav(); if (view === 'subs') renderSubs(); }
const visible = f => !f.dev || P.settings.devMode;
function fieldEl(f) {
  const v = P.settings[f.k]; let input;
  if (f.t === 'check') input = el('input', { type: 'checkbox', checked: !!v });
  else if (f.t === 'select') {
    const opts = f.o.map(o => Array.isArray(o) ? o : [o, o]);
    if (!opts.some(([x]) => String(x) === String(v))) opts.push([v, `Custom (${v})`]);
    input = el('select', {}, ...opts.map(([x, label]) => el('option', { value: String(x), selected: String(v) === String(x) }, String(label))));
  }
  else if (f.t === 'range') input = el('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: v });
  else if (f.t === 'color') input = el('input', { type: 'color', value: v });
  else input = el('input', { type: 'text', value: v });
  const val = el('span', { className: 'muted' }, f.t === 'range' ? String(v) : '');
  if (f.t === 'range') input.oninput = () => { val.textContent = input.value; };
  input.onchange = async () => {
    const x = f.t === 'check' ? input.checked : input.value;
    await setSetting({ [f.k]: x, ...(f.also ? f.also(+x) : {}) });
    if (f.g !== 'Playback' && f.g !== 'Debug') limit = 0;
    if (f.also) renderAlgo();
    if (f.k === 'windowFrame') setStatus('Restart MyTube to apply the window bar change.');
    if (f.k === 'regions') renderSettings();
    if (f.k === 'devMode') { if (!P.settings.devMode && ['instances', 'logs'].includes(view)) goView('home'); renderSettings(); }
  };
  return el('label', { className: 'field' }, el('span', {}, f.l), input, val);
}
function renderFields(root, groups) {
  root.replaceChildren(...groups.flatMap(g => {
    const fs = FIELDS.filter(f => f.g === g && visible(f));
    return fs.length ? [el('h3', {}, g === 'Simple' ? 'Feed behaviour' : g === 'Algorithm' ? 'Advanced algorithm (developer)' : g), ...fs.map(fieldEl)] : [];
  }));
}

// ---------- navigation (top bar or sidebar) ----------
const NAV = [['home', '🏡', 'Home'], ['subs', '📡', 'Subscriptions'], ['playlists', '📚', 'Playlists'], ['algo', '🎛️', 'For you'],
  ['settings', '🛠️', 'Settings'], ['instances', '🛰️', 'Instances', true], ['logs', '🧾', 'Logs', true]];   // [view, icon, label, developer-only]
const navItems = () => NAV.filter(n => !n[3] || P.settings.devMode);
function navClasses() {
  const s = P.settings, side = s.navLayout === 'sidebar', auto = s.sidebarAuto, narrow = window.innerWidth < 1000, b = document.body.classList;
  b.toggle('sidebar', side); b.toggle('side-right', side && s.sidebarSide === 'right'); b.toggle('side-hover', side && auto === 'hover');
  b.toggle('side-collapsed', side && auto !== 'hover' && (s.sidebarCollapsed || (auto === 'narrow' && narrow)));
  b.toggle('frameless', s.windowFrame !== 'system');
}
window.addEventListener('resize', () => { if (P) navClasses(); });
function renderNav() {
  const side = P.settings.navLayout === 'sidebar';
  navClasses();
  // the same controls move between the top bar and the sidebar (sidebar mode has no top bar)
  if (side) { $('#sidetop').append($('#logo'), $('#winctl')); $('#sidetools').append($('#tools')); }
  else { $('header').prepend($('#logo')); $('header').append($('#tools'), $('#winctl')); }
  $('#winctl').hidden = P.settings.windowFrame === 'system';
  $('#topnav').replaceChildren(); $('#sidenav').replaceChildren();
  (side ? $('#sidenav') : $('#topnav')).replaceChildren(...navItems().map(([v, ic, l]) => {
    const b = el('button', { className: v === view ? 'on' : '', title: l }, el('span', { className: 'ic' }, ic), el('span', { className: 'lb' }, l));
    b.dataset.view = v; b.onclick = () => navTo(v); return b;
  }));
  $('#sidetoggle').textContent = P.settings.sidebarCollapsed ? '⇥' : '⇤'; $('#sidetoggle').hidden = !side || P.settings.sidebarAuto === 'hover';
  renderSideSubs();
}
$('#sidetoggle').onclick = () => setSetting({ sidebarCollapsed: !P.settings.sidebarCollapsed });
$$('#winctl button').forEach(b => { b.onclick = () => api.winCtl(b.dataset.w); });
function renderSideSubs() {
  const box = $('#sidesubs'), s = P.settings, on = s.navLayout === 'sidebar' && s.showSubsList;
  box.hidden = !on; if (!on) return;
  const subs = orderedSubs(), n = s.subsExpanded ? subs.length : +s.subsVisibleCount;
  box.replaceChildren(
    el('div', { className: 'sh' }, el('b', { className: 'lb' }, `Subscriptions (${subs.length})`), el('button', { title: 'Hide this list', onclick: () => setSetting({ showSubsList: false }) }, '✕')),
    el('div', { className: 'sl' }, ...subs.slice(0, n).map(c => el('div', { className: 'sitem', title: c.name, onclick: () => openChannel(c.id, c.name) }, (c.pinned ? '★ ' : '') + c.name))),
    ...(subs.length > +s.subsVisibleCount ? [el('button', { onclick: () => setSetting({ subsExpanded: !s.subsExpanded }) }, s.subsExpanded ? 'Show less' : `Show all (${subs.length})`)] : []));
}
function goView(v) {
  if (NAV.find(n => n[0] === v)?.[3] && !P.settings.devMode) v = 'home';
  view = v;
  $$('#topnav button, #sidenav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  for (const [n] of NAV) $('#view-' + n).hidden = n !== v;
  if (v === 'subs') renderSubs(true); if (v === 'playlists') renderPlaylists(); if (v === 'algo') renderAlgo(); if (v === 'settings') renderSettings();
  if (v === 'instances') api.instances().then(renderInstances); if (v === 'logs') renderLogs();
}
function navTo(v) {
  if (v === 'home') { goView('home'); mode === 'feed' ? loadHome(true) : backToFeed(); }
  else { if (v === 'playlists') plOpen = null; goView(v); }
}

// ---------- ratings, playlist picker ----------
async function rate(ref, r) {
  const n = await api.rate(ref, r);
  if (n) P.ratingMap[ref.id] = n; else delete P.ratingMap[ref.id];
  return n;
}
function pickPlaylist(v) {
  pickRef = videoRef(v);
  const box = $('#plpickList');
  const paint = () => box.replaceChildren(...P.playlists.map(pl => {
    const has = pl.videos.some(x => x.id === pickRef.id);
    return el('button', { className: 'chip' + (has ? ' on' : ''), type: 'button', onclick: async () => {
      P.playlists = has ? await api.plRemove(pl.id, pickRef.id) : await api.plAdd(pl.id, pickRef); paint();
    } }, `${pl.name} (${pl.videos.length})`);
  }));
  paint(); $('#plpickname').value = ''; $('#plpick').showModal();
}
$('#plpickcreate').onclick = async () => {
  const name = $('#plpickname').value.trim(); if (!name || !pickRef) return;
  const r = await api.plCreate(name); P.playlists = await api.plAdd(r.id, pickRef); pickPlaylist(pickRef);
};
$('#plpickclose').onclick = () => { $('#plpick').close(); if (view === 'playlists') renderPlaylists(); };

// ---------- cards, grids ----------
const thumbEl = v => v.thumbnail ? el('img', { src: v.thumbnail, loading: 'lazy' }) : el('div', { className: 'ph' });
function card(v) {
  const ref = videoRef(v);
  const ch = el('div', { className: 'muted ch' }, v.channelName || '');
  if (v.channelId) ch.onclick = e => { e.stopPropagation(); openChannel(v.channelId, v.channelName); };
  const like = el('button', { title: 'Like (strong signal)', textContent: '👍' }), dis = el('button', { title: 'Dislike (hide, and show less like it)', textContent: '👎' });
  const add = el('button', { title: 'Add to playlist', textContent: '＋' }), mute = el('button', { title: 'Mute this channel', textContent: '✕' });
  const paint = () => { const r = P.ratingMap[v.id] || 0; like.classList.toggle('on', r === 1); dis.classList.toggle('on', r === -1); };
  paint();
  like.onclick = async e => { e.stopPropagation(); await rate(ref, 1); paint(); };
  dis.onclick = async e => { e.stopPropagation(); if (await rate(ref, -1) === -1) c.remove(); else paint(); };
  add.onclick = e => { e.stopPropagation(); pickPlaylist(v); };
  mute.onclick = async e => { e.stopPropagation(); if (!v.channelId) return; await api.muteChannel({ id: v.channelId, name: v.channelName }); await loadProfile(); c.remove(); };
  const badges = el('div', { className: 'badges' });
  if (v.reason === 'explore') badges.append(el('span', { className: 'badge' }, 'Explore'));
  if (v.sub) badges.append(el('span', { className: 'badge sub' }, 'Subscribed'));
  const c = el('article', { className: 'card' },
    el('div', { className: 'thumb' }, v.thumbnail ? el('img', { src: v.thumbnail, loading: 'lazy' }) : '', el('span', { className: 'dur' }, dur(v.duration)), badges, el('div', { className: 'acts' }, like, dis, add, mute)),
    el('div', { className: 'info' }, el('b', {}, v.title || ''), ch));
  c.onclick = () => openVideo(v);
  return c;
}
function renderGrid(items, target = $('#grid')) { target.classList.remove('list'); target.replaceChildren(...items.map(card)); }
function subBtn(c) {
  const b = el('button', {});
  const paint = () => { b.textContent = isSub(c.id) ? 'Subscribed ✓' : 'Subscribe'; b.classList.toggle('on', isSub(c.id)); };
  paint();
  b.onclick = async e => { e.stopPropagation(); P.subscriptions = isSub(c.id) ? await api.subsRemove(c.id) : await api.subsAdd(c); paint(); renderSideSubs(); };
  return b;
}
function channelRow(c) {
  return el('div', { className: 'chrow' }, c.thumbnail ? el('img', { src: c.thumbnail, className: 'av' }) : el('div', { className: 'av' }),
    el('div', {}, el('b', {}, c.name), el('div', { className: 'muted' }, c.subscribers > 0 ? `${c.subscribers.toLocaleString()} subscribers` : '')),
    el('button', { onclick: () => openChannel(c.id, c.name) }, 'Open'), subBtn({ id: c.id, name: c.name }));
}
const tag = (text, onX, onClick) => el('span', { className: 'tag' }, el('span', { onclick: onClick || null }, text), el('button', { onclick: onX, title: 'Remove' }, '✕'));
const showEmpty = (t, show = true) => { $('#empty').hidden = !show; $('#empty').textContent = t; $('#empty').style.whiteSpace = 'pre-wrap'; };

// ---------- home, search ----------
function renderChips() {
  const bar = $('#chipbar'); bar.hidden = false;
  bar.replaceChildren(...['All', ...(P.seeds?.items || [])].map(n => {
    const b = el('button', { className: 'chip' + ((n === 'All' ? !catLabel : n === catLabel) ? ' on' : ''), type: 'button' }, n);
    b.onclick = () => { catLabel = n === 'All' ? null : n; limit = 0; renderChips(); loadHome(true); };
    return b;
  }), el('button', { className: 'chip ghost', type: 'button', onclick: () => openOnboard() }, '✎ Edit categories'));
}
let navTok = 0, spinTimer = null;
// Navigation rule: the old page disappears at once; if loading takes more than 3 s a spinner appears.
// Every async loader remembers navTok and drops its answer if the user has navigated elsewhere meanwhile.
function beginLoad(target = $('#grid')) {
  navTok++; clearTimeout(spinTimer); target.replaceChildren(); showEmpty('', false);
  spinTimer = setTimeout(() => target.replaceChildren(el('div', { className: 'spinwrap' }, el('div', { className: 'spinner' }))), 3000);
  return navTok;
}
async function loadHome(fresh = false) {
  mode = 'feed'; limit = limit || P.settings.feedSize;
  $('#subhead').hidden = true; $('#chipbar').hidden = false; $('#more').hidden = true;
  const my = fresh ? beginLoad() : navTok;
  try {
    const items = await api.getFeed(limit, catLabel);
    if (my !== navTok) return;
    clearTimeout(spinTimer); renderGrid(items); showEmpty('No videos yet. Press Refresh, or pick categories.', items.length === 0); $('#more').hidden = false;
  } catch (e) { if (my === navTok) { clearTimeout(spinTimer); showEmpty('Error: ' + fail('feed', e)); } }
}
function setHead(title, back, ...extra) {
  const h = $('#subhead'); h.hidden = false; $('#chipbar').hidden = true;
  h.replaceChildren(el('button', { onclick: back }, '← Back'), el('b', {}, title), ...extra);
}
function backToFeed() { mode = 'feed'; $('#q').value = ''; renderChips(); loadHome(true); }

async function runSearch(q, type) {
  q = q.trim(); if (!q) return;
  mode = 'search'; S = { q, type, next: null, items: [] }; goView('home');
  setHead(`Search: “${q}” (${type})`, backToFeed); beginLoad(); $('#more').hidden = true;
  await searchMore();
}
async function searchMore() {
  const my = navTok;
  try {
    const r = await api.search(S.q, S.type, S.next); if (my !== navTok) return;
    clearTimeout(spinTimer); S.next = r.next; S.items = S.items.concat(r.items);
    if (S.type === 'channels') { $('#grid').classList.add('list'); $('#grid').replaceChildren(...S.items.map(channelRow)); } else renderGrid(S.items);
    showEmpty('No results.', S.items.length === 0); $('#more').hidden = !S.next;
  } catch (e) { if (my === navTok) { clearTimeout(spinTimer); showEmpty('Search failed: ' + fail('search', e)); } }
}

// ---------- channel page: videos (sortable), playlists ----------
function channelHead() {
  const sort = el('select', {}, ...[['latest', 'Latest'], ['popular', 'Most viewed'], ['oldest', 'Oldest']].map(([v, l]) => el('option', { value: v, selected: chSort === v }, l)));
  sort.onchange = () => changeChSort(sort.value);
  const tab = (id, label) => el('button', { className: 'chip' + (chTab === id ? ' on' : ''), type: 'button', onclick: () => { chTab = id; channelHead(); renderChannelTab(); } }, label);
  setHead(C.name || 'Channel', backToFeed, subBtn({ id: C.id, name: C.name || C.id }), tab('videos', 'Videos'), tab('playlists', 'Playlists'), ...(chTab === 'videos' ? [sort] : []));
}
async function openChannel(id, name) {
  mode = 'channel'; chTab = 'videos'; chSort = 'latest'; C = { id, name: name || '', next: null, items: [], playlistsTab: null, pl: null, noTab: false }; goView('home');
  channelHead(); beginLoad(); $('#more').hidden = true;
  await channelMore();
}
function renderChannelVideos() {
  renderGrid(sortVideos(C.items, chSort));
  showEmpty(C.noTab ? 'This channel has no Videos tab (music "Topic" channels and some others work that way).' : 'No videos found.', C.items.length === 0); $('#more').hidden = !C.next;
}
async function channelMore(quiet = false) {
  const my = navTok;
  try {
    const r = await api.channel(C.id, C.next); if (my !== navTok) return;
    clearTimeout(spinTimer); C.next = r.next; C.items = C.items.concat(r.items); C.playlistsTab = C.playlistsTab || r.playlistsTab; C.noTab = C.noTab || !!r.noVideosTab;
    if (r.name && !C.name) { C.name = r.name; channelHead(); }
    if (!quiet) renderChannelVideos();
  } catch (e) {
    if (my !== navTok) return; clearTimeout(spinTimer);
    const m = fail('channel', e);
    showEmpty('Could not load channel videos:\n' + m + (/not installed|not on PATH/i.test(m) ? '\n\nInstall yt-dlp (see the suggestion above or Settings) so channels also work when Piped is blocked.' : ''));
  }
}
// Popular/Oldest need the whole list, so load up to 6 pages first.
async function changeChSort(m) {
  chSort = m;
  if (m !== 'latest') { for (let i = 0; C.next && i < 6; i++) { setStatus(`Loading videos for sorting (${C.items.length})…`); await channelMore(true); } setStatus(''); }
  renderChannelVideos();
}
function renderChannelTab() {
  if (chTab === 'videos') return renderChannelVideos();
  showChannelPlaylists();
}
async function showChannelPlaylists(more = false) {
  $('#grid').classList.add('list');
  if (!C.pl) C.pl = { items: [], next: null, loaded: false };
  const my = more ? navTok : beginLoad();
  if (!C.pl.loaded || more) {
    try { const r = await api.chanPlaylists(C.id, C.playlistsTab, C.pl.next); if (my !== navTok) return; C.pl.items = C.pl.items.concat(r.items); C.pl.next = r.next; C.pl.loaded = true; }
    catch (e) { if (my === navTok) { clearTimeout(spinTimer); showEmpty('Could not load playlists:\n' + fail('chan-playlists', e)); } return; }
  }
  clearTimeout(spinTimer);
  $('#grid').replaceChildren(...C.pl.items.map(p => el('div', { className: 'plrow', onclick: () => openYtPlaylist(p) },
    p.thumbnail ? el('img', { src: p.thumbnail }) : el('div', { className: 'ph' }),
    el('div', { className: 'grow' }, el('b', {}, p.title || 'Playlist'), el('div', { className: 'muted' }, p.videos != null ? `${p.videos} videos` : '')),
    el('button', {}, 'Open'))));
  showEmpty('This channel has no playlists.', C.pl.items.length === 0); $('#more').hidden = !C.pl.next;
}
function restoreChannel() { mode = 'channel'; channelHead(); renderChannelTab(); }
async function openYtPlaylist(p) {
  mode = 'ytplaylist'; Y = { id: p.id, name: p.title, next: null, items: [] };
  setHead(p.title || 'Playlist', restoreChannel, el('button', { onclick: () => playList(Y.items, 0) }, '▶ Play all'),
    el('button', { onclick: () => playList(shuffled(Y.items), 0) }, 'Shuffle'), el('button', { onclick: saveYtPlaylist }, 'Save to my playlists'));
  beginLoad(); $('#more').hidden = true; await ytplMore();
}
async function ytplMore(quiet = false) {
  const my = navTok;
  try {
    const r = await api.ytplGet(Y.id, Y.next); if (my !== navTok) return;
    clearTimeout(spinTimer); Y.next = r.next; Y.items = Y.items.concat(r.items);
    if (!quiet) { renderGrid(Y.items); showEmpty('No videos.', Y.items.length === 0); $('#more').hidden = !Y.next; }
  } catch (e) { if (my === navTok) { clearTimeout(spinTimer); showEmpty('Could not load playlist:\n' + fail('ytplaylist', e)); } }
}
async function saveYtPlaylist() {
  setStatus('Loading all videos…'); for (let i = 0; Y.next && i < 10; i++) await ytplMore(true);
  const r = await api.plCreate(Y.name || 'Playlist'); P.playlists = await api.plAddMany(r.id, Y.items.map(videoRef));
  setStatus(`Saved ${Y.items.length} videos to “${Y.name}”`); renderGrid(Y.items); $('#more').hidden = true;
}
$('#more').onclick = async () => {
  if (mode === 'search') return searchMore();
  if (mode === 'ytplaylist') return ytplMore();
  if (mode === 'channel') return chTab === 'playlists' ? showChannelPlaylists(true) : (await channelMore(), undefined);
  limit += P.settings.feedSize; setStatus('Loading more…');
  let items = await api.getFeed(limit, catLabel);
  if (items.length < limit) { await api.refresh(); items = await api.getFeed(limit, catLabel); }
  renderGrid(items); setStatus('');
};
$('#sf').onsubmit = e => { e.preventDefault(); runSearch($('#q').value, $('#stype').value); };
$('#refresh').onclick = async () => { setStatus('Refreshing…'); await api.refresh(); if (mode === 'feed' && view === 'home') loadHome(); };

// ---------- subscriptions page ----------
async function renderSubs(fresh = false) {
  if (fresh) beginLoad($('#subgrid'));
  const my = navTok;
  const subs = orderedSubs(), s = P.settings;
  $('#subtitle').textContent = `Subscriptions (${subs.length})`;
  $('#subsort').value = subSort; $('#submanage').hidden = !subsManage;
  $('#subtoggle').textContent = s.showSubsList ? 'Hide channel list' : 'Show channel list';
  const strip = $('#substrip'); strip.hidden = !s.showSubsList || subs.length === 0;
  const n = +s.subsVisibleCount;
  strip.replaceChildren(...subs.slice(0, n).map(c => el('button', { className: 'chip' + (subFilter === c.id ? ' on' : ''), type: 'button', title: 'Filter videos to this channel',
    onclick: () => { subFilter = subFilter === c.id ? null : c.id; renderSubs(); } }, (c.pinned ? '★ ' : '') + c.name)),
    ...(subs.length > n ? [el('button', { className: 'chip ghost', type: 'button', onclick: () => { subsManage = true; renderSubs(); } }, `+${subs.length - n} more`)] : []));
  const q = $('#subsearch').value.trim().toLowerCase();
  $('#sublist').replaceChildren(...subs.filter(c => !q || c.name.toLowerCase().includes(q)).map(c => el('div', { className: 'subrow' },
    el('button', { className: c.pinned ? 'on' : '', title: c.pinned ? 'Unpin' : 'Pin (always shown first)', onclick: async () => { P.subscriptions = await api.subsPin(c.id, !c.pinned); renderSubs(); renderSideSubs(); } }, c.pinned ? '★' : '☆'),
    el('span', { className: 'nm', onclick: () => openChannel(c.id, c.name) }, c.name),
    el('button', { title: 'Unsubscribe', onclick: async () => { P.subscriptions = await api.subsRemove(c.id); if (subFilter === c.id) subFilter = null; renderSubs(); renderSideSubs(); } }, '✕'))));
  if (!subs.length) $('#sublist').textContent = 'No subscriptions yet. Search for channels (choose "Channels" next to the search box) or import your YouTube export.';
  let items = await api.subsFeed(300);
  if (my !== navTok) return;
  clearTimeout(spinTimer);
  if (subFilter) items = items.filter(v => v.channelId === subFilter);
  renderGrid(sortVideos(items.map(v => ({ ...v, published: v.published || v.fetchedAt })), subSort), $('#subgrid'));
}
$('#subsort').onchange = e => { subSort = e.target.value; renderSubs(); };
$('#submanagebtn').onclick = () => { subsManage = !subsManage; renderSubs(); };
$('#subtoggle').onclick = () => setSetting({ showSubsList: !P.settings.showSubsList });
$('#subsearch').oninput = () => renderSubs();
$('#subaddbtn').onclick = async () => {
  const v = $('#subadd').value.trim(); if (!v) return;
  const m = v.match(/UC[\w-]{20,}/);
  if (m) { P.subscriptions = await api.subsAdd({ id: m[0], name: m[0] }); $('#subadd').value = ''; setTimeout(async () => { await loadProfile(); renderSubs(); renderSideSubs(); }, 3000); renderSubs(); renderSideSubs(); }
  else { $('#stype').value = 'channels'; $('#q').value = v; runSearch(v, 'channels'); }
};
$('#subimport').onclick = () => importFiles();
$('#subrefresh').onclick = async () => { setStatus('Refreshing subscriptions…'); await api.subsRefresh(); await renderSubs(); setStatus(''); };

// ---------- playlists ----------
function playList(items, i) { if (items.length) openVideo(items[i], { items, i }); }
function renderPlaylists() {
  if (plOpen) return openPlaylist(plOpen);
  $('#pldetail').hidden = true; $('#plmain').hidden = false;
  $('#pllist').replaceChildren(
    el('button', { className: 'chip', onclick: () => openPlaylist('liked') }, `❤ Liked videos (${P.liked.length})`),
    ...P.playlists.map(pl => el('button', { className: 'chip', onclick: () => openPlaylist(pl.id) }, `${pl.name} (${pl.videos.length})`)));
}
$('#pladd').onclick = async () => {
  const n = $('#plnew').value.trim(); if (!n) return;
  const r = await api.plCreate(n); P.playlists = r.playlists; $('#plnew').value = ''; renderPlaylists();
};
function openPlaylist(id) {
  plOpen = id; const liked = id === 'liked';
  const pl = liked ? { id, name: 'Liked videos', videos: P.liked.map(r => videoRef({ ...r, id: r.videoId })) } : P.playlists.find(x => x.id === id);
  if (!pl) { plOpen = null; return renderPlaylists(); }
  $('#plmain').hidden = true; const root = $('#pldetail'); root.hidden = false;
  const reload = async () => { await loadProfile(); openPlaylist(id); };
  const title = el('h3', {}, pl.name);
  const rename = el('button', { onclick: () => {
    const inp = el('input', { value: pl.name }), ok = el('button', { onclick: async () => { P.playlists = await api.plRename(id, inp.value); openPlaylist(id); } }, 'Save');
    title.replaceChildren(inp, ok); inp.focus();
  } }, 'Rename');
  const del = el('button', { onclick: async () => { if (confirm(`Delete playlist "${pl.name}"?`)) { P.playlists = await api.plDelete(id); plOpen = null; renderPlaylists(); } } }, 'Delete');
  const missing = pl.videos.filter(v => !v.title).length;
  const fetchBtn = el('button', { onclick: async () => {
    const r = await api.resolveMeta(id); setStatus(`Fetched ${r.resolved} titles${r.remaining ? `, ${r.remaining} left (press again)` : ''}`); await reload();
  } }, `Fetch missing titles (${missing})`);
  const fixed = liked || id === 'watch-later';
  root.replaceChildren(
    el('div', { className: 'row' }, el('button', { onclick: () => { plOpen = null; renderPlaylists(); } }, '← Playlists'), title,
      el('span', { className: 'muted' }, `${pl.videos.length} videos`),
      el('button', { onclick: () => playList(pl.videos, 0) }, '▶ Play all'), el('button', { onclick: () => playList(shuffled(pl.videos), 0) }, 'Shuffle'),
      ...(missing ? [fetchBtn] : []), ...(fixed ? [] : [rename, del])),
    ...(pl.videos.length ? pl.videos.map((v, i) => {
      const btn = (t, tt, f) => el('button', { title: tt, textContent: t, onclick: async e => { e.stopPropagation(); await f(); } });
      const acts = liked ? [btn('✕', 'Remove like', async () => { await rate(v, 1); await reload(); })]
        : [btn('▲', 'Move up', async () => { P.playlists = await api.plMove(id, v.id, -1); openPlaylist(id); }),
           btn('▼', 'Move down', async () => { P.playlists = await api.plMove(id, v.id, 1); openPlaylist(id); }),
           btn('✕', 'Remove from playlist', async () => { P.playlists = await api.plRemove(id, v.id); openPlaylist(id); })];
      const row = el('div', { className: 'plrow' }, thumbEl(v),
        el('div', { className: 'grow' }, el('b', {}, v.title || `Video ${v.id}`), el('div', { className: 'muted' }, v.title ? `${v.channelName || ''} · ${dur(v.duration)}` : 'title not fetched yet')), ...acts);
      row.onclick = () => playList(pl.videos, i);
      return row;
    }) : [el('p', { className: 'muted' }, liked ? 'Videos you like appear here.' : 'Empty. Use ＋ on any video to add it.')]));
}

// ---------- algorithm (simple / advanced) ----------
function renderAlgo() {
  const dev = P.settings.devMode;
  $('#algonote').textContent = `Based on ${P.historyCount} watches and ${P.likes} likes (older signals fade). With little data the feed leans on your subscriptions and new uploads. ✕ next to something below makes the algorithm ignore it.`;
  $('#presets').replaceChildren(el('span', { className: 'muted' }, 'Presets:'), ...Object.values(PRESETS).map(p =>
    el('button', { onclick: async () => { await api.setSettings(p.s); await loadProfile(); limit = 0; renderAlgo(); } }, p.label)));
  renderFields($('#algo-fields'), dev ? ['Simple', 'Algorithm'] : ['Simple']);
  $('#advonly').hidden = !dev;
  const L = P.learned;
  const fill = (id, type, rows) => $(id).replaceChildren(...(rows.length ? rows.map(([label, v, key]) => el('li', {}, `${label} — ${Math.round(v * 100)}%`,
    el('button', { className: 'mini', title: 'Ignore: stop the algorithm from using this', onclick: () => ignoreItem(type, key, label) }, '✕'))) : [el('li', { className: 'muted' }, 'nothing yet')]));
  fill('#l-cats', 'category', L.categories); fill('#l-tags', 'tag', L.tags); fill('#l-chans', 'channel', L.channels);
  renderOverrides();
}
async function ignoreItem(type, key, label) {
  const o = P.overrides; if (type === 'channel') o.ignore.channel.push({ id: key, name: label }); else o.ignore[type].push(key);
  await saveOverrides(o); renderAlgo();
}
function renderOverrides() {
  const o = P.overrides, rm = f => async () => { f(); await saveOverrides(o); renderAlgo(); };
  const pins = [];
  for (const t of ['category', 'tag']) for (const [k, v] of Object.entries(o.boost[t])) pins.push(tag(`${t}: ${k} · ${Math.round(v * 100)}%`, rm(() => delete o.boost[t][k])));
  $('#pins').replaceChildren(...(pins.length ? pins : [el('span', { className: 'muted' }, 'No pinned interests')]));
  $('#mutedw').replaceChildren(...o.blockedWords.map(w => tag('word: ' + w, rm(() => { o.blockedWords = o.blockedWords.filter(x => x !== w); }))));
  $('#mutedc').replaceChildren(...o.blockedChannels.map(c => tag('channel: ' + c.name, rm(() => { o.blockedChannels = o.blockedChannels.filter(x => x.id !== c.id); }))));
  const ig = o.ignore, ign = [...ig.category.map(k => ['category', k, k]), ...ig.tag.map(k => ['tag', k, k]), ...ig.channel.map(c => ['channel', c.id, c.name])];
  $('#ignored').replaceChildren(...(ign.length ? ign.map(([t, k, label]) => tag(`${t}: ${label}`, rm(() => {
    if (t === 'channel') o.ignore.channel = o.ignore.channel.filter(c => c.id !== k); else o.ignore[t] = o.ignore[t].filter(x => x !== k);
  }))) : [el('span', { className: 'muted' }, 'Nothing ignored')]));
  $('#dislist').replaceChildren(...(P.disliked.length ? P.disliked.map(r => tag((r.title || r.videoId).slice(0, 48), async () => {
    await rate(videoRef({ ...r, id: r.videoId }), -1); await loadProfile(); renderOverrides();
  })) : [el('span', { className: 'muted' }, 'None')]));
}
async function saveOverrides(o) { await api.setOverrides(o); await loadProfile(); renderOverrides(); }
$('#pinadd').onclick = () => {
  const name = $('#pinname').value.trim(); if (!name) return;
  const t = $('#pintype').value, o = P.overrides; o.boost[t][t === 'tag' ? name.toLowerCase() : name] = $('#pinstr').value / 100;
  $('#pinname').value = ''; saveOverrides(o);
};
$('#muteadd').onclick = () => {
  const w = $('#mutename').value.trim().toLowerCase(); if (!w) return;
  const o = P.overrides; if (!o.blockedWords.includes(w)) o.blockedWords.push(w); $('#mutename').value = ''; saveOverrides(o);
};
$('#algoreset').onclick = async () => {
  await api.resetSettings([...new Set(FIELDS.filter(f => f.g === 'Algorithm' || f.g === 'Simple').map(f => f.k))]); await loadProfile(); renderAlgo();
};

// ---------- settings, import/export, instances, logs ----------
function renderSettings() {
  renderFields($('#set-fields'), ['Appearance', 'Subscriptions', 'Feed', 'Playback', 'Debug', 'Developer']);
  $('#datadir').textContent = `Profile, cache and app.log are stored in ${P.dataDir}. ${P.historyCount} videos in history.`;
}
async function importFiles() {
  const s = await api.dataImport(); if (!s) return;
  await loadProfile(); renderNav(); if (view === 'subs') renderSubs();
  const msg = `Imported: ${s.subs} subscriptions, ${s.playlists} playlists (${s.playlistVideos} videos), ${s.likes} liked videos, ${s.history} history events.`
    + (s.playlistVideos || s.likes ? '\nTitles are fetched on demand: open the playlist and press "Fetch missing titles".' : '')
    + (s.skipped.length ? '\nSkipped:\n  ' + s.skipped.join('\n  ') : '');
  setStatus(`Imported ${s.subs} subscriptions, ${s.playlists} playlists`);
  if (view === 'settings') { $('#dmsg').hidden = false; $('#dmsg').textContent = msg; } else alert(msg);
}
$('#dimport').onclick = importFiles;
$('#dexport').onclick = async () => {
  const r = await api.dataExport(); if (!r) return;
  $('#dmsg').hidden = false;
  $('#dmsg').textContent = `Exported ${r.files.length} files to ${r.dir}\n  ` + r.files.join('\n  ') + '\nFormats follow Google Takeout as closely as I know them. If another tool rejects a file, send me its first lines.';
};
$('#opendata').onclick = () => api.logOpen();
$('#export').onclick = () => api.exportProfile();
$('#import').onclick = async () => { try { if (await api.importProfile()) { await loadProfile(); renderNav(); renderChips(); renderSettings(); loadHome(); } } catch (e) { alert(clean(e)); } };
$('#editcats').onclick = () => openOnboard();
$('#resetlearned').onclick = async () => { if (confirm('Delete watch history and everything learned from it? (Likes/dislikes and playlists are kept.)')) { await api.resetLearned(); await loadProfile(); renderSettings(); } };
$('#ytest').onclick = async () => {
  $('#ytres').textContent = 'Testing…'; const r = await api.ytdlpTest();
  $('#ytres').textContent = r.ok ? `OK — yt-dlp ${r.version}` : `Not working: ${r.error}`;
};
function renderInstances(list) {
  $('#inst').replaceChildren(...list.sort((a, b) => (b.ok === true) - (a.ok === true) || (a.latency ?? 9e9) - (b.latency ?? 9e9)).map(i =>
    el('tr', { title: i.error || '' },
      el('td', {}, el('span', { className: 'dot ' + (i.ok ? 'ok' : i.ok === false ? 'bad' : '') })),
      el('td', {}, i.url), el('td', {}, i.latency ? i.latency + ' ms' : '–'), el('td', {}, String(i.fails)),
      el('td', {}, i.checkedAt ? new Date(i.checkedAt).toLocaleTimeString() : '–'))));
}
$('#check').onclick = async () => renderInstances(await api.checkInstances());
$('#fetchlist').onclick = async () => {
  const r = await api.refreshInstanceList(); renderInstances(r.list);
  $('#listmsg').textContent = r.error ? 'Error: ' + r.error : `${r.added} new instances found`;
};
async function renderLogs() {
  const lines = await api.logGet({ level: $('#loglevel').value, src: $('#logsrc').value, limit: 400 });
  const box = $('#logbox'); box.textContent = lines.map(l => l.line).join('\n') || '(empty)'; box.scrollTop = box.scrollHeight;
}
$('#loglevel').onchange = $('#logsrc').onchange = $('#logrefresh').onclick = renderLogs;
$('#logcopy').onclick = async () => { await api.diagCopy(); $('#logmsg').textContent = 'Diagnostics copied. Paste them into the chat.'; };
$('#logsave').onclick = () => api.logSave();
$('#logopen').onclick = () => api.logOpen();
$('#logclear').onclick = async () => { await api.logClear(); renderLogs(); };
$('#selftest').onclick = async () => {
  $('#logmsg').textContent = 'Running self-test (up to a minute)…'; $('#selftest').disabled = true;
  const rows = await api.selfTest();
  $('#testtable').hidden = false;
  $('#testrows').replaceChildren(...rows.map(r => el('tr', {}, el('td', {}, r.name), el('td', { className: r.status === 'ok' ? 'ok' : 'fail' }, r.status), el('td', {}, r.ms + ' ms'), el('td', { className: 'muted' }, r.detail))));
  $('#logmsg').textContent = `${rows.filter(r => r.status === 'ok').length}/${rows.length} passed. "Copy diagnostics" includes the log.`; $('#selftest').disabled = false; renderLogs();
};

// ---------- category picker ----------
function openOnboard() {
  const sel = new Set(P.seeds?.items || []);
  $('#chips').replaceChildren(...P.interestOptions.map(n => {
    const b = el('button', { className: 'chip' + (sel.has(n) ? ' on' : ''), type: 'button' }, n);
    b.onclick = () => b.classList.toggle('on'); return b;
  }));
  $('#custom').value = (P.seeds?.custom || []).join(', ');
  $('#onboard').showModal();
}
$('#onboard').addEventListener('cancel', e => e.preventDefault());
async function saveSeeds(items, custom) {
  await api.setSeeds({ items, custom }); await loadProfile(); $('#onboard').close();
  catLabel = null; limit = 0; renderChips(); if (mode === 'feed') loadHome(true);
}
$('#obdone').onclick = () => saveSeeds($$('#chips .chip.on').map(b => b.textContent), $('#custom').value.split(','));
$('#obskip').onclick = () => saveSeeds(P.seeds?.items || [], P.seeds?.custom || []);

// ---------- player: muxed stream, or video-only + separate audio kept in sync; auto quality; optional queue ----------
function buildTries(info) {
  const q = Number(P.settings.defaultQuality) || 720, a = info.audio?.[0]?.url || null, vo = a ? info.video : [], out = [];
  vo.filter(s => s.height <= q).forEach(s => out.push({ v: s.url, a, label: s.height + 'p' }));
  info.muxed.forEach(s => out.push({ v: s.url, a: null, label: s.height + 'p (simple)' }));
  vo.filter(s => s.height > q).reverse().forEach(s => out.push({ v: s.url, a, label: s.height + 'p' }));
  return out;
}
function unbindAudio() { unbindFns.forEach(f => f()); unbindFns = []; $('#audio').pause(); }
function bindAudio(v, a) {
  const on = (t, f) => { v.addEventListener(t, f); unbindFns.push(() => v.removeEventListener(t, f)); };
  on('play', () => a.play().catch(() => {})); on('pause', () => a.pause());
  on('seeked', () => { a.currentTime = v.currentTime; }); on('waiting', () => a.pause());
  on('playing', () => { a.currentTime = v.currentTime; a.play().catch(() => {}); });
  on('ratechange', () => { a.playbackRate = v.playbackRate; });
  on('volumechange', () => { a.volume = v.volume; a.muted = v.muted; });
  on('timeupdate', () => { if (Math.abs(a.currentTime - v.currentTime) > 0.35) a.currentTime = v.currentTime; });
}
function loadStream(i, resumeAt = 0) {
  tryIdx = i; const s = tries[i], v = $('#video'), a = $('#audio');
  unbindAudio(); v.src = s.v;
  if (s.a) { a.src = s.a; bindAudio(v, a); } else a.removeAttribute('src');
  if (!auto?.on) $('#quality').value = String(i);
  if (resumeAt) v.addEventListener('loadedmetadata', () => { v.currentTime = resumeAt; }, { once: true });
  if (P.settings.autoplay || resumeAt || current?.queue) v.play().catch(() => {});
}
// Auto quality: start at the smallest stream that fills the player; step down after repeated stalls,
// step up after a long stretch with a full buffer. Switching reloads the stream at the same position.
const capHeight = () => Math.ceil(($('#video').clientHeight || 480) * (window.devicePixelRatio || 1));
function autoTarget() {
  const max = +P.settings.autoMaxQuality || 1080, cap = capHeight(); let pos = -1;
  auto.ladder.forEach((x, k) => { if (x.h <= max && pos < 0 && x.h >= cap) pos = k; });
  if (pos < 0) auto.ladder.forEach((x, k) => { if (x.h <= max) pos = k; });
  return Math.max(pos, 0);
}
function autoMove(d) {
  const from = auto.ladder[auto.pos].h; auto.pos = Math.max(0, Math.min(auto.ladder.length - 1, auto.pos + d));
  auto.last = auto.okSince = Date.now(); auto.stalls = [];
  api.logUi('info', `auto quality ${from}p -> ${auto.ladder[auto.pos].h}p`);
  loadStream(auto.ladder[auto.pos].i, $('#video').currentTime); paintMeta();
}
function autoTick() {
  if (!auto?.on || !current?.info) return;
  const v = $('#video'), now = Date.now(); if (v.paused || v.seeking) return;
  auto.stalls = auto.stalls.filter(t => now - t < 30000);
  let ahead = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
  if (now - auto.last < 20000) return;
  if (auto.stalls.length >= 2 && auto.pos > 0) return autoMove(-1);
  if (ahead > 25 && !auto.stalls.length && now - auto.okSince > 30000 && auto.pos < autoTarget()) return autoMove(1);
  if (ahead <= 25) auto.okSince = now;
}
function paintMeta() {
  if (!current?.info) return;
  $('#pmeta').textContent = [current.info.category, auto?.on ? `Auto · ${auto.ladder[auto.pos].h}p` : ''].filter(Boolean).join(' · ');
}
$('#video').addEventListener('waiting', () => { const v = $('#video'); if (auto?.on && v.currentTime > 1 && !v.seeking) auto.stalls.push(Date.now()); });
$('#video').addEventListener('error', () => {
  if (!current?.info) return;
  if (auto?.on && auto.pos > 0) { autoMove(-1); return; }
  if (tryIdx + 1 < tries.length) { $('#pmeta').textContent = `Stream failed, trying ${tries[tryIdx + 1].label}…`; loadStream(tryIdx + 1); }
  else { $('#pmeta').textContent = 'None of the streams could be played. Try "Open on YouTube".'; api.logUi('warn', 'playback: all streams failed'); }
});
$('#video').addEventListener('ended', () => queueStep(1));
$('#quality').onchange = e => {
  const v = e.target.value, t = $('#video').currentTime;
  if (v === 'auto') { auto.on = true; auto.pos = autoTarget(); auto.last = auto.okSince = Date.now(); loadStream(auto.ladder[auto.pos].i, t); }
  else { if (auto) auto.on = false; loadStream(+v, t); }
  paintMeta();
};
function queueStep(d) {
  const q = current?.queue; if (!q) return;
  const i = q.i + d; if (i < 0 || i >= q.items.length) return;
  openVideo(q.items[i], { items: q.items, i });
}
function paintPlayerRating() {
  const r = current ? P.ratingMap[current.v.id] || 0 : 0;
  $('#plike').classList.toggle('on', r === 1); $('#pdis').classList.toggle('on', r === -1);
}
async function openVideo(v, queue = null) {
  await endPlayback();
  current = { v, info: null, external: false, queue }; auto = null;
  $('#ptitle').textContent = v.title; $('#pmeta').textContent = 'Loading…'; $('#phelp').hidden = true; $('#quality').replaceChildren();
  $('#video').removeAttribute('src'); $('#pch').textContent = v.channelName || '';
  $('#pch').onclick = () => { if (v.channelId) { $('#player').close(); openChannel(v.channelId, v.channelName); } };
  $('#psubwrap').replaceChildren(v.channelId ? subBtn({ id: v.channelId, name: v.channelName }) : el('span'));
  $('#pprev').hidden = $('#pnext').hidden = !queue;
  if (queue) { $('#pprev').disabled = queue.i === 0; $('#pnext').disabled = queue.i >= queue.items.length - 1; }
  paintPlayerRating();
  if (!$('#player').open) $('#player').showModal();
  try {
    const info = current.info = await api.openVideo(v.id);
    tries = buildTries(info);
    if (!tries.length) { $('#pmeta').textContent = 'No playable streams found. Try "Open on YouTube".'; return; }
    const ladder = tries.map((t, i) => ({ i, h: parseInt(t.label) })).filter(x => tries[x.i].a).sort((a, b) => a.h - b.h);
    const byRes = tries.map((t, i) => ({ t, i, h: parseInt(t.label) || 0 })).sort((a, b) => b.h - a.h);   // highest resolution first
    $('#quality').replaceChildren(...(ladder.length ? [el('option', { value: 'auto' }, 'Auto')] : []), ...byRes.map(x => el('option', { value: String(x.i) }, x.t.label)));
    if (String(P.settings.defaultQuality) === 'auto' && ladder.length) {
      auto = { on: true, ladder, pos: 0, last: Date.now(), okSince: Date.now(), stalls: [] }; auto.pos = autoTarget();
      $('#quality').value = 'auto'; loadStream(ladder[auto.pos].i);
      clearInterval(autoTimer); autoTimer = setInterval(autoTick, 2000);
    } else { if (ladder.length) auto = { on: false, ladder, pos: 0, stalls: [] }; loadStream(0); }
    paintMeta();
  } catch (e) {
    const m = fail('open video', e);
    $('#pmeta').textContent = 'Could not load this video.';
    $('#phelp').hidden = false;
    $('#phelp').textContent = m + '\n\n' + (/not installed|not on PATH|ENOENT/i.test(m) ? HELP : 'Try again, switch the stream source in Settings → Playback, or use "Open on YouTube". The Logs tab has details.');
  }
}
async function endPlayback() {
  clearInterval(autoTimer);
  const vid = $('#video'), c = current; current = null; auto = null;
  if (!c) return;
  let ratio = 0;
  if (c.external) ratio = 0.5; else if (vid.currentTime > 10 && vid.duration) ratio = vid.currentTime / vid.duration;
  unbindAudio(); $('#audio').removeAttribute('src'); vid.pause(); vid.removeAttribute('src'); vid.load();
  if (c.info && ratio > 0) await api.record({ videoId: c.v.id, channelId: c.info.channelId || c.v.channelId,
    channelName: c.info.channelName || c.v.channelName, category: c.info.category, tags: c.info.tags, watchRatio: ratio });
}
$('#player').addEventListener('close', endPlayback);
$('#close').onclick = () => $('#player').close();
$('#ext').onclick = () => { if (current) { current.external = true; api.openExternal('https://www.youtube.com/watch?v=' + current.v.id); $('#player').close(); } };
$('#plike').onclick = async () => { if (current) { await rate(videoRef(current.v), 1); paintPlayerRating(); } };
$('#pdis').onclick = async () => { if (!current) return; const n = await rate(videoRef(current.v), -1); paintPlayerRating(); if (n === -1) { if (current.queue) queueStep(1); else $('#player').close(); } };
$('#padd').onclick = () => { if (current) pickPlaylist(current.v); };
$('#pprev').onclick = () => queueStep(-1);
$('#pnext').onclick = () => queueStep(1);

// ---------- "loading is struggling": suggest yt-dlp ----------
let bannerDismissed = false, lastHint = 0;
async function maybeSuggest(force = false) {
  if (bannerDismissed || !P) return;
  const now = Date.now(); if (!force && now - lastHint < 60000) return; lastHint = now;
  const h = await api.healthHint(), weak = h.total > 0 && h.alive / h.total < 0.5, struggling = weak || h.blocked, box = $('#banner');
  const dismiss = el('button', { onclick: () => { bannerDismissed = true; box.hidden = true; } }, 'Not now');
  const why = `${h.alive} of ${h.total} Piped instances reachable${h.blocked ? ', YouTube is blocking streams' : ''}`;
  if (h.ytdlp === 'missing' && struggling) box.replaceChildren(el('span', {}, `Loading is struggling (${why}). yt-dlp makes it faster and more reliable.`),
    el('button', { onclick: installYt }, 'Install yt-dlp'), el('button', { onclick: () => box.replaceChildren(el('pre', {}, HELP), el('button', { onclick: () => { box.hidden = true; } }, 'OK')) }, 'Show manual steps'), dismiss);
  else if (h.ytdlp === 'disabled' && struggling) box.replaceChildren(el('span', {}, `Loading is struggling (${why}). yt-dlp is installed but turned off.`),
    el('button', { onclick: async () => { await setSetting({ ytdlpFallback: true }); box.hidden = true; } }, 'Turn on'), dismiss);
  else if (h.ytdlp === 'ok' && struggling && h.source === 'piped') box.replaceChildren(el('span', {}, `Piped is struggling (${why}). Let yt-dlp fetch streams first?`),
    el('button', { onclick: async () => { await setSetting({ playbackSource: 'ytdlp' }); box.hidden = true; } }, 'Use yt-dlp first'), dismiss);
  else { box.hidden = true; return; }
  box.hidden = false;
}
async function installYt() {
  if (!confirm('Download yt-dlp from github.com/yt-dlp/yt-dlp (official release), check its SHA-256 checksum and install it for MyTube only?')) return;
  setStatus('Installing yt-dlp…'); const r = await api.ytdlpInstall(); await loadProfile(); setStatus('');
  const box = $('#banner');
  box.replaceChildren(el('span', {}, r.ok ? `yt-dlp ${r.version} installed. Loading should be faster now.` : `Install failed: ${r.error}. You can use the manual steps instead.`), el('button', { onclick: () => { box.hidden = true; } }, 'OK'));
  box.hidden = false;
}

api.onInstances(renderInstances);
api.onStatus(s => setStatus(s.text));
api.onUpdated(() => {
  if (view === 'home' && mode === 'feed') { if (window.scrollY < 100) loadHome(); else setStatus('New videos available. Press Home to reload.'); }
  if (view === 'subs') renderSubs();
});
(async () => {
  await loadProfile(); renderNav(); renderChips(); await loadHome(true); api.instances().then(renderInstances); setTimeout(() => maybeSuggest(true), 12000);
  if (P.needsOnboarding) openOnboard();
})();
