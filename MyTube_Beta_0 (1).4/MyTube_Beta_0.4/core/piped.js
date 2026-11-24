// Piped API adapter: normalises Piped's responses into MyTube's video model.
const idFromUrl = u => ((u || '').match(/[?&]v=([\w-]{6,})/) || [])[1] || null;
const channelIdFromUrl = u => ((u || '').split('/channel/')[1] || '').split(/[/?]/)[0] || null;
const BLOCK_RE = /LOGIN_REQUIRED|sign in to confirm|not a bot/i;
// Skipped: AV1 and HEVC (no cheap decode), 10-bit/HDR VP9 profiles (they trigger "Unsupported pixel format").
const BAD_CODEC = /av01|hev1|hvc1|vp09\.0[23]/i;

function normalizeItem(i, fb = {}) {
  const id = idFromUrl(i.url);
  if (!id) return null; // playlists/channels in search results
  return {
    id, title: i.title,
    channelId: channelIdFromUrl(i.uploaderUrl) || fb.channelId || null,
    channelName: i.uploaderName || fb.channelName || '',
    thumbnail: i.thumbnail, duration: i.duration, views: i.views, published: i.uploaded || null,
    isShort: !!i.isShort || (i.duration > 0 && i.duration <= 60),
  };
}
function normalizeChannel(i) {
  const id = channelIdFromUrl(i.url);
  return id ? { id, name: i.name || '', thumbnail: i.thumbnail, subscribers: i.subscribers, verified: !!i.verified } : null;
}

// Most YouTube streams are video-only + separate audio, so we return both kinds.
// AV1 is skipped (heavy software decode); one stream per resolution, mp4 preferred.
function pickStreams(d) {
  const vs = (d.videoStreams || []).filter(v => v.url && !v.hdr && !BAD_CODEC.test(v.codec || '')).map(v => ({
    url: v.url, height: v.height || parseInt(v.quality) || 0, videoOnly: !!v.videoOnly, mp4: /mp4/i.test(v.mimeType || v.format || ''),
  }));
  const byHeight = list => {
    const m = new Map();
    for (const s of list.sort((a, b) => b.mp4 - a.mp4)) if (!m.has(s.height)) m.set(s.height, s);
    return [...m.values()].sort((a, b) => b.height - a.height);
  };
  const audio = (d.audioStreams || []).filter(a => a.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)).map(a => ({ url: a.url }));
  return { muxed: byHeight(vs.filter(s => !s.videoOnly)), video: byHeight(vs.filter(s => s.videoOnly)), audio };
}

class Piped {
  constructor(pool) {
    this.pool = pool; this.badUntil = 0; this.fallback = null; this.fallbackChannel = null; this.fallbackList = null;
    this.fallbackEnabled = () => false; this.log = () => {};
  }
  streamsBlocked() { return Date.now() < this.badUntil; }
  // All Piped calls that can be IP-blocked go through here, so a block is remembered for 10 minutes.
  async _pg(path, max = 4) {
    try { return await this.pool.requestAny(path, { max }); }
    catch (e) { if (BLOCK_RE.test(e.message)) this.badUntil = Date.now() + 10 * 60e3; throw e; }
  }
  async _try(order, label = '') {
    const errs = [];
    for (const [name, fn] of order) {
      try { const r = await fn(); this.log('debug', 'piped', `${label} via ${name} ok`); return r; }
      catch (e) { errs.push(`${name}: ${e.message}`); this.log('warn', 'piped', `${label} via ${name} failed: ${e.message.split('\n')[0].slice(0, 200)}`); }
    }
    throw new Error(errs.join('\n'));
  }
  // "ytdlp:N" tokens are offsets into a yt-dlp listing; otherwise Piped first (unless currently blocked).
  _route(viaPiped, viaFb, canFb, token, label) {
    if (token && token.startsWith('ytdlp:')) return this._try([viaFb], label);
    return this._try(canFb && this.streamsBlocked() ? [viaFb, ['Piped', viaPiped]] : [['Piped', viaPiped], ...(canFb ? [viaFb] : [])], label);
  }

  async trending(region = 'US') {
    const d = await this.pool.request('/trending?region=' + encodeURIComponent(region));
    return (d || []).map(i => normalizeItem(i)).filter(Boolean);
  }
  // type: 'videos' | 'channels'. Pass the previous result's `next` as token to get the following page.
  async searchPage(q, { type = 'videos', token = null } = {}) {
    const qs = `q=${encodeURIComponent(q)}&filter=${type}`;
    const d = await this.pool.request(token ? `/nextpage/search?nextpage=${encodeURIComponent(token)}&${qs}` : `/search?${qs}`);
    const items = (d.items || []).map(i => type === 'channels' ? normalizeChannel(i) : normalizeItem(i)).filter(Boolean);
    return { items, next: d.nextpage || null };
  }

