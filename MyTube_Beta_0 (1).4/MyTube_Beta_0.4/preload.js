const { contextBridge, ipcRenderer } = require('electron');
const inv = c => (...a) => ipcRenderer.invoke(c, ...a);
const on = c => cb => ipcRenderer.on(c, (_, p) => cb(p));
contextBridge.exposeInMainWorld('api', {
  getFeed: inv('feed:get'), refresh: inv('feed:refresh'),
  instances: inv('instances:get'), checkInstances: inv('instances:check'), refreshInstanceList: inv('instances:list'),
  openVideo: inv('video:open'), winCtl: inv('win:ctl'), ytdlpInstall: inv('ytdlp:install'), healthHint: inv('health:hint'),
  logGet: inv('log:get'), logClear: inv('log:clear'), logUi: inv('log:ui'), logOpen: inv('log:open'), logSave: inv('log:save'),
  diagCopy: inv('diag:copy'), selfTest: inv('diag:selftest'),
  dataImport: inv('data:import'), dataExport: inv('data:export'), resolveMeta: inv('meta:resolve'),
  chanPlaylists: inv('chan:playlists'), ytplGet: inv('ytpl:get'), subsPin: inv('subs:pin'), plAddMany: inv('pl:addmany'), rate: inv('rate:set'),
  plCreate: inv('pl:create'), plRename: inv('pl:rename'), plDelete: inv('pl:delete'), plAdd: inv('pl:add'), plRemove: inv('pl:remove'), plMove: inv('pl:move'), record: inv('watch:record'),
  search: inv('search:run'), channel: inv('channel:get'),
  subsAdd: inv('subs:add'), subsRemove: inv('subs:remove'), subsImport: inv('subs:import'), subsFeed: inv('subs:feed'), subsRefresh: inv('subs:refresh'),
  profile: inv('profile:get'), setSettings: inv('settings:set'), resetSettings: inv('settings:reset'),
  setOverrides: inv('overrides:set'), muteChannel: inv('channel:mute'), setSeeds: inv('seeds:set'),
  exportProfile: inv('profile:export'), importProfile: inv('profile:import'), resetLearned: inv('profile:reset-learned'),
  openDataDir: inv('data:open'), ytdlpTest: inv('ytdlp:test'), openExternal: inv('external:open'),
  onUpdated: on('feed-updated'), onStatus: on('status'), onInstances: on('instances'),
});
