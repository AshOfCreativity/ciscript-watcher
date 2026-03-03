const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig } = require('../lib/config');
const { startWatcher } = require('../lib/watcher');
const { setupNotifications } = require('./notifications');
const db = require('../lib/db');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let tray = null;
let mainWindow = null;
let watcher = null;
let currentConfig = null;

// Keys that require a full watcher restart when changed
const RESTART_KEYS = ['watchFolder', 'extensions', 'processExisting', 'serverUrl'];

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadAppConfig() {
  const configPath = getConfigPath();
  try {
    return loadConfig(configPath);
  } catch {
    // Fall back to defaults
    return loadConfig(null);
  }
}

function startWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  try {
    currentConfig = loadAppConfig();
    console.log('[Watcher] Config loaded:', JSON.stringify({
      watchFolder: currentConfig.watchFolder,
      extensions: currentConfig.extensions,
      processExisting: currentConfig.processExisting,
      dbPath: currentConfig.dbPath
    }));

    watcher = startWatcher(currentConfig);

    // Hook up notifications
    setupNotifications(watcher.queue, currentConfig.serverUrl, currentConfig);

    // Push queue updates to renderer
    watcher.queue.on('queue:updated', () => {
      sendQueueSnapshot();
    });

    updateTrayMenu('watching');
    console.log('[Watcher] Started watching:', currentConfig.watchFolder);
  } catch (err) {
    console.error('[Watcher] Failed to start:', err);
    updateTrayMenu('stopped');
  }
}

function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  updateTrayMenu('stopped');
}

function sendQueueSnapshot() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const rows = db.getQueueSnapshot();
      mainWindow.webContents.send('queue:updated', rows);
    } catch {}
  }
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
      label: isWatching ? 'Stop Watching' : 'Start Watching',
      click: () => {
        if (isWatching) stopWatching();
        else startWatching();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        stopWatching();
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
    width: 640,
    height: 680,
    minWidth: 500,
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

// IPC handlers
ipcMain.handle('get-config', () => {
  return currentConfig || loadAppConfig();
});

ipcMain.handle('save-config', async (_event, configData) => {
  const configPath = getConfigPath();
  const oldConfig = currentConfig || loadAppConfig();
  saveConfig(configPath, configData);

  // Determine if we need a full restart or just a hot-update
  const needsRestart = RESTART_KEYS.some(key => {
    const oldVal = JSON.stringify(oldConfig[key]);
    const newVal = JSON.stringify(configData[key]);
    return oldVal !== newVal;
  });

  if (needsRestart) {
    startWatching();
    return { restarted: true };
  } else {
    // Hot-update: reload config and patch the queue's config in place
    currentConfig = loadAppConfig();
    if (watcher && watcher.queue) {
      watcher.queue.config = currentConfig;
    }
    return { restarted: false };
  }
});

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

ipcMain.handle('get-queue', () => {
  try {
    return db.getQueueSnapshot();
  } catch {
    return [];
  }
});

ipcMain.handle('approve-file', (_event, filePath) => {
  if (watcher && watcher.queue) {
    watcher.queue.approve(filePath);
  }
});

ipcMain.handle('reject-file', (_event, filePath) => {
  if (watcher && watcher.queue) {
    watcher.queue.reject(filePath);
  }
});

ipcMain.handle('approve-all', () => {
  if (watcher && watcher.queue) {
    watcher.queue.approveAll();
  }
});

app.on('ready', () => {
  // Create tray icon
  let trayIcon;
  const activeIconPath = path.join(__dirname, 'icons', 'tray-active.png');
  if (fs.existsSync(activeIconPath)) {
    trayIcon = nativeImage.createFromPath(activeIconPath);
  } else {
    // Create a simple 16x16 placeholder icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Audio Watcher');

  // Start watching on launch
  startWatching();

  // Open main window on launch so user sees the queue
  openMainWindow();

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify();
});

// Prevent app from closing when all windows close (tray app)
app.on('window-all-closed', (e) => {
  // Do nothing — stay in tray
});

app.on('second-instance', () => {
  openMainWindow();
});
