const path = require('path');
const fs = require('fs');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT UNIQUE NOT NULL,
  file_size INTEGER,
  file_mtime TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  job_id TEXT,
  wav_path TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status ON processed_files(status);
CREATE INDEX IF NOT EXISTS idx_file_path ON processed_files(file_path);
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

function upsertFile(filePath, fileSize, fileMtime) {
  const existing = getByPath(filePath);
  if (existing) {
    db.prepare(`
      UPDATE processed_files
      SET file_size = ?, file_mtime = ?, status = 'pending', error = NULL, updated_at = datetime('now')
      WHERE file_path = ?
    `).run(fileSize, fileMtime, filePath);
  } else {
    db.prepare(`
      INSERT INTO processed_files (file_path, file_size, file_mtime, status)
      VALUES (?, ?, ?, 'pending')
    `).run(filePath, fileSize, fileMtime);
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

function getAwaitingApproval() {
  return db.prepare("SELECT * FROM processed_files WHERE status = 'awaiting_approval'").all();
}

function upsertFileForApproval(filePath, fileSize, fileMtime) {
  const existing = getByPath(filePath);
  if (existing) {
    db.prepare(`
      UPDATE processed_files
      SET file_size = ?, file_mtime = ?, status = 'awaiting_approval', error = NULL, updated_at = datetime('now')
      WHERE file_path = ?
    `).run(fileSize, fileMtime, filePath);
  } else {
    db.prepare(`
      INSERT INTO processed_files (file_path, file_size, file_mtime, status)
      VALUES (?, ?, ?, 'awaiting_approval')
    `).run(filePath, fileSize, fileMtime);
  }
  return getByPath(filePath);
}

function markRejected(filePath) {
  updateStatus(filePath, 'rejected');
}

function getQueueSnapshot() {
  return db.prepare(
    "SELECT * FROM processed_files ORDER BY updated_at DESC LIMIT 100"
  ).all();
}

module.exports = { initDb, closeDb, isProcessed, getByPath, upsertFile, upsertFileForApproval, updateStatus, getPending, getAwaitingApproval, markCompleted, markFailed, markRejected, getQueueSnapshot };
