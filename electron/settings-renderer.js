const $s = (id) => document.getElementById(id);

async function loadConfig() {
  const config = await window.watcherAPI.getConfig();

  $s('watchFolder').value = config.watchFolder || '';
  $s('serverUrl').value = config.serverUrl || '';
  $s('extensions').value = (config.extensions || []).join(', ');
  $s('maxConcurrent').value = config.maxConcurrent || 1;
  $s('maxRetries').value = config.maxRetries || 5;
  $s('minDiskSpaceGB').value = config.minDiskSpaceGB || 2;
  $s('deleteWavAfterUpload').checked = config.deleteWavAfterUpload !== false;
  $s('processExisting').checked = config.processExisting === true;
  $s('requireApproval').checked = config.requireApproval === true;
  $s('outputDir').value = config.outputDir || '';
  $s('archiveDir').value = config.archiveDir || '';
}

function gatherConfig() {
  const extensions = $s('extensions').value
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)
    .map(e => e.startsWith('.') ? e : '.' + e);

  return {
    watchFolder: $s('watchFolder').value.trim(),
    serverUrl: $s('serverUrl').value.trim(),
    extensions,
    maxConcurrent: parseInt($s('maxConcurrent').value, 10) || 1,
    maxRetries: parseInt($s('maxRetries').value, 10) || 5,
    minDiskSpaceGB: parseFloat($s('minDiskSpaceGB').value) || 2,
    deleteWavAfterUpload: $s('deleteWavAfterUpload').checked,
    processExisting: $s('processExisting').checked,
    requireApproval: $s('requireApproval').checked,
    outputDir: $s('outputDir').value.trim() || null,
    archiveDir: $s('archiveDir').value.trim() || null
  };
}

$s('btnBrowse').addEventListener('click', async () => {
  const folder = await window.watcherAPI.browseFolder();
  if (folder) {
    $s('watchFolder').value = folder;
  }
});

$s('btnBrowseOutput').addEventListener('click', async () => {
  const folder = await window.watcherAPI.browseFolder();
  if (folder) {
    $s('outputDir').value = folder;
  }
});

$s('btnBrowseArchive').addEventListener('click', async () => {
  const folder = await window.watcherAPI.browseFolder();
  if (folder) {
    $s('archiveDir').value = folder;
  }
});

$s('btnSave').addEventListener('click', async () => {
  const config = gatherConfig();
  const statusBar = $s('statusBar');

  if (!config.watchFolder) {
    statusBar.textContent = 'Watch folder is required';
    statusBar.className = 'status-bar';
    return;
  }

  if (!config.serverUrl) {
    statusBar.textContent = 'Server URL is required';
    statusBar.className = 'status-bar';
    return;
  }

  try {
    const result = await window.watcherAPI.saveConfig(config);
    if (result && result.restarted) {
      statusBar.textContent = 'Saved! Watcher restarting...';
    } else {
      statusBar.textContent = 'Settings saved';
    }
    statusBar.className = 'status-bar success';
  } catch (err) {
    statusBar.textContent = 'Error: ' + err.message;
    statusBar.className = 'status-bar';
  }
});

loadConfig();
