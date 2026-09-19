'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // Settings & Engine
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  startEngine: (model) => ipcRenderer.invoke('engine:start', model),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  polish: (text, config) => ipcRenderer.invoke('agent:polish', { text, config }),
  saveTranscript: (suggestedName, contents) =>
    ipcRenderer.invoke('file:saveTranscript', { suggestedName, contents }),
  openModelsFolder: () => ipcRenderer.invoke('shell:openModels'),
  onEngineLog: (fn) => ipcRenderer.on('engine:log', (_e, line) => fn(line)),
  onEngineExit: (fn) => ipcRenderer.on('engine:exit', (_e, info) => fn(info)),

  // Storage & Recordings Management
  recordings: {
    create: (data) => ipcRenderer.invoke('recordings:create', data),
    appendAudioChunk: (id, buffer) => ipcRenderer.invoke('recordings:appendAudioChunk', { id, buffer }),
    appendSegment: (id, segment) => ipcRenderer.invoke('recordings:appendSegment', { id, segment }),
    saveNotes: (id, notes) => ipcRenderer.invoke('recordings:saveNotes', { id, notes }),
    addNote: (id, note) => ipcRenderer.invoke('recordings:addNote', { id, note }),
    updateMetadata: (id, patch) => ipcRenderer.invoke('recordings:updateMetadata', { id, patch }),
    finalize: (id, patch) => ipcRenderer.invoke('recordings:finalize', { id, patch }),
    get: (id) => ipcRenderer.invoke('recordings:get', { id }),
    list: () => ipcRenderer.invoke('recordings:list'),
    delete: (id) => ipcRenderer.invoke('recordings:delete', { id }),
    rename: (id, title) => ipcRenderer.invoke('recordings:rename', { id, title }),
    search: (query) => ipcRenderer.invoke('recordings:search', { query }),
    recoverIncomplete: () => ipcRenderer.invoke('recordings:recoverIncomplete'),
    openFolder: (id) => ipcRenderer.invoke('recordings:openFolder', { id }),
  },

  // Storage Roots
  storage: {
    getRoot: () => ipcRenderer.invoke('storage:getRoot'),
    openRoot: () => ipcRenderer.invoke('storage:openRoot'),
  },

  // Google Drive Cloud Backup (Optional)
  google: {
    getStatus: () => ipcRenderer.invoke('google:getStatus'),
    connect: () => ipcRenderer.invoke('google:connect'),
    disconnect: () => ipcRenderer.invoke('google:disconnect'),
    backup: (id) => ipcRenderer.invoke('google:backup', { id }),
    openFolder: (folderId) => ipcRenderer.invoke('google:openFolder', { folderId }),
  },
});
