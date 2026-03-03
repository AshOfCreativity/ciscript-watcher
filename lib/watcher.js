const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const db = require('./db');
const { UploadQueue } = require('./queue');

function timestamp() {
  return new Date().toISOString();
}

function startWatcher(config) {
  // Initialize database
  db.initDb(config.dbPath);

  // Create upload queue
  const queue = new UploadQueue(config);

  // Wire queue events to console logging
  queue.on('file:detected', (filePath) => {
    console.log(`[INFO]  ${timestamp()} Detected: ${path.basename(filePath)}`);
  });
  queue.on('file:extracting', (filePath) => {
    console.log(`[INFO]  ${timestamp()} Extracting audio: ${path.basename(filePath)}`);
  });
  queue.on('file:uploading', (filePath) => {
    console.log(`[INFO]  ${timestamp()} Uploading: ${path.basename(filePath)}`);
  });
  queue.on('file:completed', (filePath, info) => {
    console.log(`[INFO]  ${timestamp()} Completed: ${path.basename(filePath)} — ${info.segments} segments, ${info.speakers} speakers`);
  });
  queue.on('file:failed', (filePath, err) => {
    console.log(`[ERROR] ${timestamp()} Failed: ${path.basename(filePath)}: ${err.message}`);
  });
  queue.on('file:retrying', (filePath, err) => {
    const msg = err ? err.message : 'resuming interrupted job';
    console.log(`[WARN]  ${timestamp()} Retrying: ${path.basename(filePath)}: ${msg}`);
  });
  queue.on('file:archived', (filePath, destPath) => {
    console.log(`[INFO]  ${timestamp()} Archived: ${path.basename(filePath)} → ${destPath}`);
  });
  queue.on('file:archive-failed', (filePath, err) => {
    console.log(`[WARN]  ${timestamp()} Archive failed: ${path.basename(filePath)}: ${err.message}`);
  });

  // Resume interrupted jobs from DB
  queue.resume();

  // Start filesystem watcher
  const watcher = chokidar.watch(config.watchFolder, {
    ignoreInitial: !config.processExisting,
    persistent: true,
    awaitWriteFinish: false
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!config.extensions.includes(ext)) return;

    // Check DB for already-completed files with same mtime
    const existing = db.getByPath(filePath);
    if (existing && existing.status === 'completed') {
      try {
        const stat = fs.statSync(filePath);
        if (existing.file_mtime === stat.mtime.toISOString()) {
          return; // Already processed, same file
        }
      } catch {
        return;
      }
    }

    queue.enqueue(filePath);
  });

  watcher.on('error', (err) => {
    console.log(`[ERROR] ${timestamp()} Watcher error: ${err.message}`);
  });

  return {
    close: async () => {
      await watcher.close();
      await queue.shutdown();
      db.closeDb();
    },
    queue,
    db
  };
}

module.exports = { startWatcher };
