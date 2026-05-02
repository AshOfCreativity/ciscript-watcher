const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, WORKFLOW_DEFAULTS } = require('../lib/config');
const { startWatcher, startWorkflowWatcher } = require('../lib/watcher');
const { setupNotifications } = require('./notifications');
const db = require('../lib/db');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let tray = null;
let mainWindow = null;
let watcherSystem = null;      // { instances: {name: handle}, close(), db }
let currentConfig = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadAppConfig() {
  const configPath = getConfigPath();
  try {
    return loadConfig(configPath);
  } catch {
    return loadConfig(null);
  }
}

function broadcastQueueUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const rows = db.getQueueSnapshot();
      mainWindow.webContents.send('queue:updated', rows);
    } catch {}
  }
}

/**
 * Start all workflows. Does not auto-start on launch —
 * user sees UI first and starts manually.
 */
function startAllWatchers() {
  stopAllWatchers();

  try {
    currentConfig = loadAppConfig();
    console.log('[Watcher] Config loaded with', currentConfig.workflows.length, 'workflow(s)');

    watcherSystem = startWatcher(currentConfig);

    // Hook up notifications and queue:updated push for each workflow instance
    for (const [name, inst] of Object.entries(watcherSystem.instances)) {
      setupNotifications(inst.queue, inst.workflow.serverUrl, inst.workflow);
      inst.queue.on('queue:updated', () => broadcastQueueUpdate());
    }

    updateTrayMenu('watching');
  } catch (err) {
    console.error('[Watcher] Failed to start:', err);
    updateTrayMenu('stopped');
  }
}

function stopAllWatchers() {
  if (watcherSystem) {
    watcherSystem.close();
    watcherSystem = null;
  }
  updateTrayMenu('stopped');
}

function startSingleWorkflow(workflowName) {
  if (!currentConfig) currentConfig = loadAppConfig();
  const wf = currentConfig.workflows.find(w => w.name === workflowName);
  if (!wf) return;

  // Initialize DB if not already
  db.initDb(currentConfig.global.dbPath);

  if (!watcherSystem) {
    watcherSystem = { instances: {}, close: async () => {
      for (const inst of Object.values(watcherSystem.instances)) {
        await inst.close();
      }
    }, db };
  }

  // Stop existing instance for this workflow if running
  if (watcherSystem.instances[workflowName]) {
    watcherSystem.instances[workflowName].close();
  }

  const inst = startWorkflowWatcher(wf, currentConfig.global);
  setupNotifications(inst.queue, wf.serverUrl, wf);
  inst.queue.on('queue:updated', () => broadcastQueueUpdate());
  watcherSystem.instances[workflowName] = inst;

  updateTrayMenu('watching');
}

function stopSingleWorkflow(workflowName) {
  if (!watcherSystem || !watcherSystem.instances[workflowName]) return;
  watcherSystem.instances[workflowName].close();
  delete watcherSystem.instances[workflowName];

  if (Object.keys(watcherSystem.instances).length === 0) {
    updateTrayMenu('stopped');
  }
}

function getQueueForWorkflow(workflowName) {
  if (!workflowName) return [];
  const inst = watcherSystem && watcherSystem.instances[workflowName];
  if (!inst) return [];
  return inst.queue;
}

