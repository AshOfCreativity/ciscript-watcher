const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const THIRTY_MINUTES = 30 * 60 * 1000;
const BASE_DELAY = 1000;

function timestamp() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadWithRetry(wavPath, serverUrl, maxRetries = 5) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append('audio', fs.createReadStream(wavPath), {
        filename: path.basename(wavPath),
        contentType: 'audio/wav'
      });

      const res = await fetch(`${serverUrl}/api/upload`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders()
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed (${res.status}): ${text}`);
      }

      const data = await res.json();
      if (!data.jobId) {
        throw new Error('Server response missing jobId');
      }

      return data.jobId;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = BASE_DELAY * Math.pow(2, attempt);
        console.log(`[WARN]  ${timestamp()} Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`Upload failed after ${maxRetries} attempts: ${lastError.message}`);
}

async function pollJob(jobId, serverUrl, pollingInterval) {
  const deadline = Date.now() + THIRTY_MINUTES;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/api/jobs/${jobId}`);
      if (!res.ok) {
        throw new Error(`Poll failed (${res.status})`);
      }

      const job = await res.json();

      if (job.status === 'completed') {
        return job;
      }

      if (job.status === 'failed') {
        throw new Error(`Job failed: ${job.error || 'unknown error'}`);
      }

      // Still processing — log status and wait
      console.log(`[INFO]  ${timestamp()} Job ${jobId}: ${job.status}`);
    } catch (err) {
      if (err.message.startsWith('Job failed')) throw err;
      console.log(`[WARN]  ${timestamp()} Poll error: ${err.message}`);
    }

    await sleep(pollingInterval);
  }

  throw new Error(`Polling timed out after 30 minutes for job ${jobId}`);
}

async function uploadAndPoll(wavPath, config) {
  const jobId = await uploadWithRetry(wavPath, config.serverUrl, config.maxRetries);
  console.log(`[INFO]  ${timestamp()} Uploaded ${path.basename(wavPath)}, job: ${jobId}`);

  const job = await pollJob(jobId, config.serverUrl, config.pollingInterval);
  return job;
}

module.exports = { uploadWithRetry, pollJob, uploadAndPoll };
