const $ = (id) => document.getElementById(id);

let workflows = [];
let activeWorkflow = null;
let videoFiles = [];
let audioFiles = [];
let videoSelection = new Set();
let audioSelection = new Set();
let lastVideoClickIdx = -1;
let lastAudioClickIdx = -1;
let hideDone = false;

// ─── Utility ───

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function extractFilename(filePath) {
  if (!filePath) return 'Unknown';
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function statusLabel(status) {
  switch (status) {
    case 'detected': return 'Detected';
    case 'pending': return 'Queued';
    case 'extracting': return 'Extracting';
    case 'uploading': return 'Uploading';
    case 'polling': return 'Processing';
    case 'awaiting_upload': return 'Awaiting Upload';
    case 'completed': return 'Done';
    case 'failed': return 'Failed';
    case 'rejected': return 'Rejected';
    default: return status;
  }
}

function badgeClass(status) {
  if (status === 'detected') return 'badge-detected';
  if (status === 'awaiting_upload') return 'badge-awaiting-upload';
  if (['pending', 'extracting', 'uploading', 'polling'].includes(status)) return 'badge-active';
  if (status === 'completed') return 'badge-completed';
  if (status === 'failed') return 'badge-failed';
  if (status === 'rejected') return 'badge-rejected';
  return '';
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ─── Sidebar: Workflow List ───

async function loadWorkflows() {
  workflows = await window.watcherAPI.getWorkflows();
  renderWorkflowList();
}

function renderWorkflowList() {
  const list = $('workflowList');
  if (workflows.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:#555;font-size:12px">No workflows yet</div>';
    return;
  }

  list.innerHTML = workflows.map(w => {
    const isActive = activeWorkflow && activeWorkflow.name === w.name;
    const dotClass = w.running ? 'running' : 'stopped';
    const toggleIcon = w.running ? '\u25A0' : '\u25B6';
    const toggleTitle = w.running ? 'Stop' : 'Start';
    return `
      <div class="workflow-item ${isActive ? 'active' : ''}" data-name="${escHtml(w.name)}">
        <span class="workflow-status-dot ${dotClass}"></span>
        <span class="workflow-name" title="${escHtml(w.watchFolder)}">${escHtml(w.name)}</span>
        <button class="workflow-toggle" data-action="toggle" data-wf="${escHtml(w.name)}" title="${toggleTitle}">${toggleIcon}</button>
      </div>
    `;
  }).join('');
}

$('workflowList').addEventListener('click', async (e) => {
  // Toggle start/stop
  const toggleBtn = e.target.closest('.workflow-toggle');
  if (toggleBtn) {
    e.stopPropagation();
    const name = toggleBtn.dataset.wf;
    const wf = workflows.find(w => w.name === name);
    if (wf) {
      if (wf.running) {
        await window.watcherAPI.stopWorkflow(name);
      } else {
        await window.watcherAPI.startWorkflow(name);
      }
      await loadWorkflows();
    }
    return;
  }

  // Select workflow
  const item = e.target.closest('.workflow-item');
  if (item) {
    const name = item.dataset.name;
    await selectWorkflow(name);
  }
});

async function selectWorkflow(name) {
  activeWorkflow = workflows.find(w => w.name === name) || null;
  renderWorkflowList();

  if (activeWorkflow) {
    $('noWorkflowMsg').style.display = 'none';
    $('workflowContent').style.display = 'flex';
    await refreshFiles();
    renderSettings();
  } else {
    $('noWorkflowMsg').style.display = 'flex';
    $('workflowContent').style.display = 'none';
  }
}

// Add workflow
$('btnAddWorkflow').addEventListener('click', async () => {
  const name = prompt('Workflow name:');
  if (!name || !name.trim()) return;
  const result = await window.watcherAPI.addWorkflow({ name: name.trim() });
  if (result && result.error) {
    alert('Failed to create workflow: ' + result.error);
    return;
  }
  await loadWorkflows();
  await selectWorkflow(name.trim());
});

// Start/Stop all
$('btnStartAll').addEventListener('click', async () => {
  await window.watcherAPI.startAll();
  await loadWorkflows();
});

$('btnStopAll').addEventListener('click', async () => {
  await window.watcherAPI.stopAll();
  await loadWorkflows();
});

// ─── Tab switching ───

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ─── Data loading ───

async function refreshFiles() {
  if (!activeWorkflow) return;
  videoFiles = await window.watcherAPI.getVideoFiles(activeWorkflow.name);
  audioFiles = await window.watcherAPI.getAudioFiles(activeWorkflow.name);
  // Clean up stale selections
  videoSelection = new Set([...videoSelection].filter(fp => videoFiles.some(f => f.file_path === fp)));
  audioSelection = new Set([...audioSelection].filter(fp => audioFiles.some(f => f.file_path === fp)));
  renderVideos();
  renderAudio();
  updateCounts();
}

function updateCounts() {
  $('videosCount').textContent = videoFiles.length;
  const visibleAudio = hideDone
    ? audioFiles.filter(r => !['completed', 'rejected'].includes(r.status))
    : audioFiles;
  $('audioCount').textContent = visibleAudio.length;
}

// ─── Videos Tab ───

function renderVideos() {
  const tbody = $('videosBody');
  const empty = $('videosEmpty');

  if (videoFiles.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    updateVideoToolbar();
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = videoFiles.map((row, idx) => {
    const fp = row.file_path;
    const checked = videoSelection.has(fp) ? 'checked' : '';
    const sel = videoSelection.has(fp) ? 'selected' : '';
    return `
      <tr class="${sel}" data-idx="${idx}" data-fp="${escHtml(fp)}">
        <td class="cb-cell"><input type="checkbox" ${checked} data-fp="${escHtml(fp)}"></td>
        <td class="file-name-cell" title="${escHtml(fp)}">${escHtml(extractFilename(fp))}</td>
        <td class="file-size-cell">${formatSize(row.file_size)}</td>
        <td class="file-date-cell">${formatDate(row.created_at)}</td>
        <td><span class="status-badge ${badgeClass(row.status)}">${statusLabel(row.status)}</span></td>
      </tr>
    `;
  }).join('');

  updateVideoToolbar();
}

$('videosBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const fp = tr.dataset.fp;
  const idx = parseInt(tr.dataset.idx, 10);

  if (e.shiftKey && lastVideoClickIdx >= 0) {
    // Shift-click range select
    const start = Math.min(lastVideoClickIdx, idx);
    const end = Math.max(lastVideoClickIdx, idx);
    for (let i = start; i <= end; i++) {
      videoSelection.add(videoFiles[i].file_path);
    }
  } else if (e.ctrlKey || e.metaKey) {
    // Ctrl-click toggle
    if (videoSelection.has(fp)) videoSelection.delete(fp);
    else videoSelection.add(fp);
  } else {
    // Regular click on checkbox
    if (e.target.type === 'checkbox') {
      if (e.target.checked) videoSelection.add(fp);
      else videoSelection.delete(fp);
    } else {
      // Click row = toggle
      if (videoSelection.has(fp)) videoSelection.delete(fp);
      else videoSelection.add(fp);
    }
  }

  lastVideoClickIdx = idx;
  renderVideos();
});

$('cbSelectAllVideos').addEventListener('change', (e) => {
  if (e.target.checked) {
    videoFiles.forEach(f => videoSelection.add(f.file_path));
  } else {
    videoSelection.clear();
  }
  renderVideos();
});

function updateVideoToolbar() {
  const toolbar = $('videosToolbar');
  if (videoSelection.size > 0) {
    toolbar.classList.add('visible');
    $('videosSelCount').textContent = videoSelection.size + ' selected';
  } else {
    toolbar.classList.remove('visible');
  }
}

$('btnApproveSelected').addEventListener('click', async () => {
  if (videoSelection.size === 0) return;
  await window.watcherAPI.approveFiles([...videoSelection]);
  videoSelection.clear();
  await refreshFiles();
});

$('btnRejectSelected').addEventListener('click', async () => {
  if (videoSelection.size === 0) return;
  await window.watcherAPI.rejectFiles([...videoSelection]);
  videoSelection.clear();
  await refreshFiles();
});

$('btnSelectAllVideos').addEventListener('click', () => {
  videoFiles.forEach(f => videoSelection.add(f.file_path));
  renderVideos();
});

$('btnDeselectAllVideos').addEventListener('click', () => {
  videoSelection.clear();
  renderVideos();
});

// ─── Audio Tab ───

function renderAudio() {
  const tbody = $('audioBody');
  const empty = $('audioEmpty');

  let filtered = hideDone
    ? audioFiles.filter(r => !['completed', 'rejected'].includes(r.status))
    : audioFiles;

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    updateAudioToolbar();
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = filtered.map((row, idx) => {
    const fp = row.file_path;
    const checked = audioSelection.has(fp) ? 'checked' : '';
    const sel = audioSelection.has(fp) ? 'selected' : '';
    const jobLink = row.job_id ? `<span style="color:#4a6fa5;font-size:11px">${row.job_id.slice(0, 8)}</span>` : '';
    const errorRow = row.status === 'failed' && row.error
      ? `<div class="error-text">${escHtml(row.error)}</div>`
      : '';

    return `
      <tr class="${sel}" data-idx="${idx}" data-fp="${escHtml(fp)}">
        <td class="cb-cell"><input type="checkbox" ${checked} data-fp="${escHtml(fp)}"></td>
        <td class="file-name-cell" title="${escHtml(fp)}">${escHtml(extractFilename(fp))}${errorRow}</td>
        <td class="file-size-cell">${formatSize(row.file_size)}</td>
        <td><span class="status-badge ${badgeClass(row.status)}">${statusLabel(row.status)}</span></td>
        <td>${jobLink}</td>
      </tr>
    `;
  }).join('');

  updateAudioToolbar();
}

$('audioBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const fp = tr.dataset.fp;
  const idx = parseInt(tr.dataset.idx, 10);

  if (e.shiftKey && lastAudioClickIdx >= 0) {
    const start = Math.min(lastAudioClickIdx, idx);
    const end = Math.max(lastAudioClickIdx, idx);
    const filtered = hideDone
      ? audioFiles.filter(r => !['completed', 'rejected'].includes(r.status))
      : audioFiles;
    for (let i = start; i <= end; i++) {
      if (filtered[i]) audioSelection.add(filtered[i].file_path);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (audioSelection.has(fp)) audioSelection.delete(fp);
    else audioSelection.add(fp);
  } else {
    if (e.target.type === 'checkbox') {
      if (e.target.checked) audioSelection.add(fp);
      else audioSelection.delete(fp);
    } else {
      if (audioSelection.has(fp)) audioSelection.delete(fp);
      else audioSelection.add(fp);
    }
  }

  lastAudioClickIdx = idx;
  renderAudio();
});

$('cbSelectAllAudio').addEventListener('change', (e) => {
  const filtered = hideDone
    ? audioFiles.filter(r => !['completed', 'rejected'].includes(r.status))
    : audioFiles;
  if (e.target.checked) {
    filtered.forEach(f => audioSelection.add(f.file_path));
  } else {
    audioSelection.clear();
  }
  renderAudio();
});

function updateAudioToolbar() {
  const toolbar = $('audioToolbar');
  if (audioSelection.size > 0) {
    toolbar.classList.add('visible');
    $('audioSelCount').textContent = audioSelection.size + ' selected';
  } else {
    toolbar.classList.remove('visible');
  }
}

$('btnApproveUpload').addEventListener('click', async () => {
  if (audioSelection.size === 0) return;
  await window.watcherAPI.approveUploadFiles([...audioSelection]);
  audioSelection.clear();
  await refreshFiles();
});

$('btnRejectAudio').addEventListener('click', async () => {
  if (audioSelection.size === 0) return;
  await window.watcherAPI.rejectFiles([...audioSelection]);
  audioSelection.clear();
  await refreshFiles();
});

$('btnSelectAllAudio').addEventListener('click', () => {
  const filtered = hideDone
    ? audioFiles.filter(r => !['completed', 'rejected'].includes(r.status))
    : audioFiles;
  filtered.forEach(f => audioSelection.add(f.file_path));
  renderAudio();
});

$('btnDeselectAllAudio').addEventListener('click', () => {
  audioSelection.clear();
  renderAudio();
});

$('btnClearDone').addEventListener('click', () => {
  hideDone = !hideDone;
  $('btnClearDone').textContent = hideDone ? 'Show All' : 'Clear Done';
  renderAudio();
  updateCounts();
});

// ─── Push updates ───

window.watcherAPI.onQueueUpdated(() => {
  refreshFiles();
  loadWorkflows(); // refresh running state dots
});

// ─── Initial load ───

(async () => {
  await loadWorkflows();
  // Auto-select first workflow if one exists
  if (workflows.length > 0) {
    await selectWorkflow(workflows[0].name);
  }
})();
