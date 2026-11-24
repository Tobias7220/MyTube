// Optional local fallback: resolve streams / listings with the user's own yt-dlp when public Piped instances fail.
// Talks to YouTube directly from the user's IP (no proxy), so it is a setting the user can turn off.
const { execFile } = require('child_process');
const { pickStreams } = require('./piped');

let log = () => {};
const setLogger = f => { log = f; };
const okProto = x => x.protocol === 'https' || x.protocol === 'http' || x.protocol === undefined;

function mapYtdlp(j) {
  const f = j.formats || [];
  const videoStreams = f.filter(x => x.url && x.vcodec && x.vcodec !== 'none' && okProto(x)).map(x => ({
    url: x.url, height: x.height || 0, codec: x.vcodec, videoOnly: !x.acodec || x.acodec === 'none',
    hdr: !!x.dynamic_range && x.dynamic_range !== 'SDR', mimeType: x.ext === 'mp4' ? 'video/mp4' : 'video/' + x.ext,
  }));
  const audioStreams = f.filter(x => x.url && x.acodec && x.acodec !== 'none' && (!x.vcodec || x.vcodec === 'none') && okProto(x))
    .map(x => ({ url: x.url, bitrate: x.abr || x.tbr || 0 }));
  return {
    id: j.id, title: j.title, channelId: j.channel_id || null, channelName: j.channel || j.uploader || '',
    category: (j.categories || [])[0] || null, tags: (j.tags || []).slice(0, 15), duration: j.duration, thumbnail: j.thumbnail || '',
    ...pickStreams({ videoStreams, audioStreams }),
  };
}
// Flat listing (cheap: no format extraction). Thumbnails come from YouTube's image host.
function mapEntries(j, id, count, end, fbChannel) {
  const name = j.channel || j.uploader || (j.title || '').replace(/ - Videos$/, '');
  const items = (j.entries || []).filter(e => e && /^[\w-]{6,}$/.test(e.id || '')).map(e => ({
    id: e.id, title: e.title, channelId: e.channel_id || fbChannel || null, channelName: e.channel || e.uploader || name,
    thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, duration: e.duration || 0, views: e.view_count, published: null,
    isShort: e.duration > 0 && e.duration <= 60,
  }));
  return { id, name, avatar: null, subscribers: null, items, next: items.length >= count ? 'ytdlp:' + (end + 1) : null };
}
const mapChannel = (j, id, count, end) => mapEntries(j, id, count, end, id);
function mapPlaylists(j, count, end) {
  const items = (j.entries || []).filter(e => e && /^[\w-]{10,}$/.test(e.id || '')).map(e => ({
    id: e.id, title: e.title || '', thumbnail: ((e.thumbnails || []).slice(-1)[0] || {}).url || '', videos: e.playlist_count || null }));
  return { items, next: items.length >= count ? 'ytdlp:' + (end + 1) : null };
}

// At most 2 yt-dlp processes at a time (background refreshes must not spawn dozens).
let active = 0; const waiting = [];
const limited = fn => new Promise((res, rej) => {
  const go = () => { active++; fn().then(res, rej).finally(() => { active--; waiting.shift()?.(); }); };
  active < 2 ? go() : waiting.push(go);
});
function run(bin, args, label) {
  return limited(() => new Promise((resolve, reject) => {
    const t = Date.now();
    execFile(bin, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const ms = Date.now() - t;
      if (!err) { log('debug', 'yt-dlp', `${label} ok ${ms}ms`); return resolve(stdout); }
      const last = ((stderr || err.message).trim().split('\n').filter(Boolean).pop() || 'unknown error').slice(0, 220);
      log('warn', 'yt-dlp', `${label} failed ${ms}ms: ${last}`);
      reject(Object.assign(new Error(last), { code: err.code, stderr: stderr || '' }));
    });
  }));
}
const notInstalled = () => new Error('yt-dlp is not installed (or not on PATH)');

// `extra` is user-editable (default "--js-runtimes node": yt-dlp needs a JS runtime for YouTube; only deno is on by default).
// If an older yt-dlp rejects the extra flags, retry without them.
async function ytdlpStream(id, { bin = 'yt-dlp', extra = '' } = {}) {
  const base = ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '15'];
  const ex = extra.split(/\s+/).filter(Boolean), url = 'https://www.youtube.com/watch?v=' + id, label = `stream /watch?v=${id}`;
  let out;
  try { out = await run(bin, [...base, ...ex, url], label); }
  catch (e) {
    if (e.code === 'ENOENT') throw notInstalled();
    if (ex.length && /no such option|unrecognized arguments/i.test(e.stderr || e.message)) out = await run(bin, [...base, url], label + ' (without extra args)');
    else throw e;
  }
  try { return mapYtdlp(JSON.parse(out)); } catch { throw new Error('unreadable output from yt-dlp'); }
}
const LIST_URL = {
  channel: id => `https://www.youtube.com/channel/${id}/videos`,
  playlists: id => `https://www.youtube.com/channel/${id}/playlists`,
  playlist: id => `https://www.youtube.com/playlist?list=${id}`,
};
// kind: 'channel' (videos) | 'playlists' (a channel's playlists) | 'playlist' (videos in one playlist)
async function ytdlpList(kind, id, { bin = 'yt-dlp', start = 1, count = 30 } = {}) {
  const end = start + count - 1;
  const args = ['-J', '--flat-playlist', '--no-warnings', '--socket-timeout', '15', '--playlist-start', String(start), '--playlist-end', String(end), LIST_URL[kind](id)];
  let out;
  try { out = await run(bin, args, `list ${kind} /${kind === 'playlist' ? 'playlists' : 'channel'}/${id}`); }
  catch (e) {
    if (e.code === 'ENOENT') throw notInstalled();
    if (kind === 'channel' && /does not have a videos tab/i.test(e.message)) return { id, name: '', avatar: null, subscribers: null, items: [], next: null, noVideosTab: true };
    throw e;
  }
  try { const j = JSON.parse(out); return kind === 'playlists' ? mapPlaylists(j, count, end) : mapEntries(j, id, count, end, kind === 'channel' ? id : null); }
  catch { throw new Error('unreadable output from yt-dlp'); }
}
const ytdlpChannel = (id, o) => ytdlpList('channel', id, o);
async function ytdlpVersion(bin = 'yt-dlp') {
  try { return (await run(bin, ['--version'], 'version')).trim(); }
  catch (e) { throw e.code === 'ENOENT' ? notInstalled() : e; }
}
module.exports = { ytdlpStream, ytdlpList, ytdlpChannel, ytdlpVersion, mapYtdlp, mapChannel, mapEntries, mapPlaylists, setLogger };
