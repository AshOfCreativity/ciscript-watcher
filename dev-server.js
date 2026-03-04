const http = require('http');
const fs = require('fs');
const path = require('path');
const { WORKFLOW_DEFAULTS, GLOBAL_DEFAULTS } = require('./lib/config');

const PORT = 3001;
const CONFIG_PATH = path.join(__dirname, 'watcher-config.json');

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { workflows: [{ ...WORKFLOW_DEFAULTS }], global: { ...GLOBAL_DEFAULTS } };
  }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  // API routes
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readConfig()));
    return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        writeConfig(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static file serving from electron/
  const electronDir = path.join(__dirname, 'electron');
  let filePath;

  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(electronDir, 'app.html');
  } else {
    const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    filePath = path.join(electronDir, safePath);
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Watcher UI: http://localhost:${PORT}`);
});
