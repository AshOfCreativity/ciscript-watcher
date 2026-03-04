const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('watcherAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getGlobalConfig: () => ipcRenderer.invoke('get-global-config'),
  saveGlobalConfig: (data) => ipcRenderer.invoke('save-global-config', data),

  // Workflows
  getWorkflows: () => ipcRenderer.invoke('get-workflows'),
  addWorkflow: (workflow) => ipcRenderer.invoke('add-workflow', workflow),
  updateWorkflow: (name, updates) => ipcRenderer.invoke('update-workflow', name, updates),
  removeWorkflow: (name) => ipcRenderer.invoke('remove-workflow', name),
  startWorkflow: (name) => ipcRenderer.invoke('start-workflow', name),
  stopWorkflow: (name) => ipcRenderer.invoke('stop-workflow', name),
  startAll: () => ipcRenderer.invoke('start-all'),
  stopAll: () => ipcRenderer.invoke('stop-all'),

  // File browsing
  browseFolder: () => ipcRenderer.invoke('browse-folder'),

  // Queue / file queries
  getQueue: () => ipcRenderer.invoke('get-queue'),
  getVideoFiles: (workflowName) => ipcRenderer.invoke('get-video-files', workflowName),
  getAudioFiles: (workflowName) => ipcRenderer.invoke('get-audio-files', workflowName),

  // Approval actions
  approveFiles: (filePaths) => ipcRenderer.invoke('approve-files', filePaths),
  approveUploadFiles: (filePaths) => ipcRenderer.invoke('approve-upload-files', filePaths),
  rejectFiles: (filePaths) => ipcRenderer.invoke('reject-files', filePaths),
  requeueFiles: (filePaths) => ipcRenderer.invoke('requeue-files', filePaths),
  approveAllVideos: (workflowName) => ipcRenderer.invoke('approve-all-videos', workflowName),
  approveAllUploads: (workflowName) => ipcRenderer.invoke('approve-all-uploads', workflowName),

  // Push events
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_event, rows) => callback(rows)),
  removeQueueListener: () => ipcRenderer.removeAllListeners('queue:updated')
});
