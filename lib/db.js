const path = require('path');
const fs = require('fs');

let db = null;

const SCHEMA = `
DROP TABLE IF EXISTS processed_files;

CREATE TABLE processed_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data JSON NOT NULL DEFAULT '{}'
);
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

// ─── Helpers ───

function rowToObj(row) {
  if (!row) return null;
  return { id: row.id, ...JSON.parse(row.data) };
}

function allRows() {
  return db.prepare('SELECT * FROM processed_files').all().map(rowToObj);
}

function now() {
  return new Date().toISOString();
}

// ─── Core operations ───

function getByPath(filePath) {
  const rows = db.prepare('SELECT * FROM processed_files').all();
  for (const row of rows) {
    const obj = rowToObj(row);
    if (obj.file_path === filePath) return obj;
  }
  return null;
}

function getRowByPath(filePath) {
  const rows = db.prepare('SELECT * FROM processed_files').all();
  for (const row of rows) {
    const obj = JSON.parse(row.data);
    if (obj.file_path === filePath) return row;
  }
  return null;
}

function isProcessed(filePath) {
  const obj = getByPath(filePath);
  return obj && obj.status === 'completed';
}

function upsert(filePath, updates) {
  const existing = getRowByPath(filePath);
  if (existing) {
    const merged = { ...JSON.parse(existing.data), ...updates, updated_at: now() };
    db.prepare('UPDATE processed_files SET data = ? WHERE id = ?').run(JSON.stringify(merged), existing.id);
  } else {
    const data = { file_path: filePath, created_at: now(), updated_at: now(), ...updates };
    db.prepare('INSERT INTO processed_files (data) VALUES (?)').run(JSON.stringify(data));
  }
  return getByPath(filePath);
}

function upsertDetected(filePath, fileSize, fileMtime, workflowName) {
  const existing = getByPath(filePath);
  if (existing) {
    if (['detected', 'pending', 'extracting', 'uploading', 'polling', 'awaiting_upload'].includes(existing.status)) {
      return existing;
    }
    if (existing.status === 'completed' && existing.file_mtime === fileMtime) {
      return existing;
    }
  }
  return upsert(filePath, {
    file_size: fileSize,
    file_mtime: fileMtime,
    status: 'detected',
    workflow_name: workflowName,
    error: null,
    retry_count: 0
  });
}

function updateStatus(filePath, status, extra = {}) {
  const updates = { status };
  if (extra.jobId !== undefined) updates.job_id = extra.jobId;
  if (extra.wavPath !== undefined) updates.wav_path = extra.wavPath;
  if (extra.error !== undefined) updates.error = extra.error;
  if (extra.retryCount !== undefined) updates.retry_count = extra.retryCount;
  return upsert(filePath, updates);
}

function getPending() {
  return allRows().filter(r =>
    ['pending', 'extracting', 'uploading', 'polling'].includes(r.status)
  );
}

function markCompleted(filePath, jobId) {
  return upsert(filePath, { status: 'completed', job_id: jobId });
}

function markFailed(filePath, error, retryCount) {
  return upsert(filePath, { status: 'failed', error, retry_count: retryCount });
}

function markRejected(filePath) {
  return upsert(filePath, { status: 'rejected' });
}

// ─── Query helpers ───

function getVideoFiles(workflowName) {
  return allRows().filter(r =>
    r.status === 'detected' && (!workflowName || r.workflow_name === workflowName)
  ).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function getAudioFiles(workflowName) {
  const statuses = ['pending', 'extracting', 'uploading', 'polling', 'awaiting_upload', 'completed', 'failed'];
  return allRows().filter(r =>
    statuses.includes(r.status) && (!workflowName || r.workflow_name === workflowName)
  ).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

function getByWorkflow(workflowName) {
  return allRows().filter(r => r.workflow_name === workflowName)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 200);
}

function getQueueSnapshot() {
  return allRows()
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 200);
}

module.exports = {
  initDb, closeDb, isProcessed, getByPath,
  upsertDetected, updateStatus, getPending,
  getVideoFiles, getAudioFiles, getByWorkflow,
  markCompleted, markFailed, markRejected,
  getQueueSnapshot
};
