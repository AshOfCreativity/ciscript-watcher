const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKFLOW_DEFAULTS = {
  name: 'Default',
  watchFolder: '~/Videos',
  serverUrl: 'http://localhost:3000',
  extensions: ['.mp4', '.mkv', '.webm', '.flv', '.mov', '.avi'],
  approvalMode: 'one-stage', // 'one-stage' | 'two-stage'
  deleteWavAfterUpload: true,
  outputDir: null,
  archiveDir: null
};

const GLOBAL_DEFAULTS = {
  pollingInterval: 5000,
  stabilizationDelay: 3000,
  maxConcurrent: 1,
  maxRetries: 5,
  minDiskSpaceGB: 2,
  dbPath: null
};

function expandHome(p) {
  if (p && p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Migrate old single-config format to new multi-workflow format.
 * Old format: flat object with watchFolder, serverUrl, etc.
 * New format: { workflows: [...], global: {...} }
 */
function migrateConfig(raw) {
  // Already new format
  if (raw.workflows && Array.isArray(raw.workflows)) {
    return raw;
  }

  // Old format: extract workflow-level and global-level keys
  const workflow = { ...WORKFLOW_DEFAULTS };
  const global = { ...GLOBAL_DEFAULTS };

  for (const key of Object.keys(WORKFLOW_DEFAULTS)) {
    if (raw[key] !== undefined) workflow[key] = raw[key];
  }
  for (const key of Object.keys(GLOBAL_DEFAULTS)) {
    if (raw[key] !== undefined) global[key] = raw[key];
  }

  // Map old requireApproval / processExisting to new approvalMode
  // In the new model, approval is always required (approval-first).
  // requireApproval=true with old config → one-stage (approve once)
  // Default → one-stage
  if (raw.requireApproval) {
    workflow.approvalMode = 'one-stage';
  }

  // processExisting is now always true (scan on startup)
  // so we don't carry it forward as a setting

  return { workflows: [workflow], global };
}

function resolveDbPath(globalConfig) {
  if (globalConfig.dbPath) {
    return expandHome(globalConfig.dbPath);
  }
  let dataRoot;
  try {
    const { app } = require('electron');
    dataRoot = app.getPath('userData');
  } catch {
    dataRoot = path.join(__dirname, '..', 'data');
  }
  return path.join(dataRoot, 'watcher.db');
}

function validateWorkflow(wf) {
  // Expand ~ in paths
  wf.watchFolder = expandHome(wf.watchFolder);
  wf.serverUrl = (wf.serverUrl || '').replace(/\/+$/, '');

  // Validate and create watchFolder
  if (!wf.watchFolder) {
    throw new Error(`Workflow "${wf.name}": watchFolder is required`);
  }
  if (!fs.existsSync(wf.watchFolder)) {
    fs.mkdirSync(wf.watchFolder, { recursive: true });
    console.log(`[INFO]  Created watch folder: ${wf.watchFolder}`);
  }
  const stat = fs.statSync(wf.watchFolder);
  if (!stat.isDirectory()) {
    throw new Error(`Workflow "${wf.name}": watchFolder is not a directory: ${wf.watchFolder}`);
  }

  // Validate serverUrl
  if (!wf.serverUrl) {
    throw new Error(`Workflow "${wf.name}": serverUrl is required`);
  }
  try {
    new URL(wf.serverUrl);
  } catch {
    throw new Error(`Workflow "${wf.name}": invalid serverUrl: ${wf.serverUrl}`);
  }

  // Normalize extensions
  wf.extensions = (wf.extensions || []).map(ext =>
    ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  );

  // Validate approvalMode
  if (!['one-stage', 'two-stage'].includes(wf.approvalMode)) {
    wf.approvalMode = 'one-stage';
  }

  // Expand and create outputDir / archiveDir
  if (wf.outputDir) {
    wf.outputDir = expandHome(wf.outputDir);
    if (!fs.existsSync(wf.outputDir)) {
      fs.mkdirSync(wf.outputDir, { recursive: true });
    }
  }
  if (wf.archiveDir) {
    wf.archiveDir = expandHome(wf.archiveDir);
    if (!fs.existsSync(wf.archiveDir)) {
      fs.mkdirSync(wf.archiveDir, { recursive: true });
    }
  }

  return wf;
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
    let defaultPath;
    try {
      const { app } = require('electron');
      defaultPath = path.join(app.getPath('userData'), 'config.json');
    } catch {
      defaultPath = path.join(__dirname, '..', 'watcher-config.json');
    }
    if (fs.existsSync(defaultPath)) {
      const raw = fs.readFileSync(defaultPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    }
  }

  // Migrate old format if needed
  const config = migrateConfig({ ...fileConfig, ...cliOverrides });

  // Apply global defaults
  config.global = { ...GLOBAL_DEFAULTS, ...config.global };

  // Resolve dbPath
  config.global.dbPath = resolveDbPath(config.global);

  // Ensure data directory exists
  const dataDir = path.dirname(config.global.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Apply workflow defaults and validate each workflow
  config.workflows = config.workflows.map((wf, i) => {
    const merged = { ...WORKFLOW_DEFAULTS, ...wf };
    if (!merged.name) merged.name = `Workflow ${i + 1}`;
    return validateWorkflow(merged);
  });

  return config;
}

function saveConfig(configPath, configData) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');
}

module.exports = { loadConfig, saveConfig, WORKFLOW_DEFAULTS, GLOBAL_DEFAULTS, expandHome };
