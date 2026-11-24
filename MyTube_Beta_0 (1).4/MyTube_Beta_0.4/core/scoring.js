// Interest = sum over watch events of (0.5^(age/halfLife) * watchRatio), per category/tag/channel, scaled to 0..1.
const { INTERESTS } = require('./categories');
const DAY = 864e5;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function interests(history, { halfLifeDays = 21, now = Date.now(), seeds = null, minWatch = 0.1, ratings = [], likeWeight = 3, dislikeWeight = 4 } = {}) {
  const pos = { category: {}, tag: {}, channel: {} }, neg = { category: {}, tag: {}, channel: {} };
  const add = (o, k, w) => { if (k) o[k] = (o[k] || 0) + w; };
  const feed = (o, e, w) => { add(o.category, e.category, w); add(o.channel, e.channelId, w); for (const t of e.tags || []) add(o.tag, String(t).toLowerCase(), w); };
  const decay = at => Math.pow(0.5, Math.max(0, now - Date.parse(at)) / DAY / halfLifeDays);
  for (const e of history) feed(pos, e, decay(e.watchedAt) * clamp(+e.watchRatio || 0, minWatch, 1));
  // A like counts as several full watches, a dislike as a strong negative (both fade with the half-life).
  for (const r of ratings) feed(r.rating > 0 ? pos : neg, r, decay(r.at) * (r.rating > 0 ? likeWeight : dislikeWeight));
  // Category picks act like a watch that fades with the same half-life (never a permanent profile).
  if (seeds) {
    const w = 0.6 * decay(seeds.at);
    for (const n of seeds.items || []) add(pos.category, INTERESTS[n]?.category, w);
    for (const c of seeds.custom || []) for (const t of tokens(c)) add(pos.tag, t, w);
  }
  const out = { category: {}, tag: {}, channel: {} };
  for (const t of Object.keys(out)) {
    const max = Math.max(1e-9, ...Object.values(pos[t]));
    for (const k of new Set([...Object.keys(pos[t]), ...Object.keys(neg[t])])) out[t][k] = clamp(((pos[t][k] || 0) - (neg[t][k] || 0)) / max, -1, 1);
  }
  return out;
}
// Ignored categories/tags/channels are removed from what the algorithm uses.
function applyIgnore(ints, o) {
  const ig = o?.ignore; if (!ig) return ints;
  for (const t of ['category', 'tag']) for (const k of ig[t] || []) delete ints[t][k];
  for (const c of ig.channel || []) delete ints.channel[c.id];
  return ints;
}
// Manual pins set a floor under the learned value (0..1).
function applyOverrides(ints, o) {
  applyIgnore(ints, o);
  for (const t of ['category', 'tag'])
    for (const [k, v] of Object.entries(o?.boost?.[t] || {})) ints[t][k] = Math.max(ints[t][k] || 0, v);
  return ints;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'this', 'that', 'what', 'how', 'from', 'your']);
const tokens = t => ((t || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w));
const top3 = a => a.sort((x, y) => y - x).slice(0, 3).reduce((p, c) => p + c, 0) / 3;

// Channel is always known; category/tags only once metadata is fetched (falls back to hint + title words).
function scoreVideo(v, meta, ints, w = { wChannel: 0.45, wTag: 0.35, wCategory: 0.2 }) {
  const ch = ints.channel[v.channelId] || 0;
  const catName = meta?.category || v.hintCategory;
  const cat = catName ? ints.category[catName] || 0 : 0;
  const words = meta?.tags?.length ? meta.tags.map(t => t.toLowerCase()) : tokens(v.title);
  const vals = words.map(x => ints.tag[x] || 0);
  const tag = top3(vals.filter(x => x > 0)) + 0.5 * Math.min(0, ...vals);
  return w.wChannel * ch + w.wTag * tag + w.wCategory * cat;
}
module.exports = { interests, applyIgnore, applyOverrides, scoreVideo, tokens };
