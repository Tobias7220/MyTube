const test = require('node:test'), assert = require('node:assert');
const { interests, applyOverrides } = require('../core/scoring');
const { buildFeed } = require('../core/recommend');
const { InstancePool, parseInstanceList } = require('../core/instances');
const { idFromUrl, channelIdFromUrl, normalizeItem, normalizeChannel, pickStreams, Piped } = require('../core/piped');
const { mapYtdlp, mapChannel } = require('../core/ytdlp');
const P = require('../core/profile');

const NOW = Date.parse('2026-11-21T12:00:00Z'), daysAgo = d => new Date(NOW - d * 864e5).toISOString();
const mk = (id, ch, extra = {}) => ({ id, title: id, channelId: ch, channelName: ch, ...extra });
const prof = (over = {}) => ({ ...P.normalize(over), settings: { ...P.DEFAULT_SETTINGS, explorationRatio: 0, ...(over.settings || {}) } });
const blocked = async () => ({ ok: false, status: 500, json: async () => ({ message: 'LOGIN_REQUIRED' }) });

test('interest halves after one half-life', () => {
  const ev = (d, cat) => ({ watchedAt: daysAgo(d), watchRatio: 1, category: cat, channelId: cat, tags: [] });
  const r = interests([ev(0, 'A'), ev(21, 'B')], { halfLifeDays: 21, now: NOW });
  assert.equal(r.category.A, 1); assert.ok(Math.abs(r.category.B - 0.5) < 1e-9);
});
test('history older than retention is pruned', () => {
  const p = P.normalize({ history: [{ watchedAt: daysAgo(31) }, { watchedAt: daysAgo(5) }] });
  assert.equal(P.prune(p, NOW).history.length, 1);
});
test('a like outweighs a watch; a dislike goes negative and fades', () => {
  const watch = { watchedAt: daysAgo(0), watchRatio: 1, channelId: 'W', tags: [] };
  const like = { at: daysAgo(0), rating: 1, channelId: 'L', tags: [] }, dis = { at: daysAgo(0), rating: -1, channelId: 'D', tags: [] };
  const r = interests([watch], { now: NOW, ratings: [like, dis], likeWeight: 3, dislikeWeight: 4 });
  assert.equal(r.channel.L, 1); assert.ok(Math.abs(r.channel.W - 1 / 3) < 1e-9); assert.ok(r.channel.D < -1 + 1e-9 || r.channel.D === -1);
  const old = interests([watch], { now: NOW, ratings: [{ ...dis, at: daysAgo(63) }], dislikeWeight: 4, halfLifeDays: 21 });
  assert.ok(old.channel.D > -0.6);
});
test('feed: disliked channel ranks below neutral; rated videos are not shown again', () => {
  const profile = prof({ ratings: [{ videoId: 'r1', rating: -1, channelId: 'X', at: daysAgo(0), tags: [] }, { videoId: 'r2', rating: 1, channelId: 'Y', at: daysAgo(0), tags: [] }] });
  const ids = buildFeed([mk('r1', 'X'), mk('r2', 'Y'), mk('a', 'X'), mk('b', 'N'), mk('c', 'Y')], {}, profile, { size: 10, now: NOW }).map(v => v.id);
  assert.ok(!ids.includes('r1') && !ids.includes('r2')); assert.deepEqual(ids, ['c', 'b', 'a']);
});
test('ratings toggle and playlists (create, add, dedupe, move, remove, protect Watch later)', () => {
  const p = P.normalize({}), v = { id: 'v1', title: 'T', channelId: 'c', channelName: 'C' };
  assert.equal(P.setRating(p, v, 1, { category: 'Gaming' }), 1); assert.equal(p.ratings[0].category, 'Gaming');
  assert.equal(P.setRating(p, v, -1), -1); assert.equal(p.ratings.length, 1);
  assert.equal(P.setRating(p, v, -1), 0); assert.equal(p.ratings.length, 0);
  assert.equal(p.playlists[0].id, 'watch-later');
  const id = P.createPlaylist(p, ' Mix '); P.addToPlaylist(p, id, v); P.addToPlaylist(p, id, v); P.addToPlaylist(p, id, { id: 'v2', title: 'U' });
  assert.deepEqual(p.playlists[1].videos.map(x => x.id), ['v1', 'v2']);
  P.moveInPlaylist(p, id, 'v1', 1); assert.deepEqual(p.playlists[1].videos.map(x => x.id), ['v2', 'v1']);
  P.removeFromPlaylist(p, id, 'v2'); assert.equal(p.playlists[1].videos.length, 1);
  P.deletePlaylist(p, 'watch-later'); assert.equal(p.playlists[0].id, 'watch-later');
  P.deletePlaylist(p, id); assert.equal(p.playlists.length, 1);
  assert.equal(P.normalize(JSON.parse(JSON.stringify(p))).playlists[0].id, 'watch-later');
});
test('piped parsing', () => {
  assert.equal(idFromUrl('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(channelIdFromUrl('/channel/UC123'), 'UC123');
  assert.equal(normalizeItem({ url: '/playlist?list=PL1' }), null);
  assert.equal(normalizeItem({ url: '/watch?v=abcdefghijk', duration: 30 }).isShort, true);
  assert.equal(normalizeChannel({ url: '/channel/UC9', name: 'X' }).id, 'UC9');
});
test('instance list parser keeps API hosts only', () => {
  const md = 'https://piped.video | https://pipedapi.kavin.rocks | https://pipedapi.kavin.rocks/registered/badge | https://api.piped.yt';
  assert.deepEqual(parseInstanceList(md), ['https://pipedapi.kavin.rocks', 'https://api.piped.yt']);
});
test('requestAny skips blocked instances without marking them dead, and reports real errors', async () => {
  const f = async url => url.startsWith('https://a') ? blocked() : { ok: true, json: async () => ({ x: 1 }) };
  const pool = new InstancePool({ fetchImpl: f, instances: ['https://a', 'https://b'] });
  assert.deepEqual(await pool.requestAny('/x', { batch: 1 }), { x: 1 }); assert.equal(pool.snapshot()[0].ok, null);
  await assert.rejects(new InstancePool({ fetchImpl: blocked, instances: ['https://a'] }).requestAny('/s'), /HTTP 500: LOGIN_REQUIRED/);
});
test('search paging uses the nextpage endpoint', async () => {
  const urls = [];
  const f = async url => { urls.push(url); return { ok: true, json: async () => ({ items: [{ url: '/watch?v=abcdefghijk' }], nextpage: 'TOK' }) }; };
  const piped = new Piped(new InstancePool({ fetchImpl: f, instances: ['https://a'] }));
  assert.equal((await piped.searchPage('cats')).next, 'TOK');
  await piped.searchPage('cats', { token: 'TOK' });
  assert.match(urls[1], /nextpage\/search\?nextpage=TOK&q=cats&filter=videos/);
});
test('stream: Piped blocked -> yt-dlp fallback, block remembered', async () => {
  const piped = new Piped(new InstancePool({ fetchImpl: blocked, instances: ['https://a'] }));
  piped.fallback = async id => ({ id, muxed: [], video: [], audio: [] }); piped.fallbackEnabled = () => true;
  assert.equal((await piped.stream('x')).id, 'x'); assert.ok(piped.streamsBlocked());
  piped.fallbackEnabled = () => false;
  await assert.rejects(piped.stream('x'), /Piped: /);
});
test('channel page: Piped ok / empty / blocked, and yt-dlp paging tokens', async () => {
  const good = async () => ({ ok: true, json: async () => ({ name: 'Ch', relatedStreams: [{ url: '/watch?v=abcdefghijk' }], nextpage: 'N' }) });
  const p1 = new Piped(new InstancePool({ fetchImpl: good, instances: ['https://a'] }));
  const r1 = await p1.channelPage('UC1'); assert.equal(r1.items[0].channelId, 'UC1'); assert.equal(r1.next, 'N');
  const calls = [];
  const fb = async (id, start) => { calls.push(start); return { id, name: 'Ch', items: [{ id: 'zzzzzzzzzzz' }], next: 'ytdlp:' + (start + 30) }; };
  for (const f of [blocked, async () => ({ ok: true, json: async () => ({ name: 'Ch', relatedStreams: [] }) })]) {
    const p = new Piped(new InstancePool({ fetchImpl: f, instances: ['https://a'] }));
    p.fallbackChannel = fb; p.fallbackEnabled = () => true;
    assert.equal((await p.channelPage('UC1')).items[0].id, 'zzzzzzzzzzz');
  }
  const p2 = new Piped(new InstancePool({ fetchImpl: good, instances: ['https://a'] })); p2.fallbackChannel = fb; p2.fallbackEnabled = () => true;
  assert.equal((await p2.channelPage('UC1', 'ytdlp:31')).next, 'ytdlp:61'); assert.equal(calls.at(-1), 31);
});
test('yt-dlp channel listing maps to videos with paging', () => {
  const r = mapChannel({ channel: 'Ch', entries: [{ id: 'abcdefghijk', title: 'T', duration: 300 }, { id: 'abcdefghijl', title: 'S', duration: 20 }, null] }, 'UC1', 2, 2);
  assert.equal(r.items.length, 2); assert.equal(r.items[1].isShort, true); assert.equal(r.next, 'ytdlp:3'); assert.match(r.items[0].thumbnail, /ytimg/);
});
test('feed: filters, subscription boost, categories, exploration', () => {
  const profile = prof({ history: [{ videoId: 's', channelId: 'c1', category: 'Gaming', tags: [], watchRatio: 1, watchedAt: daysAgo(1) }],
    overrides: { blockedChannels: [{ id: 'bad' }], blockedWords: ['spoiler'] } });
  const c = [mk('s', 'c1'), mk('short', 'c1', { isShort: true }), mk('a', 'c1'), mk('m', 'bad'), mk('w', 'x', { title: 'SPOILER inside' }), mk('n', 'z')];
  assert.deepEqual(buildFeed(c, {}, profile, { size: 10, now: NOW }).map(v => v.id), ['a', 'n']);
  const sub = prof({ subscriptions: [{ id: 'z', name: 'Z' }], settings: { subBoost: 1 } });
  assert.equal(buildFeed([mk('a', 'c1'), mk('n', 'z')], {}, sub, { size: 5, now: NOW })[0].sub, true);
  const f = buildFeed([mk('a', 'c1', { hintCategory: 'Music' }), mk('b', 'c2'), mk('c', 'c3')], { c: { category: 'Music' } }, prof(), { size: 5, now: NOW, category: 'Music' });
  assert.deepEqual(f.map(v => v.id).sort(), ['a', 'c']);
  const ex = { ...prof(), settings: { ...P.DEFAULT_SETTINGS, explorationRatio: 0.5 } };
  assert.ok(buildFeed(Array.from({ length: 10 }, (_, i) => mk('v' + i, 'x' + i)), {}, ex, { size: 10, now: NOW, rng: () => 0.3 }).some(v => v.reason === 'explore'));
});
test('onboarding picks, pins and legacy labels', () => {
  const seeds = { at: daysAgo(0), items: ['Gaming'], custom: ['linux'] };
  const r = interests([], { now: NOW, seeds }); assert.equal(r.category.Gaming, 1); assert.equal(r.tag.linux, 1);
  const pinned = applyOverrides(interests([], { now: NOW }), { boost: { category: { Gaming: 0.7 }, tag: { linux: 0.5 } } });
  assert.equal(pinned.category.Gaming, 0.7);
  assert.deepEqual(P.normalize({ seeds: { items: ['Musikk', 'Sport', 'nope'] } }).seeds.items, ['Music', 'Sports']);
});
test('pickStreams / yt-dlp stream mapping', () => {
  const r = pickStreams({ videoStreams: [
    { url: 'u1', quality: '720p', videoOnly: true, codec: 'av01.0', mimeType: 'video/mp4' },
    { url: 'u2', quality: '720p', videoOnly: true, codec: 'avc1', mimeType: 'video/mp4', height: 720 },
    { url: 'u4', quality: '360p', videoOnly: false, codec: 'avc1', mimeType: 'video/mp4', height: 360 }],
    audioStreams: [{ url: 'a1', bitrate: 50 }, { url: 'a2', bitrate: 130 }] });
  assert.deepEqual(r.video.map(s => s.url), ['u2']); assert.equal(r.audio[0].url, 'a2');
  const y = mapYtdlp({ id: 'x', channel_id: 'UC1', categories: ['Gaming'], formats: [
    { url: 'v720', vcodec: 'avc1', acodec: 'none', height: 720, ext: 'mp4', protocol: 'https' },
    { url: 'hls', vcodec: 'avc1', acodec: 'none', height: 1080, ext: 'mp4', protocol: 'm3u8_native' },
    { url: 'a128', vcodec: 'none', acodec: 'mp4a', abr: 128, protocol: 'https' }] });
  assert.deepEqual(y.video.map(s => s.url), ['v720']); assert.equal(y.category, 'Gaming');
});
test('subscriptions CSV import (YouTube Takeout)', () => {
  const csv = 'Channel ID,Channel URL,Channel title\nUCabcdefghijklmnopqrstuv,http://www.youtube.com/channel/UCabcdefghijklmnopqrstuv,Some Channel\n';
  assert.deepEqual(P.parseSubscriptionsCsv(csv), [{ id: 'UCabcdefghijklmnopqrstuv', name: 'Some Channel' }]);
});

// ---------- Beta 0.3 ----------
const F = require('../core/formats');
const { Logger } = require('../core/logger');
const { normalizePlaylist } = require('../core/piped');
const { mapEntries, mapPlaylists } = require('../core/ytdlp');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('CSV parser handles quotes, commas, newlines and BOM; export round-trips', () => {
  const rows = F.parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
  assert.deepEqual(F.parseCsv(F.toCsv(rows)), rows);
});
test('Takeout files: subscriptions, playlist videos, detection, history, NewPipe JSON', () => {
  const subs = [{ id: 'UCabcdefghijklmnopqrstuv', name: 'Chan, "The" One' }];
  const csv = F.exportSubscriptionsCsv(subs);
  assert.match(csv, /^Channel ID,Channel URL,Channel title\n/);
  assert.equal(F.detectCsv(F.parseCsv(csv)), 'subscriptions'); assert.deepEqual(F.parseSubscriptionsCsv(csv), subs);
  const pv = F.exportPlaylistVideosCsv([{ id: 'abcdefghijk', addedAt: '2026-01-01T00:00:00Z' }]);
  assert.equal(F.detectCsv(F.parseCsv(pv)), 'playlist-videos'); assert.deepEqual(F.parsePlaylistVideosCsv(pv), [{ id: 'abcdefghijk', addedAt: '2026-01-01T00:00:00Z' }]);
  assert.equal(F.detectCsv([['Playlist ID', 'x']]), 'playlists-meta'); assert.equal(F.detectCsv([['nope']]), null);
  const hist = JSON.stringify([{ header: 'YouTube', title: 'Watched X', titleUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    subtitles: [{ name: 'Ch', url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv' }], time: '2026-11-20T10:00:00.000Z' }, { title: 'no url' }]);
  assert.deepEqual(F.parseWatchHistoryJson(hist), [{ videoId: 'abcdefghijk', channelId: 'UCabcdefghijklmnopqrstuv', channelName: 'Ch', watchedAt: '2026-11-20T10:00:00.000Z' }]);
  assert.equal(F.parseWatchHistoryJson(F.exportWatchHistoryJson(F.parseWatchHistoryJson(hist)))[0].videoId, 'abcdefghijk');
  assert.deepEqual(F.parseSubsJson(JSON.stringify({ subscriptions: [{ url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', name: 'N' }] })), [{ id: 'UCabcdefghijklmnopqrstuv', name: 'N' }]);
});
test('profile imports: subs, playlists (merge by name), liked, history window', () => {
  const p = P.normalize({});
  assert.equal(P.importSubs(p, [{ id: 'UC1', name: 'A' }, { id: 'UC1', name: 'A' }]), 1);
  assert.equal(P.importPlaylist(p, null, 'Mix', [{ id: 'aaaaaaaaaaa' }, { id: 'bbbbbbbbbbb' }]), 2);
  assert.equal(P.importPlaylist(p, null, 'mix', [{ id: 'bbbbbbbbbbb' }, { id: 'ccccccccccc' }]), 1); assert.equal(p.playlists.length, 2);
  assert.equal(P.importPlaylist(p, 'watch-later', 'Watch later', [{ id: 'ddddddddddd' }]), 1); assert.equal(p.playlists[0].videos.length, 1);
  assert.equal(P.importLiked(p, [{ id: 'eeeeeeeeeee' }, { id: 'eeeeeeeeeee' }]), 1); assert.equal(p.ratings[0].rating, 1);
  const ev = (id, d) => ({ videoId: id, channelId: 'UC1', channelName: 'A', watchedAt: daysAgo(d) });
  assert.equal(P.importHistory(p, [ev('v1', 2), ev('v1', 2), ev('v2', 200)], NOW), 1); assert.equal(p.history.length, 1);
  P.pinChannel(p, 'UC1', true); assert.equal(P.normalize(JSON.parse(JSON.stringify(p))).subscriptions[0].pinned, true);
});
test('logger: masks IDs, filters, rotates, honours level', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')), 'app.log');
  const l = new Logger(f, { max: 300 });
  l.log('warn', 'net', 'GET host/streams/dQw4w9WgXcQ failed: HTTP 500 (?v=abcdefghijk)');
  assert.ok(!/dQw4w9WgXcQ|abcdefghijk/.test(l.text())); assert.match(l.text(), /\/streams\/dQw…#[0-9a-f]{4}/);
  l.setConfig({ fullIds: true }); assert.match(l.log('warn', 'net', '/streams/dQw4w9WgXcQ').msg, /dQw4w9WgXcQ/);
  l.setConfig({ level: 'warn' }); assert.equal(l.log('info', 'x', 'dropped'), null);
  assert.equal(l.entries({ level: 'error' }).length, 0); assert.equal(l.entries({ src: 'net' }).length, 2);
  for (let i = 0; i < 20; i++) l.log('warn', 'net', 'filler line number ' + i);
  assert.ok(fs.existsSync(f + '.1')); assert.ok(fs.statSync(f).size <= 400);
});
test('pool logs requests without query values', async () => {
  const lines = [];
  const pool = new InstancePool({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), instances: ['https://a.example'] });
  pool.log = (lv, src, msg) => lines.push(msg);
  await pool.request('/search?q=my+private+search&filter=videos');
  assert.ok(lines.some(m => m.includes('/search?…')) && !lines.join().includes('private'));
});
test('HDR / 10-bit / HEVC streams are skipped', () => {
  const r = pickStreams({ videoStreams: [
    { url: 'hdr', height: 1080, videoOnly: true, codec: 'vp09.02.40.10', mimeType: 'video/webm' },
    { url: 'hevc', height: 1080, videoOnly: true, codec: 'hvc1.1.6', mimeType: 'video/mp4' },
    { url: 'flag', height: 1080, videoOnly: true, codec: 'vp09.00.40.08', hdr: true },
    { url: 'ok', height: 720, videoOnly: true, codec: 'vp09.00.31.08', mimeType: 'video/webm' }], audioStreams: [] });
  assert.deepEqual(r.video.map(s => s.url), ['ok']);
});
test('channel playlists and playlist videos: Piped tabs, yt-dlp fallback, paging', async () => {
  assert.deepEqual(normalizePlaylist({ url: '/playlist?list=PL123', name: 'Mix', videos: 12 }), { id: 'PL123', title: 'Mix', thumbnail: '', videos: 12 });
  const urls = [];
  const f = async url => { urls.push(url); return { ok: true, json: async () => url.includes('/channels/tabs') ? { content: [{ url: '/playlist?list=PL1', name: 'One' }] }
    : url.includes('/playlists/') ? { name: 'PL', relatedStreams: [{ url: '/watch?v=abcdefghijk' }], nextpage: 'N' } : { tabs: [{ name: 'playlists', data: 'DATA' }], relatedStreams: [] } }; };
  const piped = new Piped(new InstancePool({ fetchImpl: f, instances: ['https://a'] }));
  assert.equal((await piped.channelPlaylists('UC1')).items[0].id, 'PL1'); assert.ok(urls.some(u => u.includes('/channels/tabs?data=DATA')));
  const pl = await piped.playlistPage('PL1'); assert.equal(pl.items.length, 1); assert.equal(pl.next, 'N');
  const calls = []; piped.fallbackList = async (kind, id, start) => { calls.push([kind, start]); return { items: [], next: null }; }; piped.fallbackEnabled = () => true;
  await piped.playlistPage('PL1', 'ytdlp:31'); await piped.channelPlaylists('UC1', null, 'ytdlp:61'); assert.deepEqual(calls, [['playlist', 31], ['playlists', 61]]);
  const blockedPiped = new Piped(new InstancePool({ fetchImpl: blocked, instances: ['https://a'] }));
  blockedPiped.fallbackList = async kind => ({ items: [{ id: 'x' }], next: null, kind }); blockedPiped.fallbackEnabled = () => true;
  assert.equal((await blockedPiped.playlistPage('PL1')).kind, 'playlist');
});
test('yt-dlp flat listings map playlists and playlist videos', () => {
  const pls = mapPlaylists({ entries: [{ id: 'PLabcdefghijkl', title: 'T', playlist_count: 5, thumbnails: [{ url: 'u1' }, { url: 'u2' }] }, { id: 'x' }] }, 1, 1);
  assert.deepEqual(pls.items, [{ id: 'PLabcdefghijkl', title: 'T', thumbnail: 'u2', videos: 5 }]); assert.equal(pls.next, 'ytdlp:2');
  const v = mapEntries({ title: 'List', entries: [{ id: 'abcdefghijk', title: 'V', channel_id: 'UCz' }] }, 'PL1', 30, 30, null);
  assert.equal(v.items[0].channelId, 'UCz'); assert.equal(v.next, null);
});

// ---------- Beta 0.4 ----------
const { parseRss } = require('../core/rss');
const { assetName, parseSums, installYtdlp } = require('../core/install');
const { applyIgnore } = require('../core/scoring');
const crypto = require('node:crypto');

test('regions: messy input is cleaned (UK -> GB), old "region" and old defaults are migrated', () => {
  assert.deepEqual(P.sanitizeRegions('US. NO, UK, us'), ['US', 'NO', 'GB']);
  const old = P.normalize({ version: 3, settings: { region: 'US. NO, UK', defaultQuality: 720, logLevel: 'debug', cardSize: 240 } });
  assert.equal(old.settings.regions, 'US,NO,GB'); assert.equal(old.settings.region, undefined);
  assert.equal(old.settings.defaultQuality, 'auto'); assert.equal(old.settings.logLevel, 'info'); assert.equal(old.settings.cardSize, 240);
  assert.equal(P.normalize({ version: 4, settings: { defaultQuality: 480 } }).settings.defaultQuality, 480); // chosen after migration: kept
});
test('ignore list removes categories, tags and channels from the learned interests', () => {
  const ints = { category: { Gaming: 1, Music: 0.5 }, tag: { linux: 1 }, channel: { UC1: 1, UC2: 1 } };
  applyIgnore(ints, { ignore: { category: ['Gaming'], tag: ['linux'], channel: [{ id: 'UC1' }] } });
  assert.deepEqual(ints, { category: { Music: 0.5 }, tag: {}, channel: { UC2: 1 } });
  assert.deepEqual(P.normalizeOverrides({ ignore: { tag: ['Linux'], channel: [{ id: 'UC1' }] } }).ignore, { category: [], tag: ['linux'], channel: [{ id: 'UC1', name: 'UC1' }] });
});
test('feed: one early favourite does not take over (cap per channel, subscription share, freshness, channel category)', () => {
  const watched = Array.from({ length: 3 }, (_, i) => ({ videoId: 'w' + i, channelId: 'LTT', category: 'Science & Technology', tags: ['pc'], watchRatio: 1, watchedAt: daysAgo(1) }));
  const subs = Array.from({ length: 6 }, (_, i) => ({ id: 'S' + i, name: 'S' + i }));
  const profile = prof({ history: watched, subscriptions: subs, settings: { subShare: 0.5, maxPerChannel: 2 } });
  const cands = [...Array.from({ length: 12 }, (_, i) => mk('l' + i, 'LTT', { published: NOW - i * 3600e3 })), ...subs.map((c, i) => mk('s' + i, c.id, { published: NOW - i * 3600e3 }))];
  const feed = buildFeed(cands, {}, profile, { size: 8, now: NOW });
  assert.ok(feed.filter(v => v.channelId === 'LTT').length <= 2, 'cap per channel');
  assert.ok(feed.filter(v => v.sub).length >= 4, 'subscription share');
  const fresh = buildFeed([mk('old', 'N1', { published: NOW - 40 * 864e5 }), mk('new', 'N2', { published: NOW - 3600e3 })], {}, prof(), { size: 5, now: NOW });
  assert.equal(fresh[0].id, 'new');
  const byChan = buildFeed([mk('a', 'c1'), mk('b', 'c2')], {}, prof(), { size: 5, now: NOW, category: 'Gaming', chanCat: { c1: 'Gaming' } });
  assert.deepEqual(byChan.map(v => v.id), ['a']);
  const unlimited = buildFeed(Array.from({ length: 5 }, (_, i) => mk('u' + i, 'ONE')), {}, prof({ settings: { maxPerChannel: 1 } }), { size: 5, now: NOW });
  assert.equal(unlimited.length, 5, 'cap is relaxed when the pool is too small');
});
test('instances: dead ones are checked less and less, unless forced', async () => {
  let calls = 0;
  const pool = new InstancePool({ fetchImpl: async () => { calls++; return { ok: false, status: 502, json: async () => ({}) }; }, instances: ['https://a', 'https://b'] });
  await pool.checkAll(); assert.equal(calls, 2);
  for (const i of pool.map.values()) { i.fails = 6; i.checkedAt = Date.now() - 60e3; }
  await pool.checkAll(); assert.equal(calls, 2, 'skipped: 6 failures means roughly 80 min between checks');
  await pool.checkAll({ force: true }); assert.equal(calls, 4);
});
test('RSS feed parsing and Piped multi-channel feed', async () => {
  const xml = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>Tom &amp; Jerry</title><author><name>Chan</name></author><published>2026-11-20T10:00:00+00:00</published>
    <media:group><media:thumbnail url="https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" width="480"/><media:community><media:statistics views="1234"/></media:community></media:group></entry></feed>`;
  const [v] = parseRss(xml, 'UC1');
  assert.deepEqual([v.id, v.title, v.channelName, v.views, v.channelId], ['abcdefghijk', 'Tom & Jerry', 'Chan', 1234, 'UC1']); assert.equal(v.published, Date.parse('2026-11-20T10:00:00+00:00'));
  const urls = [];
  const f = async url => { urls.push(url); return { ok: true, json: async () => [{ url: '/watch?v=abcdefghijk', uploaderUrl: '/channel/UC1', uploaded: 5 }] }; };
  const piped = new Piped(new InstancePool({ fetchImpl: f, instances: ['https://a'] }));
  const items = await piped.feed(['UC1', 'UC2']); assert.equal(items[0].channelId, 'UC1'); assert.match(urls[0], /\/feed\/unauthenticated\?channels=UC1,UC2$/);
});
test('yt-dlp installer: right asset, checksum parsing, verified write, refuses a bad checksum', async () => {
  assert.deepEqual([assetName('linux', 'x64'), assetName('linux', 'arm64'), assetName('darwin', 'x64'), assetName('win32', 'x64')], ['yt-dlp_linux', 'yt-dlp_linux_aarch64', 'yt-dlp_macos', 'yt-dlp.exe']);
  const bin = Buffer.from('fake binary'), sha = crypto.createHash('sha256').update(bin).digest('hex');
  assert.equal(parseSums(`${sha}  yt-dlp_linux\n${'0'.repeat(64)} *yt-dlp.exe\n`, 'yt-dlp_linux'), sha);
  const mkFetch = sums => async url => ({ ok: true, status: 200, text: async () => sums, arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  const out = await installYtdlp({ dir, fetchImpl: mkFetch(`${sha}  yt-dlp_linux\n`), platform: 'linux', arch: 'x64' });
  assert.equal(fs.readFileSync(out, 'utf8'), 'fake binary'); assert.ok(fs.statSync(out).mode & 0o100, 'executable');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  await assert.rejects(installYtdlp({ dir: dir2, fetchImpl: mkFetch(`${'1'.repeat(64)}  yt-dlp_linux\n`), platform: 'linux', arch: 'x64' }), /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(dir2, 'yt-dlp')), false);
});
