const { INTERESTS, LEGACY } = require('./categories');
const F = require('./formats');

const DEFAULT_SETTINGS = {
  // algorithm
  historyRetentionDays: 30, interestHalfLifeDays: 21, minWatchRatio: 0.1,
  algoMode: 'simple', likeWeight: 3, dislikeWeight: 4,
  wChannel: 0.45, wTag: 0.35, wCategory: 0.2, channelRepeatPenalty: 0.25, categoryRepeatPenalty: 0.15, explorationRatio: 0.2,
  // feed
  shortsEnabled: false, feedSize: 60, subBoost: 0.3, subShare: 0.4, recencyWeight: 0.25, maxPerChannel: 2, regions: 'US', refreshMinutes: 15,
  // appearance
  theme: 'dark', accent: '#ff4d4d', cardSize: 260, showChannelNames: true,
  navLayout: 'top', sidebarSide: 'left', sidebarAuto: 'off', windowFrame: 'custom', devMode: false,
  sidebarCollapsed: false, showSubsList: true, subsVisibleCount: 8, subsExpanded: false,
  logLevel: 'info', logFullIds: false,
  // playback
  autoplay: true, defaultQuality: 'auto', autoMaxQuality: 1080, playbackSource: 'piped', ytdlpFallback: true, ytdlpPath: 'yt-dlp', ytdlpArgs: '--js-runtimes node',
};
const emptyOverrides = () => ({ boost: { category: {}, tag: {} }, ignore: { category: [], tag: [], channel: [] }, blockedChannels: [], blockedWords: [] });
// "US. NO, UK" -> ['US','NO','GB'] (YouTube uses GB, not UK). At most 4 regions.
const sanitizeRegions = s => [...new Set(String(s || '').toUpperCase().split(/[^A-Z]+/).filter(x => x.length === 2).map(x => (x === 'UK' ? 'GB' : x)))].slice(0, 4);
// Settings saved by older versions: bring forward without overriding anything the user deliberately changed.
function migrateSettings(p) {
  const ver = p?.version || 1, st = { ...DEFAULT_SETTINGS, ...(p?.settings || {}) };
  if (ver < 4) { if (Number(st.defaultQuality) === 720) st.defaultQuality = 'auto'; if (st.logLevel === 'debug') st.logLevel = 'info'; }
  const regs = sanitizeRegions(p?.settings?.regions ?? p?.settings?.region);
  st.regions = (regs.length ? regs : ['US']).join(',');
  delete st.region;
  return st;
}
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ref = v => ({ id: String(v.id), title: String(v.title || ''), channelId: v.channelId || null, channelName: v.channelName || '',
  thumbnail: v.thumbnail || '', duration: v.duration || 0, addedAt: v.addedAt || new Date().toISOString() });
const watchLater = () => ({ id: 'watch-later', name: 'Watch later', createdAt: new Date().toISOString(), videos: [] });
const DEFAULTS = () => ({ version: 4, history: [], seeds: null, subscriptions: [], ratings: [], playlists: [watchLater()],
  overrides: emptyOverrides(), settings: { ...DEFAULT_SETTINGS } });

function normalizePlaylists(list) {
  const out = (Array.isArray(list) ? list : []).filter(p => p && p.id && p.name).map(p => ({
    id: String(p.id), name: String(p.name).slice(0, 80), createdAt: p.createdAt || new Date().toISOString(),
    videos: (p.videos || []).filter(v => v && v.id).map(ref) }));
  if (!out.some(p => p.id === 'watch-later')) out.unshift(watchLater());
  return out;
}
function normalizeRatings(list) {
  return (Array.isArray(list) ? list : []).filter(r => r && r.videoId && (r.rating === 1 || r.rating === -1)).map(r => {
    const { id, ...rest } = ref({ ...r, id: r.videoId });
    return { videoId: r.videoId, rating: r.rating, at: r.at || new Date().toISOString(), ...rest, category: r.category || null, tags: (r.tags || []).slice(0, 15) };
  });
}
// Toggle: rating the same way twice removes the rating. Returns the new rating (1, -1 or 0).
function setRating(p, v, rating, meta = {}, now = Date.now()) {
  const i = p.ratings.findIndex(r => r.videoId === v.id);
  const prev = i >= 0 ? p.ratings[i].rating : 0;
  if (i >= 0) p.ratings.splice(i, 1);
  const next = prev === rating ? 0 : rating;
  if (next) { const { id, ...rest } = ref(v);
    p.ratings.push({ videoId: v.id, rating: next, at: new Date(now).toISOString(), ...rest, category: meta.category || null, tags: (meta.tags || []).slice(0, 15) }); }
  return next;
}
const findPl = (p, id) => p.playlists.find(x => x.id === id);
function createPlaylist(p, name) {
  const n = String(name || '').trim().slice(0, 80); if (!n) return null;
  const pl = { id: uid('pl_'), name: n, createdAt: new Date().toISOString(), videos: [] }; p.playlists.push(pl); return pl.id;
}
function renamePlaylist(p, id, name) { const x = findPl(p, id), n = String(name || '').trim().slice(0, 80); if (x && n && id !== 'watch-later') x.name = n; }
function deletePlaylist(p, id) { if (id !== 'watch-later') p.playlists = p.playlists.filter(x => x.id !== id); }
function addToPlaylist(p, id, v) { const x = findPl(p, id); if (x && v?.id && !x.videos.some(y => y.id === v.id)) x.videos.push(ref(v)); }
function removeFromPlaylist(p, id, vid) { const x = findPl(p, id); if (x) x.videos = x.videos.filter(y => y.id !== vid); }
function moveInPlaylist(p, id, vid, dir) {
  const x = findPl(p, id); if (!x) return;
  const i = x.videos.findIndex(y => y.id === vid), j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= x.videos.length) return;
  [x.videos[i], x.videos[j]] = [x.videos[j], x.videos[i]];
}

