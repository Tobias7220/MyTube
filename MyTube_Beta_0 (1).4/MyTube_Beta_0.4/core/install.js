// One-click yt-dlp install: official GitHub release, SHA-256 verified against the release's SHA2-256SUMS file.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

function assetName(platform, arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}
function parseSums(text, name) {
  for (const l of text.split(/\r?\n/)) { const m = l.trim().match(/^([a-f0-9]{64})\s+\*?(\S+)$/i); if (m && m[2] === name) return m[1].toLowerCase(); }
  return null;
}
async function installYtdlp({ dir, fetchImpl = fetch, platform = process.platform, arch = process.arch, onProgress = () => {} }) {
  const name = assetName(platform, arch);
  const get = async u => { const r = await fetchImpl(u, { redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`); return r; };
  onProgress('Fetching checksums…');
  const want = parseSums(await (await get(BASE + 'SHA2-256SUMS')).text(), name);
  if (!want) throw new Error('no checksum listed for ' + name);
  onProgress('Downloading ' + name + '…');
  const buf = Buffer.from(await (await get(BASE + name)).arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('checksum mismatch, nothing was installed');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'), tmp = out + '.part';
  fs.writeFileSync(tmp, buf, { mode: 0o755 }); fs.renameSync(tmp, out);
  return out;
}
module.exports = { assetName, parseSums, installYtdlp, BASE };
