const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('watcherAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  getQueue: () => ipcRenderer.invoke('get-queue'),
  approveFile: (filePath) => ipcRenderer.invoke('approve-file', filePath),
  rejectFile: (filePath) => ipcRenderer.invoke('reject-file', filePath),
  approveAll: () => ipcRenderer.invoke('approve-all'),
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_event, rows) => callback(rows)),
  removeQueueListener: () => ipcRenderer.removeAllListeners('queue:updated')
});
