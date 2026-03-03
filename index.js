const { spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const { startWatcher } = require('./lib/watcher');

function timestamp() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      result.configPath = args[++i];
    } else if (args[i] === '--folder' && args[i + 1]) {
      result.watchFolder = args[++i];
    } else if (args[i] === '--server' && args[i + 1]) {
      result.serverUrl = args[++i];
    } else if (args[i] === '--process-existing') {
      result.processExisting = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node index.js [options]

Options:
  --config <path>       Path to watcher-config.json
  --folder <path>       Watch folder (overrides config)
  --server <url>        Server URL (overrides config)
  --process-existing    Process existing files in watch folder on startup
  -h, --help            Show this help`);
      process.exit(0);
    }
  }

  return result;
}

function checkFfmpeg() {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.on('error', () => {
      reject(new Error('ffmpeg not found in PATH. Please install ffmpeg.'));
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg check failed with code ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  // Build CLI overrides (only include defined values)
  const cliOverrides = {};
  if (args.watchFolder) cliOverrides.watchFolder = args.watchFolder;
  if (args.serverUrl) cliOverrides.serverUrl = args.serverUrl;
  if (args.processExisting) cliOverrides.processExisting = true;

  let config;
  try {
    config = loadConfig(args.configPath, cliOverrides);
  } catch (err) {
    console.log(`[ERROR] ${timestamp()} Config error: ${err.message}`);
    process.exit(1);
  }

  // Check ffmpeg
  try {
    await checkFfmpeg();
  } catch (err) {
    console.log(`[ERROR] ${timestamp()} ${err.message}`);
    process.exit(1);
  }

  // Print startup banner
  console.log(`[INFO]  ${timestamp()} Audio Watcher v2.0 starting`);
  console.log(`[INFO]  ${timestamp()} Watch folder: ${config.watchFolder}`);
  console.log(`[INFO]  ${timestamp()} Server: ${config.serverUrl}`);
  console.log(`[INFO]  ${timestamp()} Extensions: ${config.extensions.join(', ')}`);
  console.log(`[INFO]  ${timestamp()} Max concurrent: ${config.maxConcurrent}`);
  console.log(`[INFO]  ${timestamp()} Max retries: ${config.maxRetries}`);
  console.log(`[INFO]  ${timestamp()} Delete WAV after upload: ${config.deleteWavAfterUpload}`);
  console.log(`[INFO]  ${timestamp()} Process existing files: ${config.processExisting}`);
  console.log(`[INFO]  ${timestamp()} Database: ${config.dbPath}`);
  console.log(`[INFO]  ${timestamp()} Waiting for new video files...`);

  const { close, queue } = startWatcher(config);

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[INFO]  ${timestamp()} Shutting down...`);
    close().then(() => {
      console.log(`[INFO]  ${timestamp()} Watcher closed. Goodbye.`);
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
