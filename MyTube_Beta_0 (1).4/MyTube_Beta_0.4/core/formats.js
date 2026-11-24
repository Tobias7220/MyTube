// Import/export in the file types YouTube (Google Takeout) and other players use.
// Best-effort: based on the commonly seen Takeout layouts; verify against a real export.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const cell = s => { s = String(s ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = rows => rows.map(r => r.map(cell).join(',')).join('\n') + '\n';

function detectCsv(rows) {
  const h = (rows[0]?.[0] || '').trim().toLowerCase();
  if (h === 'channel id') return 'subscriptions';
  if (h === 'video id') return 'playlist-videos';
  if (h === 'playlist id') return 'playlists-meta';
  return null;
}
const isChannelId = s => /^UC[\w-]{20,}$/.test(s || '');
function parseSubscriptionsCsv(text) {
  return parseCsv(text).slice(1).filter(r => isChannelId(r[0])).map(r => ({ id: r[0], name: r[2] || r[0] }));
}
const exportSubscriptionsCsv = subs => toCsv([['Channel ID', 'Channel URL', 'Channel title'],
  ...subs.map(c => [c.id, 'http://www.youtube.com/channel/' + c.id, c.name])]);
function parsePlaylistVideosCsv(text) {
  return parseCsv(text).slice(1).filter(r => /^[\w-]{6,}$/.test(r[0] || '')).map(r => ({ id: r[0], addedAt: r[1] || null }));
}
const exportPlaylistVideosCsv = videos => toCsv([['Video ID', 'Playlist video creation timestamp'],
  ...videos.map(v => [v.id, v.addedAt || new Date().toISOString()])]);

// Takeout "watch-history.json": [{ header, title, titleUrl, subtitles:[{name,url}], time, products }]
function parseWatchHistoryJson(text) {
  const arr = JSON.parse(text), out = [];
  if (!Array.isArray(arr)) throw new Error('not a watch history file');
  for (const e of arr) {
    const m = (e?.titleUrl || '').match(/[?&]v=([\w-]{6,})/);
    if (!m || !e.time || isNaN(Date.parse(e.time))) continue;
    const sub = (e.subtitles || [])[0], ch = ((sub && sub.url) || '').match(/\/channel\/(UC[\w-]+)/);
    out.push({ videoId: m[1], channelId: ch ? ch[1] : null, channelName: (sub && sub.name) || '', watchedAt: new Date(e.time).toISOString() });
  }
  return out;
}
const exportWatchHistoryJson = history => JSON.stringify(history.map(e => ({
  header: 'YouTube', title: 'Watched a video', titleUrl: 'https://www.youtube.com/watch?v=' + e.videoId,
  ...(e.channelId ? { subtitles: [{ name: e.channelName || e.channelId, url: 'https://www.youtube.com/channel/' + e.channelId }] } : {}),
  time: e.watchedAt, products: ['YouTube'] })), null, 2);

// NewPipe / Piped style: { subscriptions: [{ url: ".../channel/UC...", name }] }
function parseSubsJson(text) {
  const j = JSON.parse(text);
  return (j.subscriptions || []).map(s => ({ id: ((s.url || s.id || '').match(/(UC[\w-]{20,})/) || [])[1], name: s.name || s.title || '' }))
    .filter(c => c.id).map(c => ({ id: c.id, name: c.name || c.id }));
}
module.exports = { parseCsv, toCsv, detectCsv, parseSubscriptionsCsv, exportSubscriptionsCsv, parsePlaylistVideosCsv, exportPlaylistVideosCsv,
  parseWatchHistoryJson, exportWatchHistoryJson, parseSubsJson };
