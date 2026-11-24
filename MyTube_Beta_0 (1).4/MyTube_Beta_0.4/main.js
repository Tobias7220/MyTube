const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { InstancePool } = require('./core/instances');
const { Piped } = require('./core/piped');
const P = require('./core/profile');
const { interests, applyIgnore } = require('./core/scoring');
const { installYtdlp } = require('./core/install');
const { fetchRss } = require('./core/rss');
const { buildFeed } = require('./core/recommend');
const { INTERESTS } = require('./core/categories');
const { ytdlpStream, ytdlpList, ytdlpChannel, ytdlpVersion, setLogger: setYtLogger } = require('./core/ytdlp');
const { Logger } = require('./core/logger');
const F = require('./core/formats');

// Apps launched from a desktop menu often lack ~/.local/bin on PATH, which is where yt-dlp usually lives.
process.env.PATH = [process.env.PATH, path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin'].filter(Boolean).join(path.delimiter);

const VERSION = 'Beta 0.4';
const userDir = app.getPath('userData');   // Linux: ~/.config/mytube/
fs.mkdirSync(userDir, { recursive: true });
const log = new Logger(path.join(userDir, 'app.log'));
setYtLogger((l, s, m) => log.log(l, s, m));
process.on('uncaughtException', e => log.log('error', 'main', 'uncaught: ' + String(e.stack || e.message).split('\n').slice(0, 4).join(' | ')));
process.on('unhandledRejection', e => log.log('error', 'main', 'unhandled rejection: ' + String((e && e.message) || e).slice(0, 300)));

let win, pool, piped, profile, cache, refreshing = false, rerun = false, lastRefresh = 0;
const file = f => path.join(app.getPath('userData'), f);   // Linux: ~/.config/mytube/
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(file(f), 'utf8')); } catch { return d; } };
const send = (ch, p) => win && !win.isDestroyed() && win.webContents.send(ch, p);
const saveProfile = () => fs.writeFileSync(file('profile.json'), JSON.stringify(profile));
const saveCache = () => { cache.instances = pool.snapshot(); fs.writeFileSync(file('cache.json'), JSON.stringify(cache)); };
const feed = (limit, category) => buildFeed(Object.values(cache.candidates), cache.meta, profile, { size: limit, category, chanCat: cache.chanCat });
const ints = () => applyIgnore(interests(profile.history, { halfLifeDays: profile.settings.interestHalfLifeDays, seeds: profile.seeds, minWatch: profile.settings.minWatchRatio,
  ratings: profile.ratings, likeWeight: profile.settings.likeWeight, dislikeWeight: profile.settings.dislikeWeight }), profile.overrides);
const top = (o, n) => Object.entries(o).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);

function addCandidates(list, extra = {}) {
  const now = Date.now(); let added = 0;
  for (const v of list) {
    if (!cache.candidates[v.id]) { added++; v.fetchedAt = now; }
    cache.candidates[v.id] = { ...cache.candidates[v.id], ...v, ...extra };
  }
  return added;
}
function pruneCandidates() {
  const keep = Object.values(cache.candidates).sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, 2000);
  cache.candidates = Object.fromEntries(keep.map(v => [v.id, v]));
}

// Category/tags need a stream lookup; skip entirely while Piped is blocked so we don't hammer instances.
async function enrich() {
  if (piped.streamsBlocked()) return;
  const need = feed(40).filter(v => !cache.meta[v.id]).slice(0, 8);
  for (let i = 0; i < need.length; i += 4)
    await Promise.allSettled(need.slice(i, i + 4).map(async v => {
      const s = await piped.stream(v.id, { fallback: false, max: 3 });
      cache.meta[v.id] = { category: s.category, tags: s.tags }; if (s.channelId && s.category) cache.chanCat[s.channelId] = s.category;
    }));
}

