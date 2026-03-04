const path = require('path');
const fs = require('fs');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT UNIQUE NOT NULL,
  file_size INTEGER,
  file_mtime TEXT,
  status TEXT NOT NULL DEFAULT 'detected',
  workflow_name TEXT NOT NULL DEFAULT 'Default',
  job_id TEXT,
  wav_path TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status ON processed_files(status);
CREATE INDEX IF NOT EXISTS idx_file_path ON processed_files(file_path);
CREATE INDEX IF NOT EXISTS idx_workflow ON processed_files(workflow_name);
`;

function initDb(dbPath) {
  if (db) return db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const Database = require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Migration: add workflow_name column if it doesn't exist (existing DBs)
  const columns = db.prepare("PRAGMA table_info(processed_files)").all();
  const hasWorkflow = columns.some(c => c.name === 'workflow_name');
  if (!hasWorkflow) {
    db.exec("ALTER TABLE processed_files ADD COLUMN workflow_name TEXT DEFAULT 'Default'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_workflow ON processed_files(workflow_name)");
    // Backfill any NULL values from the ALTER
    db.exec("UPDATE processed_files SET workflow_name = 'Default' WHERE workflow_name IS NULL");
    console.log('[DB] Migrated: added workflow_name column');
  }

  // Migration: convert old status values to new ones
  const oldStatuses = db.prepare(
    "SELECT COUNT(*) as cnt FROM processed_files WHERE status = 'awaiting_approval'"
  ).get();
  if (oldStatuses.cnt > 0) {
    db.exec("UPDATE processed_files SET status = 'detected' WHERE status = 'awaiting_approval'");
    console.log(`[DB] Migrated: converted ${oldStatuses.cnt} awaiting_approval rows to detected`);
  }

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function isProcessed(filePath) {
  const row = db.prepare('SELECT status FROM processed_files WHERE file_path = ?').get(filePath);
  return row && row.status === 'completed';
}

function getByPath(filePath) {
  return db.prepare('SELECT * FROM processed_files WHERE file_path = ?').get(filePath) || null;
}

function upsertDetected(filePath, fileSize, fileMtime, workflowName) {
  const existing = getByPath(filePath);
  if (existing) {
    // Don't re-detect if already in an active state
    if (['detected', 'pending', 'extracting', 'uploading', 'polling', 'awaiting_upload'].includes(existing.status)) {
      return existing;
    }
    // Don't re-detect if completed with same mtime
    if (existing.status === 'completed' && existing.file_mtime === fileMtime) {
      return existing;
    }
    db.prepare(`
      UPDATE processed_files
      SET file_size = ?, file_mtime = ?, status = 'detected', workflow_name = ?, error = NULL, retry_count = 0, updated_at = datetime('now')
      WHERE file_path = ?
    `).run(fileSize, fileMtime, workflowName, filePath);
  } else {
    db.prepare(`
      INSERT INTO processed_files (file_path, file_size, file_mtime, status, workflow_name)
      VALUES (?, ?, ?, 'detected', ?)
    `).run(filePath, fileSize, fileMtime, workflowName);
  }
  return getByPath(filePath);
}

function updateStatus(filePath, status, extra = {}) {
  const sets = ['status = ?', "updated_at = datetime('now')"];
  const params = [status];

  if (extra.jobId !== undefined) { sets.push('job_id = ?'); params.push(extra.jobId); }
  if (extra.wavPath !== undefined) { sets.push('wav_path = ?'); params.push(extra.wavPath); }
  if (extra.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }
  if (extra.retryCount !== undefined) { sets.push('retry_count = ?'); params.push(extra.retryCount); }

  params.push(filePath);
  db.prepare(`UPDATE processed_files SET ${sets.join(', ')} WHERE file_path = ?`).run(...params);
}

function getPending() {
  return db.prepare(
    "SELECT * FROM processed_files WHERE status IN ('pending', 'extracting', 'uploading', 'polling')"
  ).all();
}

function markCompleted(filePath, jobId) {
  updateStatus(filePath, 'completed', { jobId });
}

function markFailed(filePath, error, retryCount) {
  updateStatus(filePath, 'failed', { error, retryCount });
}

function markRejected(filePath) {
  updateStatus(filePath, 'rejected');
}

// Get files for Videos tab: detected files (pre-extraction)
function getVideoFiles(workflowName) {
  if (workflowName) {
    return db.prepare(
      "SELECT * FROM processed_files WHERE status = 'detected' AND workflow_name = ? ORDER BY created_at DESC"
    ).all(workflowName);
  }
  return db.prepare(
    "SELECT * FROM processed_files WHERE status = 'detected' ORDER BY created_at DESC"
  ).all();
}

// Get files for Audio tab: everything past detection (extracting, uploading, awaiting_upload, completed, failed)
function getAudioFiles(workflowName) {
  if (workflowName) {
    return db.prepare(
      "SELECT * FROM processed_files WHERE status IN ('pending', 'extracting', 'uploading', 'polling', 'awaiting_upload', 'completed', 'failed') AND workflow_name = ? ORDER BY updated_at DESC"
    ).all(workflowName);
  }
  return db.prepare(
    "SELECT * FROM processed_files WHERE status IN ('pending', 'extracting', 'uploading', 'polling', 'awaiting_upload', 'completed', 'failed') ORDER BY updated_at DESC"
  ).all();
}

function getByWorkflow(workflowName) {
  return db.prepare(
    "SELECT * FROM processed_files WHERE workflow_name = ? ORDER BY updated_at DESC LIMIT 200"
  ).all(workflowName);
}

function getQueueSnapshot() {
  return db.prepare(
    "SELECT * FROM processed_files ORDER BY updated_at DESC LIMIT 200"
  ).all();
}

module.exports = {
  initDb, closeDb, isProcessed, getByPath,
  upsertDetected, updateStatus, getPending,
  getVideoFiles, getAudioFiles, getByWorkflow,
  markCompleted, markFailed, markRejected,
  getQueueSnapshot
};
