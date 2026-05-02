const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const THIRTY_MINUTES = 30 * 60 * 1000;

const FORMAT_CONFIG = {
  wav:  { ext: '.wav',  codec: 'pcm_s16le', extraArgs: [] },
  flac: { ext: '.flac', codec: 'flac',      extraArgs: [] },
  mp3:  { ext: '.mp3',  codec: 'libmp3lame', extraArgs: ['-b:a', '64k'] }
};

function checkFileAccessible(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EACCES') {
      const retryErr = new Error(`File is locked (${err.code}): ${filePath}`);
      retryErr.retryable = true;
      throw retryErr;
    }
    throw err;
  }
}

function extractAudio(videoPath, outputDir = null, audioFormat = 'flac') {
  checkFileAccessible(videoPath);

  const fmt = FORMAT_CONFIG[audioFormat] || FORMAT_CONFIG.flac;

  return new Promise((resolve, reject) => {
    const dir = outputDir || path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const outPath = path.join(dir, `${base}${fmt.ext}`);

    const args = [
      '-i', videoPath,
      '-vn',
      '-acodec', fmt.codec,
      '-ar', '16000',
      '-ac', '1',
      ...fmt.extraArgs,
      '-y',
      outPath
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after 30 minutes: ${videoPath}`));
    }, THIRTY_MINUTES);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve(outPath);
      }
    });
  });
}

module.exports = { extractAudio, FORMAT_CONFIG };
