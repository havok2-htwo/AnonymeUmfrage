'use strict';

// Auslieferung statischer Dateien aus public/.
// Links mit ?v=<version> (siehe views/layout.js asset()) werden ein Jahr gecacht, sonst eine Stunde.

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Erzeugt einen Handler, der Dateien aus `rootDir` ausliefert.
 * @returns {(req, res) => boolean} true, wenn die Anfrage beantwortet wurde
 */
function createStatic(rootDir) {
  const root = path.resolve(rootDir);

  return function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return false;
    }
    if (rel.includes('\0') || rel.endsWith('/')) return false;
    const file = path.resolve(root, `.${path.posix.normalize(rel)}`);
    if (file !== root && !file.startsWith(root + path.sep)) return false;
    // Keine versteckten Dateien ausliefern.
    if (path.relative(root, file).split(path.sep).some((seg) => seg.startsWith('.'))) return false;

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const versioned = req.query && typeof req.query.v === 'string' && req.query.v.length > 0;
    res.setHeader('Content-Type', mimeType(file));
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
    return true;
  };
}

module.exports = { createStatic, mimeType, MIME };