// Category picks also drive searches, but only for 3 half-lives so old picks don't stick around.
function seedJobs() {
  const sd = profile.seeds; if (!sd) return [];
  if (Date.now() - Date.parse(sd.at) > 3 * profile.settings.interestHalfLifeDays * 864e5) return [];
  const pick = [...(sd.items || []).map(n => ({ q: INTERESTS[n]?.query, cat: INTERESTS[n]?.category })),
    ...(sd.custom || []).map(q => ({ q, cat: null }))].filter(x => x.q).sort(() => Math.random() - 0.5).slice(0, 6);
  return pick.map(x => piped.searchPage(x.q).then(r => ({ list: r.items, cat: x.cat })));
}
async function runPool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
// 1000+ subscriptions: Piped's multi-channel feed in batches of 40 (a few requests instead of 1000), then YouTube RSS
// (only if direct fallbacks are allowed) for whatever Piped could not deliver. Channels with no uploads are skipped for a day.
async function refreshSubs({ force = false } = {}) {
  const now = Date.now(), t0 = now;
  const due = profile.subscriptions.filter(c => force || now - (cache.chanAt[c.id] || 0) > 3600e3)
    .filter(c => !(cache.noVideos[c.id] && now - cache.noVideos[c.id] < 864e5))
    .sort((a, b) => (cache.chanAt[a.id] || 0) - (cache.chanAt[b.id] || 0)).slice(0, force ? 1500 : 200);
  if (!due.length) return 0;
  let added = 0, viaFeed = 0, viaRss = 0, empty = 0;
  const pending = new Set(due.map(c => c.id)), batches = [];
  for (let i = 0; i < due.length; i += 40) batches.push(due.slice(i, i + 40).map(c => c.id));
  await runPool(batches, 3, async ids => {
    try { const list = await piped.feed(ids); added += addCandidates(list); viaFeed += list.length; ids.forEach(id => { pending.delete(id); cache.chanAt[id] = Date.now(); }); }
    catch (e) { log.log('warn', 'subs', 'piped feed batch failed: ' + e.message.split('\n')[0].slice(0, 160)); }
  });
  if (pending.size && profile.settings.ytdlpFallback) {
    await runPool([...pending], 6, async id => {
      try { const list = await fetchRss(id); added += addCandidates(list); viaRss += list.length; pending.delete(id); cache.chanAt[id] = Date.now(); if (!list.length) { cache.noVideos[id] = Date.now(); empty++; } }
      catch (e) { if (/HTTP 404/.test(e.message)) { cache.noVideos[id] = Date.now(); pending.delete(id); empty++; } }
    });
  }
  log.log('info', 'subs', `refresh: ${due.length} channels due, ${viaFeed} videos via Piped feed, ${viaRss} via RSS, ${empty} without uploads, ${pending.size} left for next time, ${added} new, ${Date.now() - t0}ms`);
  return added;
}

async function refreshCandidates() {
  if (refreshing) { rerun = true; return 0; }
  refreshing = true; send('status', { text: 'Fetching new videos…' });
  let added = 0; const t0 = Date.now();
  try {
    const i = ints();
    const jobs = [...P.sanitizeRegions(profile.settings.regions).map(r => piped.trending(r).then(list => ({ list }))),
      ...top(i.channel, 5).map(([c]) => piped.channel(c).then(list => ({ list }))),
      ...top(i.tag, 5).map(([t]) => piped.searchPage(t).then(r => ({ list: r.items }))),
      ...seedJobs()];
    for (const r of await Promise.allSettled(jobs))
      if (r.status === 'fulfilled') added += addCandidates(r.value.list, r.value.cat ? { hintCategory: r.value.cat } : {});
    added += await refreshSubs();
    pruneCandidates(); await enrich();
    lastRefresh = Date.now(); saveCache(); send('feed-updated');
    log.log('info', 'perf', `refresh: ${added} new videos, ${Object.keys(cache.candidates).length} candidates, ${Date.now() - t0}ms`);
  } catch (e) { log.log('error', 'main', 'refresh failed: ' + e.message); send('status', { text: 'Error: ' + e.message }); }
  finally {
    refreshing = false; if (rerun) { rerun = false; setImmediate(refreshCandidates); }
    send('status', { text: added ? `${added} new videos` : '' });
  }
  return added;
}

// Fetch videos for one chosen category (2 search pages), cached for 10 minutes.
async function fetchCategory(label) {
  const it = INTERESTS[label];
  if (!it || Date.now() - (cache.catAt[label] || 0) < 600e3) return;
  cache.catAt[label] = Date.now();
  try {
    const a = await piped.searchPage(it.query); let items = a.items;
    if (a.next) { try { items = items.concat((await piped.searchPage(it.query, { token: a.next })).items); } catch {} }
    addCandidates(items, { hintCategory: it.category }); pruneCandidates(); saveCache();
  } catch (e) { cache.catAt[label] = 0; throw e; }
}

