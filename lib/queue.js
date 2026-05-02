const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { extractAudio, FORMAT_CONFIG } = require('./extractor');
const { uploadWithRetry, pollJob } = require('./uploader');
const { hasEnoughSpace } = require('./disk');
const db = require('./db');

const STABILIZATION_CHECK_INTERVAL = 500;
const STABILIZATION_TIMEOUT = 5 * 60 * 1000;

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
  constructor(workflow, globalConfig) {
    super();
    this.workflow = workflow;
    this.globalConfig = globalConfig;
    this.activeCount = 0;
    this.pending = [];
    this.shuttingDown = false;
  }

  /**
   * Approve files for extraction.
   * Moves detected → pending, then extraction runs. After extraction,
   * files stop at awaiting_upload until upload is separately approved.
   */
  approve(filePath) {
    const row = db.getByPath(filePath);
    if (!row || row.status !== 'detected') return;

    db.updateStatus(filePath, 'pending');
    this.pending.push(filePath);
    this.emit('queue:updated');
    this._processNext();
  }

  /**
   * Approve multiple files at once.
   */
  approveMultiple(filePaths) {
    let count = 0;
    for (const fp of filePaths) {
      const row = db.getByPath(fp);
      if (row && row.status === 'detected') {
        db.updateStatus(fp, 'pending');
        this.pending.push(fp);
        count++;
      }
    }
    if (count > 0) {
      this.emit('queue:updated');
      this._processNext();
    }
  }

  /**
   * Approve upload for files after extraction is done (awaiting_upload → uploading).
   */
  approveUpload(filePath) {
    const row = db.getByPath(filePath);
    if (!row || row.status !== 'awaiting_upload') return;

    db.updateStatus(filePath, 'uploading');
    this.pending.push(filePath);
    this.emit('queue:updated');
    this._processNext();
  }

  /**
   * Approve upload for multiple files after extraction is done.
   */
  approveUploadMultiple(filePaths) {
    let count = 0;
    for (const fp of filePaths) {
      const row = db.getByPath(fp);
      if (row && row.status === 'awaiting_upload') {
        db.updateStatus(fp, 'uploading');
        this.pending.push(fp);
        count++;
      }
    }
    if (count > 0) {
      this.emit('queue:updated');
      this._processNext();
    }
  }

  /**
   * Approve all detected files (Videos tab bulk action).
   */
  approveAll() {
    const rows = db.getVideoFiles(this.workflow.name);
    for (const row of rows) {
      db.updateStatus(row.file_path, 'pending');
      this.pending.push(row.file_path);
    }
    if (rows.length > 0) {
      this.emit('queue:updated');
      this._processNext();
    }
  }

  /**
   * Approve all awaiting_upload files for upload (Audio tab bulk action).
   */
  approveAllUploads() {
    const rows = db.getAudioFiles(this.workflow.name)
      .filter(r => r.status === 'awaiting_upload');
    for (const row of rows) {
      db.updateStatus(row.file_path, 'uploading');
      this.pending.push(row.file_path);
    }
    if (rows.length > 0) {
      this.emit('queue:updated');
      this._processNext();
    }
  }

  /**
   * Reject files — removes them from the queue.
   */
  reject(filePath) {
    const row = db.getByPath(filePath);
    if (!row) return;
    if (!['detected', 'awaiting_upload', 'failed'].includes(row.status)) return;
    db.markRejected(filePath);
    this.emit('queue:updated');
  }

  rejectMultiple(filePaths) {
    let count = 0;
    for (const fp of filePaths) {
      const row = db.getByPath(fp);
      if (row && ['detected', 'awaiting_upload', 'failed'].includes(row.status)) {
        db.markRejected(fp);
        count++;
      }
    }
    if (count > 0) {
      this.emit('queue:updated');
    }
  }

  /**
   * Re-queue a failed file back to detected status.
   */
  requeue(filePath) {
    const row = db.getByPath(filePath);
    if (!row || row.status !== 'failed') return;

    // If WAV already exists, go straight to awaiting_upload (skip re-extraction)
    if (row.wav_path && fs.existsSync(row.wav_path)) {
      db.updateStatus(filePath, 'awaiting_upload', { error: null, retryCount: 0 });
    } else {
      db.updateStatus(filePath, 'detected', { error: null, retryCount: 0 });
    }
    this.emit('queue:updated');
  }

  /**
   * Resume interrupted jobs from DB on startup.
   */
  resume() {
    const interrupted = db.getPending();
    for (const row of interrupted) {
      if (row.workflow_name !== this.workflow.name) continue;

      if (fs.existsSync(row.file_path)) {
        this.pending.push(row.file_path);
        this.emit('file:retrying', row.file_path);
      } else {
        db.markFailed(row.file_path, 'File no longer exists', row.retry_count);
      }
    }

    this._processNext();
  }

  async shutdown() {
    this.shuttingDown = true;
    this.pending = [];

    const deadline = Date.now() + 60000;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await sleep(500);
    }
  }

  _processNext() {
    const maxConcurrent = this.globalConfig.maxConcurrent || 1;
    while (this.activeCount < maxConcurrent && this.pending.length > 0 && !this.shuttingDown) {
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
      // If status is 'uploading' (resumed or two-stage approved), skip extraction
      if (row && row.status === 'uploading' && row.wav_path && fs.existsSync(row.wav_path)) {
        wavPath = row.wav_path;
        // Jump straight to upload
      } else {
        // Stabilize
        if (!row || row.status === 'pending') {
          await waitForStabilization(filePath, this.globalConfig.stabilizationDelay || 3000);
        }

        // Check disk space
        const spaceCheckDir = this.workflow.outputDir || path.dirname(filePath);
        const minBytes = (this.globalConfig.minDiskSpaceGB || 2) * 1024 * 1024 * 1024;
        if (!hasEnoughSpace(spaceCheckDir, minBytes)) {
          throw new Error('Insufficient disk space');
        }

        // Check for existing extracted audio (dedup: skip extraction if file already exists)
        const audioFmt = this.workflow.audioFormat || 'flac';
        const fmtExt = (FORMAT_CONFIG[audioFmt] || FORMAT_CONFIG.flac).ext;
        const expectedAudio = path.join(
          this.workflow.outputDir || path.dirname(filePath),
          path.basename(filePath, path.extname(filePath)) + fmtExt
        );
        if (fs.existsSync(expectedAudio)) {
          wavPath = expectedAudio;
          db.updateStatus(filePath, 'extracting', { wavPath });
          this.emit('file:extracting', filePath);
          this.emit('queue:updated');
          // Skip actual extraction — audio file already exists
        } else {
          // Extract audio
          this.emit('file:extracting', filePath);
          db.updateStatus(filePath, 'extracting');
          this.emit('queue:updated');
          wavPath = await extractAudio(filePath, this.workflow.outputDir || null, audioFmt);
          db.updateStatus(filePath, 'extracting', { wavPath });
        }

        // Stop after extraction — user must approve upload separately
        db.updateStatus(filePath, 'awaiting_upload', { wavPath });
        this.emit('file:awaiting-upload', filePath);
        this.emit('queue:updated');
        return;
      }

      // Upload
      db.updateStatus(filePath, 'uploading', { wavPath });
      this.emit('file:uploading', filePath);
      this.emit('queue:updated');

      // Check for existing jobId (dedup: skip upload if job already exists)
      const currentRow = db.getByPath(filePath);
      let jobId;
      if (currentRow && currentRow.job_id) {
        jobId = currentRow.job_id;
      } else {
        jobId = await uploadWithRetry(wavPath, this.workflow.serverUrl, this.globalConfig.maxRetries || 5, this.workflow.accountId);
        db.updateStatus(filePath, 'polling', { jobId });
      }

      this.emit('queue:updated');

      // Poll for completion
      const job = await pollJob(jobId, this.workflow.serverUrl, this.globalConfig.pollingInterval || 5000, this.workflow.accountId);

      // Done
      const segments = job.result && job.result.segments ? job.result.segments.length : 0;
      const speakers = job.result && job.result.segments
        ? new Set(job.result.segments.map(s => s.speaker)).size
        : 0;

      db.markCompleted(filePath, jobId);
      this.emit('file:completed', filePath, { jobId, segments, speakers });
      this.emit('queue:updated');

      // Cleanup WAV
      if (this.workflow.deleteWavAfterUpload && wavPath && fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
      }

      // Archive original video if configured
      if (this.workflow.archiveDir && fs.existsSync(filePath)) {
        try {
          let destPath = path.join(this.workflow.archiveDir, path.basename(filePath));
          if (fs.existsSync(destPath)) {
            const ext = path.extname(filePath);
            const name = path.basename(filePath, ext);
            destPath = path.join(this.workflow.archiveDir, `${name}_${Date.now()}${ext}`);
          }
          try {
            fs.renameSync(filePath, destPath);
          } catch (renameErr) {
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
      const canRetry = err.retryable && newRetryCount < (this.globalConfig.maxRetries || 5);

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
      if (this.workflow.deleteWavAfterUpload && wavPath && fs.existsSync(wavPath)) {
        try { fs.unlinkSync(wavPath); } catch {}
      }
    }
  }
}

module.exports = { UploadQueue };
