// App log for debugging (NOT watch history). Ring buffer + rotating file. Video/channel IDs are masked unless fullIds is on.
const fs = require('fs');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Same ID -> same tag, so a channel can be followed through the log without revealing the ID.
const hash4 = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return (h & 0xffff).toString(16).padStart(4, '0'); };

class Logger {
  constructor(file, { max = 2 * 1024 * 1024, keep = 1500 } = {}) {
    this.file = file; this.max = max; this.keep = keep; this.ring = []; this.level = 'debug'; this.fullIds = false; this.size = 0;
    try { this.size = file ? fs.statSync(file).size : 0; } catch {}
  }
  setConfig({ level, fullIds } = {}) { if (LEVELS[level]) this.level = level; this.fullIds = !!fullIds; }
  mask(s) {
    s = String(s);
    return this.fullIds ? s : s.replace(/([?&]v=|\/(?:streams|playlists|playlist|channel)\/)([\w-]{6,})/g, (m, p, id) => p + id.slice(0, 3) + '…#' + hash4(id));
  }
  format(e) { return `${e.t} ${e.level.toUpperCase().padEnd(5)} ${e.src.padEnd(6)} ${e.msg}${e.data ? ' ' + e.data : ''}`; }
  log(level, src, msg, data) {
    if ((LEVELS[level] || 20) < LEVELS[this.level]) return null;
    const e = { t: new Date().toISOString(), level, src: String(src), msg: this.mask(msg),
      data: data === undefined ? '' : this.mask(typeof data === 'string' ? data : JSON.stringify(data)) };
    this.ring.push(e); if (this.ring.length > this.keep) this.ring.shift();
    if (this.file) {
      const line = this.format(e) + '\n';
      try { this._rotate(line.length); fs.appendFileSync(this.file, line); this.size += line.length; } catch {}
    }
    return e;
  }
  _rotate(add) {
    if (this.size + add <= this.max) return;
    try { fs.renameSync(this.file, this.file + '.1'); } catch {}
    this.size = 0;
  }
  entries({ level = 'debug', src = '', limit = 300 } = {}) {
    const min = LEVELS[level] || 10;
    return this.ring.filter(e => LEVELS[e.level] >= min && (!src || e.src === src)).slice(-limit);
  }
  text(opts) { return this.entries(opts).map(e => this.format(e)).join('\n'); }
  clear() { this.ring = []; this.size = 0; try { if (this.file) fs.writeFileSync(this.file, ''); } catch {} }
}
module.exports = { Logger, LEVELS };