function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 820, minWidth: 640, minHeight: 480, title: 'MyTube ' + VERSION, backgroundColor: '#111',
    frame: profile.settings.windowFrame === 'system',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  win.setMenuBarVisibility(false);
  win.loadFile('renderer/index.html');
}

app.whenReady().then(async () => {
  profile = P.prune(P.normalize(readJson('profile.json', null)));
  cache = { candidates: {}, meta: {}, instances: [], chanAt: {}, catAt: {}, noVideos: {}, chanCat: {}, ...readJson('cache.json', {}) };
  pool = new InstancePool({ instances: cache.instances, onChange: () => send('instances', pool.snapshot()) });
  pool.log = (l, s, m, d) => log.log(l, s, m, d);
  piped = new Piped(pool);
  piped.log = pool.log;
  piped.fallbackList = (kind, id, start) => ytdlpList(kind, id, { bin: profile.settings.ytdlpPath || 'yt-dlp', start });
  log.setConfig({ level: profile.settings.logLevel, fullIds: profile.settings.logFullIds });
  piped.fallback = id => ytdlpStream(id, { bin: profile.settings.ytdlpPath || 'yt-dlp', extra: profile.settings.ytdlpArgs });
  piped.fallbackChannel = (id, start) => ytdlpChannel(id, { bin: profile.settings.ytdlpPath || 'yt-dlp', start });
  piped.fallbackEnabled = () => profile.settings.ytdlpFallback;
  createWindow();
  log.log('info', 'main', `MyTube ${VERSION} started: electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}, ${process.platform} ${os.release()}`);
  ytdlpVersion(profile.settings.ytdlpPath || 'yt-dlp').then(v => log.log('info', 'main', 'yt-dlp ' + v)).catch(e => log.log('warn', 'main', 'yt-dlp: ' + e.message));
  win.webContents.on('render-process-gone', (_, d) => log.log('error', 'main', 'renderer process gone: ' + d.reason));
  win.webContents.on('did-fail-load', (_, code, desc) => log.log('error', 'main', `page failed to load: ${code} ${desc}`));

  const H = (c, f) => ipcMain.handle(c, (_, ...a) => f(...a));
  H('feed:get', async (limit, label) => {
    if (label) await fetchCategory(label).catch(() => {});
    const t = Date.now(), r = feed(limit, label ? INTERESTS[label]?.category : null);
    log.log('debug', 'perf', `feed built: ${r.length} items in ${Date.now() - t}ms`);
    return r;
  });
  H('feed:refresh', async () => { await refreshCandidates(); return true; });

  H('instances:get', () => pool.snapshot());
  H('instances:check', async () => { await pool.checkAll({ force: true }); saveCache(); return pool.snapshot(); });
  H('instances:list', async () => {
    try { const added = await pool.refreshList(); await pool.checkAll(); saveCache(); return { added, list: pool.snapshot() }; }
    catch (e) { return { error: e.message, list: pool.snapshot() }; }
  });

  H('video:open', async id => {
    const s = await piped.stream(id, { preferFallback: profile.settings.playbackSource === 'ytdlp' });
    cache.meta[id] = { category: s.category, tags: s.tags }; if (s.channelId && s.category) cache.chanCat[s.channelId] = s.category;
    return s;
  });
  H('watch:record', e => { P.addWatch(profile, e); if (e.channelId && e.category) cache.chanCat[e.channelId] = e.category; saveProfile(); return true; });

  H('search:run', async (q, type, token) => {
    q = String(q || '').trim().slice(0, 100);
    if (!q) return { items: [], next: null };
    const r = await piped.searchPage(q, { type: type === 'channels' ? 'channels' : 'videos', token: token || null });
    if (type !== 'channels') {
      const muted = new Set(profile.overrides.blockedChannels.map(c => c.id));
      r.items = r.items.filter(v => (profile.settings.shortsEnabled || !v.isShort) && !muted.has(v.channelId));
    }
    return r;
  });
  H('channel:get', (id, token) => piped.channelPage(id, token || null));

  H('subs:add', c => {
    if (c?.id && !profile.subscriptions.some(x => x.id === c.id)) {
      profile.subscriptions.push({ id: c.id, name: c.name || c.id }); saveProfile(); refreshCandidates();
      if (!c.name || c.name === c.id) piped.channelPage(c.id).then(r => {
        const x = profile.subscriptions.find(s => s.id === c.id); if (x && r.name) { x.name = r.name; saveProfile(); }
      }).catch(() => {});
    }
    return profile.subscriptions;
  });
  H('subs:remove', id => { profile.subscriptions = profile.subscriptions.filter(c => c.id !== id); saveProfile(); return profile.subscriptions; });
  H('subs:import', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    let n = 0;
    for (const c of P.parseSubscriptionsCsv(fs.readFileSync(r.filePaths[0], 'utf8')))
      if (!profile.subscriptions.some(x => x.id === c.id)) { profile.subscriptions.push(c); n++; }
    saveProfile(); refreshCandidates();
    return { added: n, total: profile.subscriptions.length };
  });
  H('subs:feed', (limit = 100) => {
    const ids = new Set(profile.subscriptions.map(c => c.id));
    return Object.values(cache.candidates).filter(v => ids.has(v.channelId)).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, limit);
  });
  H('subs:refresh', async () => { const n = await refreshSubs({ force: true }); saveCache(); send('feed-updated'); return n; });

  // ---------- window, yt-dlp install, health hint ----------
  H('win:ctl', a => { if (!win) return; if (a === 'min') win.minimize(); else if (a === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize()); else if (a === 'close') win.close(); });
  H('ytdlp:install', async () => {
    try {
      const out = await installYtdlp({ dir: path.join(userDir, 'bin'), onProgress: t => send('status', { text: t }) });
      profile.settings.ytdlpPath = out; profile.settings.ytdlpFallback = true; saveProfile();
      const version = await ytdlpVersion(out); log.log('info', 'main', `yt-dlp installed: ${version}`); send('status', { text: '' });
      return { ok: true, path: out, version };
    } catch (e) { log.log('warn', 'main', 'yt-dlp install failed: ' + e.message); send('status', { text: '' }); return { ok: false, error: e.message }; }
  });
  H('health:hint', async () => {
    const list = pool.snapshot(); let y = 'missing';
    try { await ytdlpVersion(profile.settings.ytdlpPath || 'yt-dlp'); y = profile.settings.ytdlpFallback ? 'ok' : 'disabled'; } catch {}
    return { alive: list.filter(i => i.ok).length, total: list.length, blocked: piped.streamsBlocked(), ytdlp: y, source: profile.settings.playbackSource };
  });

  // ---------- debugging: log, diagnostics, self-test ----------
  const hostOf = u => { try { return new URL(u).host; } catch { return u; } };
  function diagText() {
    const ids = Object.keys(cache.candidates), withMeta = ids.filter(id => cache.meta[id]).length, mu = process.memoryUsage();
    const L = [`MyTube ${VERSION} diagnostics ${new Date().toISOString()}`,
      `electron ${process.versions.electron} / chrome ${process.versions.chrome} / node ${process.versions.node} / ${process.platform} ${os.release()} ${os.arch()}`,
      `memory: rss ${(mu.rss / 1048576).toFixed(0)} MB, heap ${(mu.heapUsed / 1048576).toFixed(0)} MB`,
      `data: history ${profile.history.length}, subscriptions ${profile.subscriptions.length}, playlists ${profile.playlists.length}, ratings ${profile.ratings.length}, candidates ${ids.length} (${withMeta} with category/tags)`,
      `piped streams currently treated as blocked: ${piped.streamsBlocked()}`,
      'settings: ' + JSON.stringify(profile.settings), '', 'instances:'];
    for (const i of pool.snapshot()) L.push(`  ${hostOf(i.url)} ok=${i.ok} latency=${i.latency} fails=${i.fails} streamFails=${i.streamFails || 0} ${i.error ? 'err=' + i.error : ''}`);
    L.push('', 'recent log (last 80 lines):', log.text({ limit: 80 }));
    return L.join('\n');
  }
  async function selfTest() {
    const rows = [];
    const time = async (name, fn) => {
      const t = Date.now();
      try { rows.push({ name, status: 'ok', ms: Date.now() - t, detail: String((await fn()) || '') }); }
      catch (e) { rows.push({ name, status: 'FAIL', ms: Date.now() - t, detail: e.message.split('\n')[0].slice(0, 180) }); }
    };
    const bin = profile.settings.ytdlpPath || 'yt-dlp', extra = profile.settings.ytdlpArgs;
    for (const inst of pool.ranked().slice(0, 3)) {
      const h = hostOf(inst.url);
      await Promise.all([
        time(`${h}  trending`, () => pool._get(inst, '/trending?region=US', 10000).then(d => `${d.length} items`)),
        time(`${h}  search`, () => pool._get(inst, '/search?q=test&filter=videos', 10000).then(d => `${(d.items || []).length} items`)),
        time(`${h}  channel`, () => pool._get(inst, '/channel/UCBR8-60-B28hp2BmDPdntcQ', 12000).then(d => `${(d.relatedStreams || []).length} videos; tabs: ${(d.tabs || []).map(t => t.name).join(', ') || 'none'}`)),
        time(`${h}  feed (many channels)`, () => pool._get(inst, '/feed/unauthenticated?channels=UCBR8-60-B28hp2BmDPdntcQ', 12000).then(d => `${(Array.isArray(d) ? d : d.relatedStreams || []).length} videos`)),
        time(`${h}  streams`, () => pool._get(inst, '/streams/dQw4w9WgXcQ', 12000).then(d => `${(d.videoStreams || []).length} video / ${(d.audioStreams || []).length} audio`)),
      ]);
    }
    await time('YouTube RSS (direct)', async () => `${(await fetchRss('UCBR8-60-B28hp2BmDPdntcQ')).length} videos`);
    await time('node (yt-dlp JS runtime)', () => new Promise((res, rej) => execFile('node', ['--version'], (e, so) => e ? rej(new Error('node not found on PATH')) : res(so.trim()))));
    await time('yt-dlp version', () => ytdlpVersion(bin));
    await time('yt-dlp stream', async () => { const s = await ytdlpStream('dQw4w9WgXcQ', { bin, extra }); return `${s.video.length} video / ${s.audio.length} audio, category ${s.category}`; });
    await time('yt-dlp channel list', async () => `${(await ytdlpList('channel', 'UCBR8-60-B28hp2BmDPdntcQ', { bin, count: 5 })).items.length} videos`);
    log.log('info', 'main', 'self-test: ' + rows.map(r => `${r.name}=${r.status}`).join(', '));
    return rows;
  }
  H('log:get', o => log.entries(o).map(e => ({ level: e.level, src: e.src, line: log.format(e) })));
  H('log:clear', () => { log.clear(); return true; });
  H('log:ui', (level, msg) => log.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', 'ui', String(msg).slice(0, 500)));
  H('log:open', () => shell.showItemInFolder(path.join(userDir, 'app.log')));
  H('log:save', async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'mytube-log.txt' });
    if (!r.canceled) fs.writeFileSync(r.filePath, diagText() + '\n\nfull log buffer:\n' + log.text({ limit: 1500 }));
    return !r.canceled;
  });
  H('diag:copy', () => { clipboard.writeText(diagText()); return true; });
  H('diag:selftest', selfTest);

  // ---------- import / export (YouTube Takeout and compatible formats) ----------
  function importFile(f, s) {
    const text = fs.readFileSync(f, 'utf8'), name = path.basename(f);
    if (/\.csv$/i.test(name)) {
      const rows = F.parseCsv(text), kind = F.detectCsv(rows);
      if (kind === 'subscriptions') s.subs += P.importSubs(profile, F.parseSubscriptionsCsv(text));
      else if (kind === 'playlist-videos') {
        const pname = name.replace(/-videos\.csv$/i, '').replace(/\.csv$/i, ''), vids = F.parsePlaylistVideosCsv(text);
        if (/^liked videos$/i.test(pname)) s.likes += P.importLiked(profile, vids);
        else { s.playlistVideos += P.importPlaylist(profile, /^watch later$/i.test(pname) ? 'watch-later' : null, pname, vids); s.playlists++; }
      } else if (kind === 'playlists-meta') s.skipped.push(`${name}: playlist list file (not needed)`);
      else throw new Error('unrecognised CSV header');
    } else {
      const j = JSON.parse(text);
      if (Array.isArray(j) && j.some(e => e && e.titleUrl)) s.history += P.importHistory(profile, F.parseWatchHistoryJson(text));
      else if (j && Array.isArray(j.subscriptions)) s.subs += P.importSubs(profile, F.parseSubsJson(text));
      else if (j && Array.isArray(j.history)) throw new Error('this is a MyTube backup: use "Import backup"');
      else throw new Error('unrecognised JSON');
    }
  }
  H('data:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'YouTube / Takeout / NewPipe files', extensions: ['csv', 'json'] }] });
    if (r.canceled) return null;
    const s = { subs: 0, playlists: 0, playlistVideos: 0, likes: 0, history: 0, skipped: [] };
    for (const f of r.filePaths) { try { importFile(f, s); } catch (e) { s.skipped.push(`${path.basename(f)}: ${e.message}`); } }
    saveProfile(); refreshCandidates();
    log.log('info', 'main', `import: ${JSON.stringify({ ...s, skipped: s.skipped.length })}`);
    return s;
  });
  H('data:export', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose where to save the export' });
    if (r.canceled) return null;
    const dir = path.join(r.filePaths[0], 'MyTube-export-' + new Date().toISOString().slice(0, 10)), pdir = path.join(dir, 'playlists'), files = [];
    fs.mkdirSync(pdir, { recursive: true });
    const w = (p, t) => { fs.writeFileSync(p, t); files.push(path.relative(dir, p)); };
    const safe = n => n.replace(/[\\/:*?"<>|]/g, '_');
    w(path.join(dir, 'subscriptions.csv'), F.exportSubscriptionsCsv(profile.subscriptions));
    for (const pl of profile.playlists) w(path.join(pdir, safe(pl.name) + '-videos.csv'), F.exportPlaylistVideosCsv(pl.videos.map(v => ({ id: v.id, addedAt: v.addedAt }))));
    w(path.join(pdir, 'Liked videos-videos.csv'), F.exportPlaylistVideosCsv(profile.ratings.filter(x => x.rating > 0).map(x => ({ id: x.videoId, addedAt: x.at }))));
    w(path.join(dir, 'watch-history.json'), F.exportWatchHistoryJson(profile.history));
    log.log('info', 'main', `export: ${files.length} files`);
    return { dir, files };
  });
  // Takeout playlist/like files only contain IDs; fetch titles for up to 40 missing ones per call.
  function applyMeta(id, s) {
    const fill = v => { v.title = v.title || s.title || ''; v.channelId = v.channelId || s.channelId; v.channelName = v.channelName || s.channelName; v.thumbnail = v.thumbnail || s.thumbnail || ''; v.duration = v.duration || s.duration || 0; };
    for (const pl of profile.playlists) for (const v of pl.videos) if (v.id === id) fill(v);
    for (const r of profile.ratings) if (r.videoId === id) { fill(r); r.category = r.category || s.category; r.tags = r.tags?.length ? r.tags : s.tags; }
    cache.meta[id] = { category: s.category, tags: s.tags }; if (s.channelId && s.category) cache.chanCat[s.channelId] = s.category;
  }
  H('meta:resolve', async listId => {
    const ids = listId === 'liked' ? profile.ratings.filter(r => r.rating > 0 && !r.title).map(r => r.videoId)
      : (profile.playlists.find(p => p.id === listId)?.videos || []).filter(v => !v.title).map(v => v.id);
    const batch = ids.slice(0, 40); let done = 0;
    for (let i = 0; i < batch.length; i += 3) {
      await Promise.allSettled(batch.slice(i, i + 3).map(async id => {
        try { applyMeta(id, await piped.stream(id, { max: 3 })); done++; }
        catch (e) { log.log('warn', 'meta', 'resolve failed: ' + e.message.split('\n')[0]); }
      }));
      send('status', { text: `Fetching titles ${Math.min(i + 3, batch.length)}/${batch.length}…` });
    }
    saveProfile(); saveCache(); send('status', { text: '' });
    return { resolved: done, remaining: ids.length - done };
  });
  H('chan:playlists', (id, tabData, token) => piped.channelPlaylists(id, tabData || null, token || null));
  H('ytpl:get', (id, token) => piped.playlistPage(id, token || null));
  H('subs:pin', (id, pinned) => { P.pinChannel(profile, id, pinned); saveProfile(); return profile.subscriptions; });
  H('pl:addmany', (id, vids) => { P.addManyToPlaylist(profile, id, vids); saveProfile(); return profile.playlists; });

  // ratings + playlists
  const plSave = () => { saveProfile(); return profile.playlists; };
  H('rate:set', (v, rating) => {
    const m = cache.meta[v.id] || {};
    const next = P.setRating(profile, v, rating === -1 ? -1 : 1, m);
    saveProfile(); return next;
  });
  H('pl:create', name => { const id = P.createPlaylist(profile, name); plSave(); return { id, playlists: profile.playlists }; });
  H('pl:rename', (id, name) => { P.renamePlaylist(profile, id, name); return plSave(); });
  H('pl:delete', id => { P.deletePlaylist(profile, id); return plSave(); });
  H('pl:add', (id, v) => { P.addToPlaylist(profile, id, v); return plSave(); });
  H('pl:remove', (id, vid) => { P.removeFromPlaylist(profile, id, vid); return plSave(); });
  H('pl:move', (id, vid, dir) => { P.moveInPlaylist(profile, id, vid, dir); return plSave(); });

  H('profile:get', () => {
    const i = ints();
    const names = Object.fromEntries([...profile.subscriptions.map(c => [c.id, c.name]), ...profile.history.map(e => [e.channelId, e.channelName])]);
    return { settings: profile.settings, seeds: profile.seeds, needsOnboarding: profile.seeds == null,
      interestOptions: Object.keys(INTERESTS), overrides: profile.overrides, subscriptions: profile.subscriptions,
      playlists: profile.playlists, ratingMap: Object.fromEntries(profile.ratings.map(r => [r.videoId, r.rating])),
      liked: profile.ratings.filter(r => r.rating > 0).reverse(), disliked: profile.ratings.filter(r => r.rating < 0).reverse(),
      historyCount: profile.history.length, dataDir: app.getPath('userData'),
      likes: profile.ratings.filter(r => r.rating > 0).length,
      learned: { categories: top(i.category, 10).map(([k, v]) => [k, v, k]), tags: top(i.tag, 15).map(([k, v]) => [k, v, k]), channels: top(i.channel, 10).map(([k, v]) => [names[k] || k, v, k]) } };
  });
  H('settings:set', patch => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in P.DEFAULT_SETTINGS)) continue;
      const def = P.DEFAULT_SETTINGS[k], t = typeof def;
      if (k === 'regions') { profile.settings[k] = P.sanitizeRegions(v).join(',') || 'US'; continue; }
      profile.settings[k] = t === 'number' ? (Number.isFinite(+v) ? +v : def) : t === 'boolean' ? !!v : String(v);
    }
    log.setConfig({ level: profile.settings.logLevel, fullIds: profile.settings.logFullIds });
    P.prune(profile); saveProfile(); return profile.settings;
  });
  H('settings:reset', keys => { for (const k of keys) if (k in P.DEFAULT_SETTINGS) profile.settings[k] = P.DEFAULT_SETTINGS[k]; saveProfile(); return profile.settings; });
  H('overrides:set', o => { profile.overrides = P.normalizeOverrides(o); saveProfile(); return profile.overrides; });
  H('channel:mute', c => {
    if (c?.id && !profile.overrides.blockedChannels.some(x => x.id === c.id)) profile.overrides.blockedChannels.push({ id: c.id, name: c.name || c.id });
    saveProfile(); return true;
  });
  H('seeds:set', s => {
    profile.seeds = { at: new Date().toISOString(), items: (s.items || []).filter(n => INTERESTS[n]),
      custom: (s.custom || []).map(x => String(x).trim()).filter(Boolean).slice(0, 10) };
    saveProfile(); refreshCandidates(); return true;
  });
  H('profile:reset-learned', () => { profile.history = []; saveProfile(); return true; });
  H('profile:export', async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'mytube-profile.json' });
    if (!r.canceled) fs.writeFileSync(r.filePath, JSON.stringify(profile, null, 2));
    return !r.canceled;
  });
  H('profile:import', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return false;
    const p = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!Array.isArray(p.history)) throw new Error('Invalid profile file');
    profile = P.prune(P.normalize(p)); saveProfile(); return true;
  });
  H('data:open', () => shell.openPath(app.getPath('userData')));
  H('ytdlp:test', async () => {
    try { return { ok: true, version: await ytdlpVersion(profile.settings.ytdlpPath || 'yt-dlp') }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  H('external:open', url => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  setInterval(() => pool.checkAll().then(saveCache), 5 * 60e3);
  setInterval(() => pool.refreshList().then(() => pool.checkAll()).catch(() => {}), 6 * 3600e3);
  setInterval(() => { if (Date.now() - lastRefresh > profile.settings.refreshMinutes * 60e3) refreshCandidates(); }, 60e3);

  send('status', { text: 'Checking instances…' });
  await pool.refreshList().catch(() => {});
  await pool.checkAll();
  await refreshCandidates();
});
app.on('before-quit', () => { try { saveProfile(); saveCache(); } catch {} });
app.on('window-all-closed', () => app.quit());
