// Per-workflow settings + global settings
// Depends on queue-renderer.js for activeWorkflow state

function renderSettings() {
  const panel = $('settingsPanel');
  if (!activeWorkflow) {
    panel.innerHTML = '<div class="empty-state"><p>Select a workflow</p></div>';
    return;
  }

  const wf = activeWorkflow;

  panel.innerHTML = `
    <h3>${escHtml(wf.name)} Settings</h3>

    <div class="form-group">
      <label>Workflow Name</label>
      <input type="text" id="wfName" value="${escHtml(wf.name)}">
    </div>

    <div class="form-group">
      <label>Watch Folder</label>
      <div class="folder-row">
        <input type="text" id="wfWatchFolder" value="${escHtml(wf.watchFolder || '')}" placeholder="~/Videos">
        <button class="btn-browse" id="btnBrowseWatch">Browse</button>
      </div>
    </div>

    <div class="form-group">
      <label>Server URL</label>
      <input type="url" id="wfServerUrl" value="${escHtml(wf.serverUrl || '')}" placeholder="http://localhost:3000">
    </div>

    <div class="form-group">
      <label>Extensions (comma-separated)</label>
      <input type="text" id="wfExtensions" value="${(wf.extensions || []).join(', ')}" placeholder=".mp4, .mkv, .webm, .flv, .mov, .avi">
    </div>

    <div class="form-group">
      <label>Approval Mode</label>
      <select id="wfApprovalMode">
        <option value="one-stage" ${wf.approvalMode === 'one-stage' ? 'selected' : ''}>One-stage (approve once → extract + upload)</option>
        <option value="two-stage" ${wf.approvalMode === 'two-stage' ? 'selected' : ''}>Two-stage (approve extract, then approve upload)</option>
      </select>
    </div>

    <div class="form-group">
      <div class="toggle-group">
        <label class="toggle">
          <input type="checkbox" id="wfDeleteWav" ${wf.deleteWavAfterUpload !== false ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">Delete WAV after upload</span>
      </div>
    </div>

    <div class="section-label">Directories</div>

    <div class="form-group">
      <label>Output Directory (WAV extraction target)</label>
      <div class="folder-row">
        <input type="text" id="wfOutputDir" value="${escHtml(wf.outputDir || '')}" placeholder="Default: next to source video">
        <button class="btn-browse" id="btnBrowseOutput">Browse</button>
      </div>
    </div>

    <div class="form-group">
      <label>Archive Directory (move originals after success)</label>
      <div class="folder-row">
        <input type="text" id="wfArchiveDir" value="${escHtml(wf.archiveDir || '')}" placeholder="Default: leave in place">
        <button class="btn-browse" id="btnBrowseArchive">Browse</button>
      </div>
    </div>

    <button class="btn-save" id="btnSaveWorkflow">Save Workflow Settings</button>
    <button class="btn-delete-workflow" id="btnDeleteWorkflow">Delete Workflow</button>
    <div class="status-bar" id="wfStatusBar">Ready</div>
  `;

  // Browse buttons
  $('btnBrowseWatch').addEventListener('click', async () => {
    const folder = await window.watcherAPI.browseFolder();
    if (folder) $('wfWatchFolder').value = folder;
  });

  $('btnBrowseOutput').addEventListener('click', async () => {
    const folder = await window.watcherAPI.browseFolder();
    if (folder) $('wfOutputDir').value = folder;
  });

  $('btnBrowseArchive').addEventListener('click', async () => {
    const folder = await window.watcherAPI.browseFolder();
    if (folder) $('wfArchiveDir').value = folder;
  });

  // Save
  $('btnSaveWorkflow').addEventListener('click', async () => {
    const bar = $('wfStatusBar');

    const updates = {
      name: $('wfName').value.trim(),
      watchFolder: $('wfWatchFolder').value.trim(),
      serverUrl: $('wfServerUrl').value.trim(),
      extensions: $('wfExtensions').value
        .split(',')
        .map(e => e.trim())
        .filter(Boolean)
        .map(e => e.startsWith('.') ? e : '.' + e),
      approvalMode: $('wfApprovalMode').value,
      deleteWavAfterUpload: $('wfDeleteWav').checked,
      outputDir: $('wfOutputDir').value.trim() || null,
      archiveDir: $('wfArchiveDir').value.trim() || null
    };

    if (!updates.watchFolder) {
      bar.textContent = 'Watch folder is required';
      bar.className = 'status-bar';
      return;
    }
    if (!updates.serverUrl) {
      bar.textContent = 'Server URL is required';
      bar.className = 'status-bar';
      return;
    }

    try {
      await window.watcherAPI.updateWorkflow(wf.name, updates);
      bar.textContent = 'Saved! Workflow will restart if running.';
      bar.className = 'status-bar success';
      // Refresh
      await loadWorkflows();
      const newWf = workflows.find(w => w.name === updates.name);
      if (newWf) await selectWorkflow(newWf.name);
    } catch (err) {
      bar.textContent = 'Error: ' + err.message;
      bar.className = 'status-bar';
    }
  });

  // Delete
  $('btnDeleteWorkflow').addEventListener('click', async () => {
    if (!confirm(`Delete workflow "${wf.name}"? This will stop watching this folder.`)) return;
    await window.watcherAPI.removeWorkflow(wf.name);
    activeWorkflow = null;
    await loadWorkflows();
    $('noWorkflowMsg').style.display = 'flex';
    $('workflowContent').style.display = 'none';
  });
}
