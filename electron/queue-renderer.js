const $ = (id) => document.getElementById(id);

let queueData = [];
let hideDone = false;

// Status sort order: awaiting first, then active, then terminal
const STATUS_ORDER = {
  'awaiting_approval': 0,
  'pending': 1,
  'extracting': 2,
  'uploading': 3,
  'polling': 4,
  'completed': 5,
  'failed': 6,
  'rejected': 7
};

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function statusLabel(status) {
  switch (status) {
    case 'awaiting_approval': return 'Waiting';
    case 'pending': return 'Queued';
    case 'extracting': return 'Extracting';
    case 'uploading': return 'Uploading';
    case 'polling': return 'Processing';
    case 'completed': return 'Done';
    case 'failed': return 'Failed';
    case 'rejected': return 'Rejected';
    default: return status;
  }
}

function badgeClass(status) {
  if (status === 'awaiting_approval') return 'badge-awaiting';
  if (['pending', 'extracting', 'uploading', 'polling'].includes(status)) return 'badge-active';
  if (status === 'completed') return 'badge-completed';
  if (status === 'failed') return 'badge-failed';
  if (status === 'rejected') return 'badge-rejected';
  return '';
}

function extractFilename(filePath) {
  if (!filePath) return 'Unknown';
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function renderQueue() {
  const list = $('fileList');
  const approveAllBtn = $('btnApproveAll');

  // Sort: by status order, then by updated_at desc within same status
  const sorted = [...queueData].sort((a, b) => {
    const orderA = STATUS_ORDER[a.status] ?? 99;
    const orderB = STATUS_ORDER[b.status] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });

  // Filter out done items if hideDone
  const filtered = hideDone
    ? sorted.filter(r => !['completed', 'rejected'].includes(r.status))
    : sorted;

  // Count awaiting items
  const awaitingCount = queueData.filter(r => r.status === 'awaiting_approval').length;
  approveAllBtn.disabled = awaitingCount === 0;

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p>No files detected yet</p>
        <p>Drop video files into your watch folder to get started</p>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(row => {
    const filename = extractFilename(row.file_path);
    const size = formatSize(row.file_size);
    const label = statusLabel(row.status);
    const badge = badgeClass(row.status);
    const isAwaiting = row.status === 'awaiting_approval';

    const actions = isAwaiting
      ? `<div class="file-actions">
           <button class="btn-action btn-action-approve" data-path="${row.file_path.replace(/"/g, '&quot;')}">Approve</button>
           <button class="btn-action btn-action-reject" data-path="${row.file_path.replace(/"/g, '&quot;')}">Reject</button>
         </div>`
      : '';

    const errorInfo = row.status === 'failed' && row.error
      ? `<div class="file-meta" style="color:#ef4444">${row.error}</div>`
      : '';

    return `
      <div class="file-row status-${row.status}">
        <div class="file-info">
          <div class="file-name" title="${row.file_path.replace(/"/g, '&quot;')}">${filename}</div>
          <div class="file-meta">${size}</div>
          ${errorInfo}
        </div>
        <span class="status-badge ${badge}">${label}</span>
        ${actions}
      </div>
    `;
  }).join('');
}

// Event delegation for approve/reject buttons
$('fileList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-action');
  if (!btn) return;

  const filePath = btn.dataset.path;
  if (btn.classList.contains('btn-action-approve')) {
    await window.watcherAPI.approveFile(filePath);
  } else if (btn.classList.contains('btn-action-reject')) {
    await window.watcherAPI.rejectFile(filePath);
  }
});

$('btnApproveAll').addEventListener('click', async () => {
  await window.watcherAPI.approveAll();
});

$('btnClearDone').addEventListener('click', () => {
  hideDone = !hideDone;
  $('btnClearDone').textContent = hideDone ? 'Show All' : 'Clear Done';
  renderQueue();
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// Subscribe to push updates
window.watcherAPI.onQueueUpdated((rows) => {
  queueData = rows;
  renderQueue();
});

// Initial load
(async () => {
  try {
    queueData = await window.watcherAPI.getQueue();
    renderQueue();
  } catch {}
})();
