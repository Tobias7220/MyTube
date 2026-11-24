const { interests, applyOverrides, scoreVideo } = require('./scoring');

function shuffle(a, rng) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 1) drop seen, Shorts, muted, other categories  2) score: learned interest (scaled by how much data there is)
//    + subscription boost + freshness  3) reserve exploration slots  4) pick: a share for subscriptions first,
//    never more than N per channel  5) spread same-channel videos apart, interleave exploration
function buildFeed(cands, meta, profile, { size, now = Date.now(), rng = Math.random, category = null, chanCat = {} } = {}) {
  const s = profile.settings; size = size || s.feedSize;
  const ints = applyOverrides(interests(profile.history, { halfLifeDays: s.interestHalfLifeDays, now, seeds: profile.seeds, minWatch: s.minWatchRatio,
    ratings: profile.ratings, likeWeight: s.likeWeight, dislikeWeight: s.dislikeWeight }), profile.overrides);
  const seen = new Set([...profile.history.map(e => e.videoId), ...profile.ratings.map(r => r.videoId)]);
  const subs = new Set(profile.subscriptions.map(c => c.id));
  const mutedCh = new Set(profile.overrides.blockedChannels.map(c => c.id));
  const words = profile.overrides.blockedWords;
  // With only a handful of watches, the first few would dominate (e.g. 100% one channel): trust learned interest less.
  const conf = Math.max(0.25, Math.min(1, (profile.history.length + 3 * profile.ratings.length) / 15));
  const w = { wChannel: s.wChannel * conf, wTag: s.wTag * conf, wCategory: s.wCategory * conf };
  const catOf = v => meta[v.id]?.category || v.hintCategory || chanCat[v.channelId] || null;
  const fresh = v => (v.published ? Math.exp(-Math.max(0, now - v.published) / 864e5 / 7) : 0);

  const uniq = new Map();
  for (const v of cands) {
    if (seen.has(v.id) || (!s.shortsEnabled && v.isShort) || mutedCh.has(v.channelId)) continue;
    if (words.length && words.some(x => (v.title || '').toLowerCase().includes(x))) continue;
    if (category && catOf(v) !== category) continue;
    uniq.set(v.id, v);
  }
  const pool = [...uniq.values()].map((v, i) => ({
    v, i, cat: catOf(v), sub: subs.has(v.channelId),
    score: scoreVideo(v, meta[v.id], ints, w) + (subs.has(v.channelId) ? s.subBoost : 0) + (s.recencyWeight || 0) * fresh(v),
  }));

  const nExplore = Math.round(size * s.explorationRatio);
  const explore = shuffle(pool.filter(x => !ints.channel[x.v.channelId] && !x.sub), rng).slice(0, nExplore);
  const taken = new Set(explore.map(x => x.v.id));
  const rest = pool.filter(x => !taken.has(x.v.id));

  const cap = s.maxPerChannel > 0 ? s.maxPerChannel : Infinity;
  const picked = [], chCount = {}, cats = [], target = size - explore.length;
  const greedy = (n, pred, useCap) => {
    for (let c = 0; c < n && rest.length; c++) {
      let best = -1, bestS = -Infinity;
      rest.forEach((x, idx) => {
        if (!pred(x) || (useCap && (chCount[x.v.channelId] || 0) >= cap)) return;
        const sc = x.score - s.channelRepeatPenalty * (chCount[x.v.channelId] || 0)
          - s.categoryRepeatPenalty * cats.slice(-3).filter(k => k && k === x.cat).length - x.i * 1e-6;
        if (sc > bestS) { bestS = sc; best = idx; }
      });
      if (best < 0) break;
      const [x] = rest.splice(best, 1);
      picked.push(x); chCount[x.v.channelId] = (chCount[x.v.channelId] || 0) + 1; cats.push(x.cat);
    }
  };
  greedy(subs.size ? Math.round(target * s.subShare) : 0, x => x.sub, true);   // share reserved for subscriptions
  greedy(target - picked.length, () => true, true);
  greedy(target - picked.length, () => true, false);                           // pool too small for the cap: relax it

  const ordered = [], left = picked.sort((a, b) => b.score - a.score);
  while (left.length) {
    let i = left.findIndex(x => x.v.channelId !== ordered[ordered.length - 1]?.v.channelId);
    if (i < 0) i = 0;
    ordered.push(left.splice(i, 1)[0]);
  }
  const out = [], every = Math.max(2, Math.round(1 / Math.max(s.explorationRatio, 0.01)));
  let ei = 0;
  const push = (x, reason) => out.push({ ...x.v, reason, score: x.score, category: x.cat, sub: x.sub });
  ordered.forEach((x, i) => { push(x, 'match'); if ((i + 1) % every === 0 && ei < explore.length) push(explore[ei++], 'explore'); });
  while (ei < explore.length) push(explore[ei++], 'explore');
  return out;
}
module.exports = { buildFeed };