function normalizeOverrides(o) {
  const num = v => Math.max(0, Math.min(1, +v || 0));
  const boost = { category: {}, tag: {} };
  for (const t of ['category', 'tag'])
    for (const [k, v] of Object.entries(o?.boost?.[t] || {})) if (k) boost[t][t === 'tag' ? k.toLowerCase() : k] = num(v);
  const ignore = { category: [], tag: [], channel: [] };
  for (const t of ['category', 'tag']) ignore[t] = [...new Set((o?.ignore?.[t] || []).map(x => (t === 'tag' ? String(x).toLowerCase() : String(x))).filter(Boolean))];
  ignore.channel = (o?.ignore?.channel || []).filter(c => c && c.id).map(c => ({ id: String(c.id), name: String(c.name || c.id) }));
  return {
    boost, ignore,
    blockedChannels: (o?.blockedChannels || []).filter(c => c && c.id).map(c => ({ id: String(c.id), name: String(c.name || c.id) })),
    blockedWords: [...new Set((o?.blockedWords || []).map(w => String(w).trim().toLowerCase()).filter(Boolean))],
  };
}
function normalize(p) {
  const seeds = p?.seeds && Array.isArray(p.seeds.items) ? {
    at: p.seeds.at || new Date().toISOString(),
    items: [...new Set(p.seeds.items.map(n => LEGACY[n] || n).filter(n => INTERESTS[n]))],
    custom: Array.isArray(p.seeds.custom) ? p.seeds.custom : [],
  } : null;
  return {
    version: 4, history: Array.isArray(p?.history) ? p.history : [], seeds,
    ratings: normalizeRatings(p?.ratings), playlists: normalizePlaylists(p?.playlists),
    subscriptions: (p?.subscriptions || []).filter(c => c && c.id).map(c => ({ id: String(c.id), name: String(c.name || c.id), pinned: !!c.pinned })),
    overrides: normalizeOverrides(p?.overrides), settings: migrateSettings(p),
  };
}
function prune(p, now = Date.now()) {
  const cut = now - p.settings.historyRetentionDays * 864e5;
  p.history = p.history.filter(e => Date.parse(e.watchedAt) >= cut);
  return p;
}
function addWatch(p, e, now = Date.now()) {
  p.history.push({
    videoId: e.videoId, channelId: e.channelId, channelName: e.channelName, category: e.category,
    tags: (e.tags || []).slice(0, 15), watchRatio: +e.watchRatio || 0, watchedAt: new Date(now).toISOString(),
  });
  return prune(p, now);
}
const parseSubscriptionsCsv = F.parseSubscriptionsCsv;
function pinChannel(p, id, pinned) { const c = p.subscriptions.find(x => x.id === id); if (c) c.pinned = !!pinned; }
function addManyToPlaylist(p, id, vids) { for (const v of vids) addToPlaylist(p, id, v); }

// ---- imports (all return the number of new items) ----
function importSubs(p, list) {
  let n = 0;
  for (const c of list) if (!p.subscriptions.some(x => x.id === c.id)) { p.subscriptions.push({ id: c.id, name: c.name || c.id, pinned: false }); n++; }
  return n;
}
// rows: [{ id, addedAt }] (Takeout playlist files only carry IDs; titles are fetched on demand)
function importPlaylist(p, fixedId, name, rows) {
  let pl = fixedId ? findPl(p, fixedId) : p.playlists.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!pl) { pl = findPl(p, createPlaylist(p, name)); }
  let n = 0;
  for (const r of rows) if (!pl.videos.some(v => v.id === r.id)) { pl.videos.push(ref({ id: r.id, addedAt: r.addedAt || undefined })); n++; }
  return n;
}
function importLiked(p, rows, now = Date.now()) {
  let n = 0;
  for (const r of rows) if (!p.ratings.some(x => x.videoId === r.id)) {
    const { id, ...rest } = ref({ id: r.id });
    p.ratings.push({ videoId: r.id, rating: 1, at: r.addedAt ? new Date(r.addedAt).toISOString() : new Date(now).toISOString(), ...rest, category: null, tags: [] }); n++;
  }
  return n;
}
// Only events inside the retention window are kept (older ones would be pruned anyway).
function importHistory(p, events, now = Date.now()) {
  const cut = now - p.settings.historyRetentionDays * 864e5, have = new Set(p.history.map(e => e.videoId + '|' + e.watchedAt));
  let n = 0;
  for (const e of events) {
    if (Date.parse(e.watchedAt) < cut || have.has(e.videoId + '|' + e.watchedAt)) continue;
    have.add(e.videoId + '|' + e.watchedAt);
    p.history.push({ videoId: e.videoId, channelId: e.channelId, channelName: e.channelName, category: null, tags: [], watchRatio: 0.5, watchedAt: e.watchedAt }); n++;
  }
  return n;
}
module.exports = { sanitizeRegions, DEFAULTS, DEFAULT_SETTINGS, normalize, normalizeOverrides, prune, addWatch, parseSubscriptionsCsv,
  pinChannel, addManyToPlaylist, importSubs, importPlaylist, importLiked, importHistory,
  setRating, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, moveInPlaylist };
