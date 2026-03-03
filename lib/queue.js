const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { extractAudio } = require('./extractor');
const { uploadWithRetry, pollJob } = require('./uploader');
const { hasEnoughSpace } = require('./disk');
const db = require('./db');

const STABILIZATION_CHECK_INTERVAL = 500;
const STABILIZATION_TIMEOUT = 5 * 60 * 1000;

function timestamp() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForStabilization(filePath, stabilizationDelay) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + STABILIZATION_TIMEOUT;
    let lastSize = -1;
    let stableSince = null;

    const check = () => {
      if (Date.now() > deadline) {
        reject(new Error(`File stabilization timed out after 5 minutes: ${filePath}`));
        return;
      }

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (err) {
        reject(new Error(`File disappeared during stabilization: ${filePath}`));
        return;
      }

      if (stat.size === lastSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stabilizationDelay) {
          resolve();
          return;
        }
      } else {
        lastSize = stat.size;
        stableSince = null;
      }

      setTimeout(check, STABILIZATION_CHECK_INTERVAL);
    };

    check();
  });
}

class UploadQueue extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.activeCount = 0;
    this.pending = [];
    this.shuttingDown = false;
  }

  enqueue(filePath) {
    if (this.shuttingDown) return;

    // Check if already completed in DB
    if (db.isProcessed(filePath)) {
      return;
    }

    // Check if already in the pending queue or active
    const existing = db.getByPath(filePath);
    if (existing && (existing.status === 'extracting' || existing.status === 'uploading' || existing.status === 'polling')) {
      return;
    }
    // Skip files already awaiting approval
    if (existing && existing.status === 'awaiting_approval') {
      return;
    }

    // Get file info
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const fileMtime = stat.mtime.toISOString();

    // Check if file was already processed with same mtime
    if (existing && existing.status === 'completed' && existing.file_mtime === fileMtime) {
      return;
    }

    // Approval gate: if requireApproval, park the file instead of auto-processing
    if (this.config.requireApproval) {
      db.upsertFileForApproval(filePath, stat.size, fileMtime);
      this.emit('file:detected', filePath);
      this.emit('queue:updated');
      return;
    }

    db.upsertFile(filePath, stat.size, fileMtime);
    this.emit('file:detected', filePath);
    this.pending.push(filePath);
    this.emit('queue:updated');
    this._processNext();
  }

  approve(filePath) {
    const row = db.getByPath(filePath);
    if (!row || row.status !== 'awaiting_approval') return;

    db.updateStatus(filePath, 'pending');
    this.pending.push(filePath);
    this.emit('queue:updated');
    this._processNext();
  }

  reject(filePath) {
    const row = db.getByPath(filePath);
    if (!row || row.status !== 'awaiting_approval') return;

    db.markRejected(filePath);
    this.emit('queue:updated');
  }

  approveAll() {
    const rows = db.getAwaitingApproval();
    for (const row of rows) {
      db.updateStatus(row.file_path, 'pending');
      this.pending.push(row.file_path);
    }
    if (rows.length > 0) {
      this.emit('queue:updated');
      this._processNext();
    }
  }

  resume() {
    const interrupted = db.getPending();
    for (const row of interrupted) {
      if (row.status === 'pending' || row.status === 'extracting' || row.status === 'uploading' || row.status === 'polling') {
        // Re-check that the file still exists
        if (fs.existsSync(row.file_path)) {
          this.pending.push(row.file_path);
          this.emit('file:retrying', row.file_path);
        } else {
          db.markFailed(row.file_path, 'File no longer exists', row.retry_count);
        }
      }
    }

    // Restore awaiting_approval rows into memory (don't auto-process)
    const awaiting = db.getAwaitingApproval();
    if (awaiting.length > 0) {
      this.emit('queue:updated');
    }

    this._processNext();
  }

  async shutdown() {
    this.shuttingDown = true;
    this.pending = [];

    // Wait for active jobs to finish (with timeout)
    const deadline = Date.now() + 60000;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await sleep(500);
    }
  }

  _processNext() {
    while (this.activeCount < this.config.maxConcurrent && this.pending.length > 0 && !this.shuttingDown) {
      const filePath = this.pending.shift();
      this.activeCount++;
      this._processFile(filePath).finally(() => {
        this.activeCount--;
        this._processNext();
      });
    }
  }

  async _processFile(filePath) {
    const basename = path.basename(filePath);
    let wavPath = null;
    const row = db.getByPath(filePath);
    const retryCount = row ? row.retry_count : 0;

    try {
      // Stabilize (skip if resuming past extraction)
      if (!row || row.status === 'pending') {
        await waitForStabilization(filePath, this.config.stabilizationDelay);
      }

      // Check disk space on output dir or source dir
      const spaceCheckDir = this.config.outputDir || path.dirname(filePath);
      const minBytes = this.config.minDiskSpaceGB * 1024 * 1024 * 1024;
      if (!hasEnoughSpace(spaceCheckDir, minBytes)) {
        throw new Error('Insufficient disk space');
      }

      // Extract audio
      this.emit('file:extracting', filePath);
      db.updateStatus(filePath, 'extracting');
      this.emit('queue:updated');
      wavPath = await extractAudio(filePath, this.config.outputDir || null);
      db.updateStatus(filePath, 'uploading', { wavPath });
      this.emit('queue:updated');

      // Upload
      this.emit('file:uploading', filePath);
      const jobId = await uploadWithRetry(wavPath, this.config.serverUrl, this.config.maxRetries);
      db.updateStatus(filePath, 'polling', { jobId });
      this.emit('queue:updated');

      // Poll for completion
      const job = await pollJob(jobId, this.config.serverUrl, this.config.pollingInterval);

      // Done
      const segments = job.result && job.result.segments ? job.result.segments.length : 0;
      const speakers = job.result && job.result.segments
        ? new Set(job.result.segments.map(s => s.speaker)).size
        : 0;

      db.markCompleted(filePath, jobId);
      this.emit('file:completed', filePath, { jobId, segments, speakers });
      this.emit('queue:updated');

      // Cleanup WAV
      if (this.config.deleteWavAfterUpload && wavPath && fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
      }

      // Archive original video if configured
      if (this.config.archiveDir && fs.existsSync(filePath)) {
        try {
          let destPath = path.join(this.config.archiveDir, path.basename(filePath));
          // Collision avoidance: add timestamp suffix if file exists
          if (fs.existsSync(destPath)) {
            const ext = path.extname(filePath);
            const name = path.basename(filePath, ext);
            destPath = path.join(this.config.archiveDir, `${name}_${Date.now()}${ext}`);
          }
          try {
            fs.renameSync(filePath, destPath);
          } catch (renameErr) {
            // Cross-drive fallback: copy + delete
            fs.copyFileSync(filePath, destPath);
            fs.unlinkSync(filePath);
          }
          this.emit('file:archived', filePath, destPath);
        } catch (archiveErr) {
          this.emit('file:archive-failed', filePath, archiveErr);
        }
      }
    } catch (err) {
      const newRetryCount = retryCount + 1;
      const canRetry = err.retryable && newRetryCount < this.config.maxRetries;

      if (canRetry) {
        db.updateStatus(filePath, 'pending', { error: err.message, retryCount: newRetryCount });
        this.emit('file:retrying', filePath, err);
        this.pending.push(filePath);
      } else {
        db.markFailed(filePath, err.message, newRetryCount);
        this.emit('file:failed', filePath, err);
      }
      this.emit('queue:updated');

      // Attempt WAV cleanup on error
      if (this.config.deleteWavAfterUpload && wavPath && fs.existsSync(wavPath)) {
        try { fs.unlinkSync(wavPath); } catch {}
      }
    }
  }
}

module.exports = { UploadQueue };
