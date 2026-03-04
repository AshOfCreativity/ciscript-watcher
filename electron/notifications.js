const { Notification, shell } = require('electron');
const path = require('path');

function setupNotifications(queue, serverUrl, workflow) {
  const prefix = workflow && workflow.name ? `[${workflow.name}] ` : '';

  queue.on('file:detected', (filePath) => {
    new Notification({
      title: `${prefix}New File Detected`,
      body: `${path.basename(filePath)} — awaiting approval`
    }).show();
  });

  queue.on('file:extracting', (filePath) => {
    new Notification({
      title: `${prefix}Extraction Started`,
      body: path.basename(filePath)
    }).show();
  });

  queue.on('file:awaiting-upload', (filePath) => {
    new Notification({
      title: `${prefix}Extraction Complete`,
      body: `${path.basename(filePath)} — awaiting upload approval`
    }).show();
  });

  queue.on('file:uploading', (filePath) => {
    new Notification({
      title: `${prefix}Uploading`,
      body: path.basename(filePath)
    }).show();
  });

  queue.on('file:completed', (filePath, info) => {
    const notification = new Notification({
      title: `${prefix}Transcription Complete`,
      body: `${path.basename(filePath)} — ${info.speakers} speaker${info.speakers !== 1 ? 's' : ''}, ${info.segments} segments`
    });
    notification.on('click', () => {
      shell.openExternal(serverUrl);
    });
    notification.show();
  });

  queue.on('file:failed', (filePath, err) => {
    new Notification({
      title: `${prefix}Processing Failed`,
      body: `${path.basename(filePath)}: ${err.message}`
    }).show();
  });

  queue.on('file:retrying', (filePath, err) => {
    const msg = err ? err.message : 'unknown error';
    new Notification({
      title: `${prefix}Retrying`,
      body: `${path.basename(filePath)}: ${msg}`
    }).show();
  });
}

module.exports = { setupNotifications };
