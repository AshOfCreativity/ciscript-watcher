const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  watchFolder: '~/Videos',
  serverUrl: 'http://localhost:3000',
  extensions: ['.mp4', '.mkv', '.webm', '.flv', '.mov', '.avi'],
  deleteWavAfterUpload: true,
  pollingInterval: 5000,
  stabilizationDelay: 3000,
  maxConcurrent: 1,
  maxRetries: 5,
  minDiskSpaceGB: 2,
  processExisting: false,
  requireApproval: false,
  outputDir: null,
  archiveDir: null,
  dbPath: null
};

function expandHome(p) {
  if (p && p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function loadConfig(configPath, cliOverrides = {}) {
  let fileConfig = {};

  if (configPath) {
    const resolved = expandHome(configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    const raw = fs.readFileSync(resolved, 'utf-8');
    fileConfig = JSON.parse(raw);
  } else {
    // Try default location
    const defaultPath = path.join(__dirname, '..', 'watcher-config.json');
    if (fs.existsSync(defaultPath)) {
      const raw = fs.readFileSync(defaultPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    }
  }

  // Merge: defaults → file → CLI overrides
  const config = { ...DEFAULTS, ...fileConfig, ...cliOverrides };

  // Expand ~ in paths
  config.watchFolder = expandHome(config.watchFolder);
  config.serverUrl = config.serverUrl.replace(/\/+$/, '');

  // Resolve dbPath
  if (!config.dbPath) {
    config.dbPath = path.join(__dirname, '..', 'data', 'watcher.db');
  } else {
    config.dbPath = expandHome(config.dbPath);
  }

  // Ensure data directory exists
  const dataDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Expand and create outputDir / archiveDir
  if (config.outputDir) {
    config.outputDir = expandHome(config.outputDir);
    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }
  }
  if (config.archiveDir) {
    config.archiveDir = expandHome(config.archiveDir);
    if (!fs.existsSync(config.archiveDir)) {
      fs.mkdirSync(config.archiveDir, { recursive: true });
    }
  }

  // Validate watchFolder
  if (!fs.existsSync(config.watchFolder)) {
    fs.mkdirSync(config.watchFolder, { recursive: true });
    console.log(`[INFO]  Created watch folder: ${config.watchFolder}`);
  }

  const stat = fs.statSync(config.watchFolder);
  if (!stat.isDirectory()) {
    throw new Error(`watchFolder is not a directory: ${config.watchFolder}`);
  }

  // Validate serverUrl
  try {
    new URL(config.serverUrl);
  } catch {
    throw new Error(`Invalid serverUrl: ${config.serverUrl}`);
  }

  // Normalize extensions to lowercase with leading dot
  config.extensions = config.extensions.map(ext =>
    ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  );

  return config;
}

function saveConfig(configPath, configData) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