  // Latest videos for many channels in one request (Piped: /feed/unauthenticated?channels=ID,ID,...).
  async feed(ids) {
    const d = await this._pg('/feed/unauthenticated?channels=' + ids.map(encodeURIComponent).join(','), 3);
    return (Array.isArray(d) ? d : d.relatedStreams || []).map(i => normalizeItem(i)).filter(Boolean);
  }

  async channelPage(id, token = null, { fallback = true } = {}) {
    const viaPiped = async () => {
      const path = token ? `/nextpage/channel/${encodeURIComponent(id)}?nextpage=${encodeURIComponent(token)}` : '/channel/' + encodeURIComponent(id);
      const d = await this._pg(path);
      if (!d.relatedStreams && (d.error || d.message)) throw new Error(d.message || d.error);
      const items = (d.relatedStreams || []).map(i => normalizeItem(i, { channelId: id, channelName: d.name })).filter(Boolean);
      if (!token && !items.length) throw new Error('empty channel response');
      const tab = (d.tabs || []).find(t => /playlists?/i.test(t.name || ''));
      return { id, name: d.name || '', avatar: d.avatarUrl, subscribers: d.subscriberCount, items, next: d.nextpage || null, playlistsTab: tab ? tab.data : null };
    };
    const viaFb = ['yt-dlp', () => this.fallbackChannel(id, ytStart(token))];
    return this._route(viaPiped, viaFb, fallback && this.fallbackChannel && this.fallbackEnabled(), token, '/channel/' + id);
  }
  async channel(id) { return (await this.channelPage(id)).items; }

  // A channel's playlists (Piped: the "playlists" tab, first page; yt-dlp: paged listing).
  async channelPlaylists(id, tabData = null, token = null) {
    const viaPiped = async () => {
      let data = tabData;
      if (!data) { const d = await this._pg('/channel/' + encodeURIComponent(id)); data = ((d.tabs || []).find(t => /playlists?/i.test(t.name || '')) || {}).data; }
      if (!data) throw new Error('no playlists tab in response');
      const d = await this._pg('/channels/tabs?data=' + encodeURIComponent(data));
      return { items: (d.content || []).map(normalizePlaylist).filter(Boolean), next: null };
    };
    const viaFb = ['yt-dlp', () => this.fallbackList('playlists', id, ytStart(token))];
    return this._route(viaPiped, viaFb, this.fallbackList && this.fallbackEnabled(), token, '/channels/' + id + ' playlists');
  }
  async playlistPage(id, token = null) {
    const viaPiped = async () => {
      const d = await this._pg(token ? `/nextpage/playlists/${encodeURIComponent(id)}?nextpage=${encodeURIComponent(token)}` : '/playlists/' + encodeURIComponent(id));
      const items = (d.relatedStreams || []).map(i => normalizeItem(i)).filter(Boolean);
      if (!token && !items.length) throw new Error('empty playlist response');
      return { id, name: d.name || '', items, next: d.nextpage || null };
    };
    const viaFb = ['yt-dlp', () => this.fallbackList('playlist', id, ytStart(token))];
    return this._route(viaPiped, viaFb, this.fallbackList && this.fallbackEnabled(), token, '/playlists/' + id);
  }

  // Category/tags + playable streams. Order of sources depends on settings and on whether Piped is currently blocked.
  async stream(id, { fallback = true, max = 6, preferFallback = false } = {}) {
    const viaPiped = async () => {
      const d = await this._pg('/streams/' + encodeURIComponent(id), max);
      return { id, title: d.title, channelId: channelIdFromUrl(d.uploaderUrl), channelName: d.uploader,
        category: d.category || null, tags: (d.tags || []).slice(0, 15), duration: d.duration, thumbnail: d.thumbnailUrl || '', ...pickStreams(d) };
    };
    const viaFb = ['yt-dlp', () => this.fallback(id)];
    const canFb = fallback && this.fallback && this.fallbackEnabled();
    return this._try(canFb && (preferFallback || this.streamsBlocked()) ? [viaFb, ['Piped', viaPiped]]
      : [['Piped', viaPiped], ...(canFb ? [viaFb] : [])], '/streams/' + id);
  }
}
function normalizePlaylist(i) {
  const id = ((i.url || '').match(/[?&]list=([\w-]+)/) || [])[1];
  return id ? { id, title: i.name || i.title || '', thumbnail: i.thumbnail || '', videos: i.videos >= 0 ? i.videos : null } : null;
}
const ytStart = t => (t && t.startsWith('ytdlp:') ? +t.slice(6) || 1 : 1);

module.exports = { normalizePlaylist, Piped, normalizeItem, normalizeChannel, idFromUrl, channelIdFromUrl, pickStreams };
