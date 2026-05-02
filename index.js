const { spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const { startWatcher } = require('./lib/watcher');
const { ffmpegBin } = require('./lib/extractor');

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
      // No longer needed — always scans existing files
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node index.js [options]

Options:
  --config <path>       Path to watcher-config.json
  --folder <path>       Watch folder (overrides first workflow)
  --server <url>        Server URL (overrides first workflow)
  -h, --help            Show this help`);
      process.exit(0);
    }
  }

  return result;
}

function checkFfmpeg() {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.on('error', () => {
      reject(new Error(`ffmpeg not found at "${ffmpegBin}". Bundled ffmpeg failed to load and none on PATH.`));
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg check failed with code ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  // Build CLI overrides — applied to first workflow
  const cliOverrides = {};
  if (args.watchFolder) cliOverrides.watchFolder = args.watchFolder;
  if (args.serverUrl) cliOverrides.serverUrl = args.serverUrl;

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
  console.log(`[INFO]  ${timestamp()} Audio Watcher v3.0 starting`);
  console.log(`[INFO]  ${timestamp()} Workflows: ${config.workflows.length}`);
  for (const wf of config.workflows) {
    console.log(`[INFO]  ${timestamp()}   "${wf.name}": ${wf.watchFolder} → ${wf.serverUrl}`);
  }
  console.log(`[INFO]  ${timestamp()} Max concurrent: ${config.global.maxConcurrent}`);
  console.log(`[INFO]  ${timestamp()} Max retries: ${config.global.maxRetries}`);
  console.log(`[INFO]  ${timestamp()} Database: ${config.global.dbPath}`);
  console.log(`[INFO]  ${timestamp()} Mode: extract then upload (both require approval)`);
  console.log(`[INFO]  ${timestamp()} Scanning watch folders...`);

  const system = startWatcher(config);

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[INFO]  ${timestamp()} Shutting down...`);
    system.close().then(() => {
      console.log(`[INFO]  ${timestamp()} Watcher closed. Goodbye.`);
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
