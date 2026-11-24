// Runs main.js against a fake Electron and exercises the IPC handlers (no network, no GUI).
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mytube-smoke-'));
const FEED = [{ url: '/watch?v=fffffffffff', title: 'Feed video', uploaderUrl: '/channel/UCabcdefghijklmnopqrstuv', uploaderName: 'Some Channel', uploaded: Date.now(), duration: 300, views: 5 }];
global.fetch = async url => {            // tiny fake Piped: health + feed + streams work, everything else is offline
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  if (/\/feed\/unauthenticated/.test(url)) return ok(FEED);
  if (/\/streams\//.test(url)) return ok({ title: 'Resolved title', uploader: 'Some Channel', uploaderUrl: '/channel/UCabcdefghijklmnopqrstuv', category: 'Gaming', tags: ['a'], videoStreams: [], audioStreams: [] });
  if (/\/trending/.test(url)) return ok([]);
  throw new Error('offline (smoke test)');
};
const handlers = {};
let openRes = { canceled: true, filePaths: [] };
const mock = {
  app: { getPath: () => tmp, whenReady: () => Promise.resolve(), on() {} },
  BrowserWindow: class { constructor() { this.webContents = { send() {}, on() {} }; } loadFile() {} setMenuBarVisibility() {} isDestroyed() { return false; } },
  ipcMain: { handle: (c, f) => { handlers[c] = f; } },
  dialog: { showOpenDialog: async () => openRes, showSaveDialog: async () => ({ canceled: true }) },
  shell: { openExternal() {}, openPath: async () => '', showItemInFolder() {} },
  clipboard: { text: '', writeText(t) { this.text = t; } },
};
const orig = Module._load; Module._load = function (r, ...a) { return r === 'electron' ? mock : orig.call(this, r, ...a); };
require('../main.js');
const call = (c, ...a) => handlers[c]({}, ...a);
const w = (n, t) => { const p = path.join(tmp, n); fs.writeFileSync(p, t); return p; };

(async () => {
  await new Promise(r => setTimeout(r, 400));
  let p = await call('profile:get');
  assert.equal(p.playlists[0].id, 'watch-later'); assert.equal(p.settings.navLayout, 'top'); assert.equal(p.needsOnboarding, true);

  const files = [
    w('subscriptions.csv', 'Channel ID,Channel URL,Channel title\nUCabcdefghijklmnopqrstuv,http://www.youtube.com/channel/UCabcdefghijklmnopqrstuv,Some Channel\n'),
    w('Liked videos-videos.csv', 'Video ID,Playlist video creation timestamp\nabcdefghijk,2026-11-20T10:00:00+00:00\n'),
    w('Road trip-videos.csv', 'Video ID,Playlist video creation timestamp\naaaaaaaaaaa,2026-11-20T10:00:00+00:00\nbbbbbbbbbbb,2026-11-21T10:00:00+00:00\n'),
    w('watch-history.json', JSON.stringify([{ title: 'Watched X', titleUrl: 'https://www.youtube.com/watch?v=ccccccccccc', subtitles: [{ name: 'Ch', url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv' }], time: new Date().toISOString() },
      { title: 'Old', titleUrl: 'https://www.youtube.com/watch?v=ddddddddddd', time: '2020-01-01T00:00:00Z' }])),
    w('playlists.csv', 'Playlist ID,Playlist create timestamp\nPL1,2020\n'), w('bad.csv', 'what,is,this\n1,2,3\n'),
  ];
  openRes = { canceled: false, filePaths: files };
  const s = await call('data:import');
  assert.deepEqual([s.subs, s.playlists, s.playlistVideos, s.likes, s.history, s.skipped.length], [1, 1, 2, 1, 1, 2], JSON.stringify(s));

  p = await call('profile:get');
  assert.equal(p.subscriptions.length, 1); assert.equal(p.liked.length, 1); assert.ok(p.playlists.some(x => x.name === 'Road trip' && x.videos.length === 2));
  assert.equal((await call('subs:pin', 'UCabcdefghijklmnopqrstuv', true))[0].pinned, true);
  assert.equal(await call('rate:set', { id: 'zzzzzzzzzzz', title: 'T', channelId: 'UCx' }, -1), -1);
  assert.equal((await call('settings:set', { navLayout: 'sidebar', defaultQuality: 'auto', logLevel: 'info', subsVisibleCount: '3' })).subsVisibleCount, 3);
  assert.equal((await call('settings:set', { regions: 'US. NO, UK' })).regions, 'US,NO,GB');

  const out = path.join(tmp, 'exports'); fs.mkdirSync(out);
  openRes = { canceled: false, filePaths: [out] };
  const ex = await call('data:export');
  for (const f of ['subscriptions.csv', 'watch-history.json', path.join('playlists', 'Road trip-videos.csv'), path.join('playlists', 'Liked videos-videos.csv')]) assert.ok(ex.files.includes(f), f);
  assert.match(fs.readFileSync(path.join(ex.dir, 'subscriptions.csv'), 'utf8'), /^Channel ID,Channel URL,Channel title\nUCabcdefghijklmnopqrstuv,/);

  assert.equal((await call('log:get', { level: 'info' })).some(l => /import:/.test(l.line)), true);
  await call('diag:copy'); assert.match(mock.clipboard.text, /diagnostics/); assert.match(mock.clipboard.text, /instances:/);
  const rows = await call('diag:selftest'); assert.ok(rows.length > 3 && rows.some(r => r.status === 'FAIL'));
  assert.ok(await call('subs:refresh') >= 0); const sf = await call('subs:feed', 10); assert.ok(sf.some(v => v.id === 'fffffffffff'), 'subscription feed video present');
  assert.deepEqual(await call('meta:resolve', 'liked'), { resolved: 1, remaining: 0 });
  assert.equal((await call('profile:get')).liked[0].title, 'Resolved title');
  const hh = await call('health:hint'); assert.ok(hh.total > 0 && typeof hh.alive === 'number' && ['ok', 'missing', 'disabled'].includes(hh.ytdlp));
  assert.equal(typeof handlers['win:ctl'], 'function'); assert.equal(typeof handlers['ytdlp:install'], 'function');
  assert.equal((await call('profile:get')).settings.region, undefined);
  await assert.rejects(call('chan:playlists', 'UCabcdefghijklmnopqrstuv'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'profile.json'), 'utf8')).settings.navLayout, 'sidebar');
  assert.ok(fs.existsSync(path.join(tmp, 'app.log')));
  console.log('SMOKE OK'); process.exit(0);
})().catch(e => { console.error('SMOKE FAIL', e); process.exit(1); });
