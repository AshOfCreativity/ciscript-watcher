const { Notification, shell } = require('electron');

function setupNotifications(queue, serverUrl, config) {
  queue.on('file:detected', (filePath) => {
    const path = require('path');
    const title = config && config.requireApproval
      ? 'Awaiting Approval'
      : 'New Recording Detected';
    new Notification({
      title,
      body: path.basename(filePath)
    }).show();
  });

  queue.on('file:uploading', (filePath) => {
    const path = require('path');
    new Notification({
      title: 'Audio Extracted, Uploading...',
      body: path.basename(filePath)
    }).show();
  });

  queue.on('file:completed', (filePath, info) => {
    const path = require('path');
    const notification = new Notification({
      title: 'Transcription Complete',
      body: `${path.basename(filePath)} — ${info.speakers} speaker${info.speakers !== 1 ? 's' : ''}, ${info.segments} segments`
    });
    notification.on('click', () => {
      shell.openExternal(serverUrl);
    });
    notification.show();
  });

  queue.on('file:failed', (filePath, err) => {
    const path = require('path');
    new Notification({
      title: 'Processing Failed',
      body: `${path.basename(filePath)}: ${err.message}`
    }).show();
  });
}

module.exports = { setupNotifications };
