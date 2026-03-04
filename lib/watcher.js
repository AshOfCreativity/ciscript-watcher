const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const db = require('./db');
const { UploadQueue } = require('./queue');

function timestamp() {
  return new Date().toISOString();
}

/**
 * Start a single workflow watcher instance.
 * Files are detected and placed in 'detected' status — no auto-processing.
 * Returns a handle with close(), queue, workflowName, and watching state.
 */
function startWorkflowWatcher(workflow, globalConfig) {
  const queue = new UploadQueue(workflow, globalConfig);

  // Wire queue events to console logging
  queue.on('file:detected', (filePath) => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Detected: ${path.basename(filePath)}`);
  });
  queue.on('file:extracting', (filePath) => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Extracting audio: ${path.basename(filePath)}`);
  });
  queue.on('file:uploading', (filePath) => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Uploading: ${path.basename(filePath)}`);
  });
  queue.on('file:completed', (filePath, info) => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Completed: ${path.basename(filePath)} — ${info.segments} segments, ${info.speakers} speakers`);
  });
  queue.on('file:failed', (filePath, err) => {
    console.log(`[ERROR] ${timestamp()} [${workflow.name}] Failed: ${path.basename(filePath)}: ${err.message}`);
  });
  queue.on('file:retrying', (filePath, err) => {
    const msg = err ? err.message : 'resuming interrupted job';
    console.log(`[WARN]  ${timestamp()} [${workflow.name}] Retrying: ${path.basename(filePath)}: ${msg}`);
  });
  queue.on('file:archived', (filePath, destPath) => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Archived: ${path.basename(filePath)} → ${destPath}`);
  });
  queue.on('file:archive-failed', (filePath, err) => {
    console.log(`[WARN]  ${timestamp()} [${workflow.name}] Archive failed: ${path.basename(filePath)}: ${err.message}`);
  });
  queue.on('file:awaiting-upload', (filePath) => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Awaiting upload approval: ${path.basename(filePath)}`);
  });

  // Resume interrupted jobs from DB for this workflow
  queue.resume();

  // Start filesystem watcher — always scan existing files (processExisting is always true now)
  const watcher = chokidar.watch(workflow.watchFolder, {
    ignoreInitial: false, // always scan existing
    persistent: true,
    awaitWriteFinish: false
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!workflow.extensions.includes(ext)) return;

    // Get file info
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const fileMtime = stat.mtime.toISOString();

    // Insert as detected — db.upsertDetected handles idempotency
    const row = db.upsertDetected(filePath, stat.size, fileMtime, workflow.name);

    // Only emit if newly detected (status was just set to 'detected')
    if (row && row.status === 'detected') {
      queue.emit('file:detected', filePath);
      queue.emit('queue:updated');
    }
  });

  watcher.on('ready', () => {
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Watcher ready — watching: ${workflow.watchFolder}`);
    console.log(`[INFO]  ${timestamp()} [${workflow.name}] Extensions: ${workflow.extensions.join(', ')}`);
  });

  watcher.on('error', (err) => {
    console.log(`[ERROR] ${timestamp()} [${workflow.name}] Watcher error: ${err.message}`);
  });

  return {
    workflowName: workflow.name,
    workflow,
    queue,
    close: async () => {
      await watcher.close();
      await queue.shutdown();
    }
  };
}

/**
 * Start the full watcher system with multiple workflows.
 * config = { workflows: [...], global: { dbPath, ... } }
 */
function startWatcher(config) {
  // Initialize database
  db.initDb(config.global.dbPath);

  const instances = {};

  for (const workflow of config.workflows) {
    instances[workflow.name] = startWorkflowWatcher(workflow, config.global);
  }

  return {
    instances,
    close: async () => {
      for (const inst of Object.values(instances)) {
        await inst.close();
      }
      db.closeDb();
    },
    db
  };
}

module.exports = { startWatcher, startWorkflowWatcher };
