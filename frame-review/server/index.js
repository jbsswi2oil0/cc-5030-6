'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveMediaFile(req, res, media) {
  const filePath = store.mediaFilePath(media);
  const stat = fs.statSync(filePath);
  const ext = path.extname(media.storageFile).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    let start = m[1] === '' ? 0 : Number(m[1]);
    let end = m[2] === '' ? stat.size - 1 : Number(m[2]);
    if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        out.destroy();
        fs.unlink(tmp, () => {});
        reject(new Error('upload too large'));
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve(tmp));
    out.on('error', reject);
    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (process.env.LOG_REQ) console.log(req.method, req.url, 'range=', req.headers.range || '-');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // ---- API ----
    if (parts[0] === 'api') {
      if (req.method === 'POST' && parts[1] === 'test' && parts[2] === 'reset' && process.env.ALLOW_TEST_RESET === '1') {
        const dataDir = path.join(__dirname, '..', 'data');
        const mediaDir = path.join(dataDir, 'media');
        fs.rmSync(mediaDir, { recursive: true, force: true });
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.rmSync(path.join(dataDir, 'db.json'), { force: true });
        store.resetForTests();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && parts[1] === 'media' && parts.length === 2) {
        return sendJson(res, 200, { media: store.listMedia() });
      }

      if (req.method === 'PUT' && parts[1] === 'media' && parts.length === 2) {
        const name = url.searchParams.get('name') || 'clip.mp4';
        const tmp = await readRawBody(req);
        const { media, reUpload } = store.ingestMedia(name, tmp);
        return sendJson(res, 200, { media: store.publicMedia(media), reUpload });
      }

      if (parts[1] === 'media' && parts[2]) {
        const media = store.getMedia(parts[2]);
        if (!media) return sendJson(res, 404, { error: 'unknown media' });

        if (req.method === 'GET' && parts.length === 3) {
          return sendJson(res, 200, { media: store.publicMedia(media) });
        }
        if (req.method === 'GET' && parts[3] === 'file') {
          return serveMediaFile(req, res, media);
        }
        if (req.method === 'GET' && parts[3] === 'annotations') {
          return sendJson(res, 200, { annotations: store.listAnnotations(parts[2]) });
        }
        if (req.method === 'POST' && parts[3] === 'annotations') {
          const body = await readJsonBody(req);
          const annotation = store.addAnnotation(parts[2], body);
          return sendJson(res, 200, { annotation });
        }
      }

      if (req.method === 'GET' && parts[1] === 'annotations') {
        return sendJson(res, 200, { annotations: store.listAllAnnotations() });
      }

      return sendJson(res, 404, { error: 'unknown api route' });
    }

    // ---- static ----
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`frame-review server listening on http://localhost:${PORT}`);
});

module.exports = server;
