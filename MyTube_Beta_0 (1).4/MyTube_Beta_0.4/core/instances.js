// Finds, health-checks and fails over between public Piped API instances.
const LIST_URL = 'https://raw.githubusercontent.com/TeamPiped/Documentation/main/content/docs/public-instances/index.md';
const FALLBACK_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.darkness.services',
];
const HEALTH_PATH = '/streams/dQw4w9WgXcQ';

// Pulls API hosts out of Piped's markdown list (frontend hosts have no "api" in them).
function parseInstanceList(md) {
  const found = (md.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).map(u => u.toLowerCase());
  return [...new Set(found.filter(u => /api/.test(u.slice(8))))];
}

async function fetchWithTimeout(f, url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await f(url, { signal: ctl.signal, headers: { 'user-agent': 'MyTube/0.1' } }); }
  finally { clearTimeout(t); }
}
async function fetchJson(f, url, ms) {
  const r = await fetchWithTimeout(f, url, ms);
  if (!r.ok) {
    let msg = '';
    try { const b = await r.json(); msg = b.message || b.error || ''; } catch {}
    throw new Error('HTTP ' + r.status + (msg ? ': ' + String(msg).slice(0, 120) : ''));
  }
  return r.json();
}

const hostOf = u => { try { return new URL(u).host; } catch { return u; } };
const epOf = p => p.replace(/\?.*$/, '?…'); // never log query values (search terms, tokens)

class InstancePool {
  constructor({ fetchImpl = fetch, instances = [], onChange = () => {} } = {}) {
    this.f = fetchImpl; this.onChange = onChange; this.map = new Map(); this.log = () => {};
    const start = instances.length ? instances : FALLBACK_INSTANCES;
    for (const i of start) typeof i === 'string' ? this.add(i) : this.add(i.url, i);
  }
  add(url, extra = {}) {
    if (!this.map.has(url)) this.map.set(url, { ok: null, latency: null, fails: 0, checkedAt: null, error: null, ...extra, url });
  }
  snapshot() { return [...this.map.values()].map(i => ({ ...i })); }
  ranked() {
    const live = [...this.map.values()].filter(i => i.ok !== false)
      .sort((a, b) => (a.latency ?? 9e9) - (b.latency ?? 9e9));
    return live.length ? live : [...this.map.values()]; // all marked dead? try anyway
  }
  async _get(inst, path, ms) {
    const t = Date.now();
    try { const d = await fetchJson(this.f, inst.url + path, ms); this.log('debug', 'net', `GET ${hostOf(inst.url)}${epOf(path)} ok ${Date.now() - t}ms`); return d; }
    catch (e) { this.log('warn', 'net', `GET ${hostOf(inst.url)}${epOf(path)} failed ${Date.now() - t}ms: ${e.message}`); throw e; }
  }
  async refreshList() {
    const r = await fetchWithTimeout(this.f, LIST_URL, 10000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let n = 0;
    for (const u of parseInstanceList(await r.text())) if (!this.map.has(u)) { this.add(u); n++; }
    this.onChange();
    return n;
  }
  async check(inst) {
    const t = Date.now();
    try {
      const d = await this._get(inst, HEALTH_PATH, 8000);
      if (!d || !d.title) throw new Error('unexpected response');
      Object.assign(inst, { ok: true, latency: Date.now() - t, fails: 0, error: null });
    } catch (e) {
      Object.assign(inst, { ok: false, latency: null, fails: inst.fails + 1, error: String(e.message || e) });
    }
    inst.checkedAt = Date.now();
  }
  // Instances that keep failing are re-checked less and less often (5 min x 2^(fails-2), max 6 h) unless forced.
  async checkAll({ force = false } = {}) {
    const now = Date.now();
    const due = [...this.map.values()].filter(i => force || i.fails < 3 || !i.checkedAt || now - i.checkedAt >= Math.min(5 * 60e3 * 2 ** (i.fails - 2), 6 * 3600e3));
    await Promise.all(due.map(i => this.check(i)));
    this.onChange();
  }
  // Tries the 3 best instances in order; demotes the ones that fail.
  async request(path) {
    let last;
    for (const inst of this.ranked().slice(0, 3)) {
      try { return await this._get(inst, path, 12000); }
      catch (e) {
        last = e; inst.fails++; inst.error = String(e.message || e);
        if (inst.fails >= 2) inst.ok = false;
        this.onChange();
      }
    }
    throw last || new Error('No instances available');
  }
  // For /streams: a 500 usually means YouTube blocked THAT instance for this request, not that it is dead
  // (the health check video is cached). So try instances in parallel batches and only track stream failures.
  async requestAny(path, { batch = 3, max = 6 } = {}) {
    const list = this.ranked().sort((a, b) => (a.streamFails || 0) - (b.streamFails || 0) || (a.latency ?? 9e9) - (b.latency ?? 9e9)).slice(0, max);
    const errors = [];
    for (let i = 0; i < list.length; i += batch) {
      const group = list.slice(i, i + batch);
      try {
        const r = await Promise.any(group.map(inst => this._get(inst, path, 10000).then(d => ({ d, inst }))));
        r.inst.streamFails = 0;
        return r.d;
      } catch (e) {
        for (const inst of group) inst.streamFails = (inst.streamFails || 0) + 1;
        errors.push(...(e.errors || [e]).map(x => x.message));
      }
    }
    throw new Error(errors.length ? `All instances failed (${[...new Set(errors)].slice(0, 2).join(' / ')})` : 'No instances available');
  }
}
module.exports = { InstancePool, parseInstanceList, FALLBACK_INSTANCES };
