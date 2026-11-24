const test = require('node:test'), assert = require('node:assert'), { spawnSync } = require('node:child_process'), path = require('node:path');
test('main process smoke test (fake Electron, offline): IPC handlers, import/export, log, diagnostics, self-test', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'smoke-child.js')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || '')); assert.match(r.stdout, /SMOKE OK/);
});