function updateTrayMenu(state) {
  if (!tray) return;

  const isWatching = state === 'watching';
  const iconPath = isWatching
    ? path.join(__dirname, 'icons', 'tray-active.png')
    : path.join(__dirname, 'icons', 'tray-idle.png');

  if (fs.existsSync(iconPath)) {
    tray.setImage(iconPath);
  }

  tray.setToolTip(isWatching ? 'Audio Watcher — Active' : 'Audio Watcher — Stopped');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open',
      click: () => openMainWindow()
    },
    { type: 'separator' },
    {
      label: isWatching ? 'Stop All' : 'Start All',
      click: () => {
        if (isWatching) stopAllWatchers();
        else startAllWatchers();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        stopAllWatchers();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function openMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    resizable: true,
    title: 'Audio Watcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'app.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC Handlers ───

// Config / workflows
ipcMain.handle('get-config', () => {
  return currentConfig || loadAppConfig();
});

ipcMain.handle('save-config', async (_event, configData) => {
  const configPath = getConfigPath();
  saveConfig(configPath, configData);
  // Full restart to apply new workflows
  startAllWatchers();
  return { restarted: true };
});

ipcMain.handle('get-workflows', () => {
  const config = currentConfig || loadAppConfig();
  return config.workflows.map(w => ({
    name: w.name,
    watchFolder: w.watchFolder,
    serverUrl: w.serverUrl,
    running: !!(watcherSystem && watcherSystem.instances[w.name])
  }));
});

ipcMain.handle('add-workflow', (_event, workflow) => {
  try {
    const config = currentConfig || loadAppConfig();
    const merged = { ...WORKFLOW_DEFAULTS, ...workflow };
    config.workflows.push(merged);
    saveConfig(getConfigPath(), config);
    currentConfig = loadAppConfig();
    return { workflows: currentConfig.workflows };
  } catch (err) {
    console.error('[Watcher] Failed to add workflow:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('update-workflow', (_event, workflowName, updates) => {
  const config = currentConfig || loadAppConfig();
  const idx = config.workflows.findIndex(w => w.name === workflowName);
  if (idx === -1) return { error: 'Workflow not found' };
  config.workflows[idx] = { ...config.workflows[idx], ...updates };
  saveConfig(getConfigPath(), config);

  // Restart that specific workflow if it was running
  const wasRunning = watcherSystem && watcherSystem.instances[workflowName];
  if (wasRunning) {
    stopSingleWorkflow(workflowName);
  }
  currentConfig = loadAppConfig();
  if (wasRunning) {
    const newName = config.workflows[idx].name;
    startSingleWorkflow(newName);
  }
  return currentConfig.workflows;
});

ipcMain.handle('remove-workflow', (_event, workflowName) => {
  const config = currentConfig || loadAppConfig();
  config.workflows = config.workflows.filter(w => w.name !== workflowName);
  saveConfig(getConfigPath(), config);
  stopSingleWorkflow(workflowName);
  currentConfig = loadAppConfig();
  return currentConfig.workflows;
});

ipcMain.handle('start-workflow', (_event, workflowName) => {
  startSingleWorkflow(workflowName);
});

ipcMain.handle('stop-workflow', (_event, workflowName) => {
  stopSingleWorkflow(workflowName);
});

ipcMain.handle('start-all', () => {
  startAllWatchers();
});

ipcMain.handle('stop-all', () => {
  stopAllWatchers();
});

// File browsing
ipcMain.handle('browse-folder', async () => {
  const parentWindow = mainWindow || null;
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Queue / file operations
ipcMain.handle('get-queue', () => {
  try {
    return db.getQueueSnapshot();
  } catch {
    return [];
  }
});

ipcMain.handle('get-video-files', (_event, workflowName) => {
  try {
    return db.getVideoFiles(workflowName || null);
  } catch {
    return [];
  }
});

ipcMain.handle('get-audio-files', (_event, workflowName) => {
  try {
    return db.getAudioFiles(workflowName || null);
  } catch {
    return [];
  }
});

// Approval actions
ipcMain.handle('approve-files', (_event, filePaths) => {
  if (!watcherSystem) return;
  // Group by workflow and approve via the correct queue
  for (const fp of filePaths) {
    const row = db.getByPath(fp);
    if (!row) continue;
    const inst = watcherSystem.instances[row.workflow_name];
    if (inst) inst.queue.approve(fp);
  }
});

ipcMain.handle('approve-upload-files', (_event, filePaths) => {
  if (!watcherSystem) return;
  for (const fp of filePaths) {
    const row = db.getByPath(fp);
    if (!row) continue;
    const inst = watcherSystem.instances[row.workflow_name];
    if (inst) inst.queue.approveUpload(fp);
  }
});

ipcMain.handle('reject-files', (_event, filePaths) => {
  if (!watcherSystem) return;
  for (const fp of filePaths) {
    const row = db.getByPath(fp);
    if (!row) continue;
    const inst = watcherSystem.instances[row.workflow_name];
    if (inst) inst.queue.reject(fp);
  }
});

ipcMain.handle('requeue-files', (_event, filePaths) => {
  if (!watcherSystem) return;
  for (const fp of filePaths) {
    const row = db.getByPath(fp);
    if (!row) continue;
    const inst = watcherSystem.instances[row.workflow_name];
    if (inst) inst.queue.requeue(fp);
  }
});

ipcMain.handle('approve-all-videos', (_event, workflowName) => {
  if (!watcherSystem) return;
  const inst = watcherSystem.instances[workflowName];
  if (inst) inst.queue.approveAll();
});

ipcMain.handle('approve-all-uploads', (_event, workflowName) => {
  if (!watcherSystem) return;
  const inst = watcherSystem.instances[workflowName];
  if (inst) inst.queue.approveAllUploads();
});

ipcMain.handle('get-global-config', () => {
  const config = currentConfig || loadAppConfig();
  return config.global;
});

ipcMain.handle('save-global-config', (_event, globalData) => {
  const config = currentConfig || loadAppConfig();
  config.global = { ...config.global, ...globalData };
  saveConfig(getConfigPath(), config);
  currentConfig = loadAppConfig();
  return config.global;
});

app.on('ready', () => {
  // Create tray icon
  let trayIcon;
  const idleIconPath = path.join(__dirname, 'icons', 'tray-idle.png');
  if (fs.existsSync(idleIconPath)) {
    trayIcon = nativeImage.createFromPath(idleIconPath);
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Audio Watcher');

  // Load config but don't auto-start — user starts workflows manually
  currentConfig = loadAppConfig();
  // Initialize DB so queries work even before watchers start
  db.initDb(currentConfig.global.dbPath);

  updateTrayMenu('stopped');
  openMainWindow();

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify();
});

app.on('window-all-closed', (e) => {
  // Stay in tray
});

app.on('second-instance', () => {
  openMainWindow();
});
