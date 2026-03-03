const { execSync } = require('child_process');
const os = require('os');

const DEFAULT_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function hasEnoughSpace(dirPath, requiredBytes = DEFAULT_THRESHOLD_BYTES) {
  try {
    if (os.platform() === 'win32') {
      const drive = dirPath.split(':')[0] + ':';
      const cmd = `powershell -Command "(Get-PSDrive ${drive.replace(':', '')}).Free"`;
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
      const freeBytes = parseInt(output, 10);
      return freeBytes >= requiredBytes;
    } else {
      const output = execSync(`df -B1 "${dirPath}" | tail -1`, { encoding: 'utf-8', timeout: 10000 });
      const parts = output.trim().split(/\s+/);
      const freeBytes = parseInt(parts[3], 10);
      return freeBytes >= requiredBytes;
    }
  } catch {
    // If we can't check, assume there's enough space and let ffmpeg fail if not
    return true;
  }
}

module.exports = { hasEnoughSpace, DEFAULT_THRESHOLD_BYTES };
