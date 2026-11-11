'use strict';

// Antwort-Helfer und HttpError.

/** Fehler mit HTTP-Status und optionaler, anzeigbarer deutscher Meldung. */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} [userMessage] wird dem Nutzer angezeigt (keine Anfragedaten hineinschreiben)
   */
  constructor(status, userMessage) {
    super(userMessage || `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.userMessage = userMessage || '';
  }
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buf.length);
  if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(buf);
}

function sendHtml(res, status, htmlString, headers) {
  send(res, status, String(htmlString), 'text/html; charset=utf-8', headers);
}

function sendText(res, status, text, headers) {
  send(res, status, text, 'text/plain; charset=utf-8', headers);
}

function sendJson(res, status, data, headers) {
  send(res, status, `${JSON.stringify(data, null, 2)}\n`, 'application/json; charset=utf-8', headers);
}

/** Weiterleitung, Standard 303 (nach POST). Nur relative Ziele innerhalb der Anwendung. */
function redirect(res, location, status = 303) {
  if (res.headersSent) return;
  const target = String(location);
  if (!target.startsWith('/') || target.startsWith('//')) throw new Error('redirect(): nur interne Pfade erlaubt.');
  res.statusCode = status;
  res.setHeader('Location', target);
  res.setHeader('Content-Length', 0);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Basis-URL für angezeigte Links: PUBLIC_URL, sonst aus Host-Header
 * (X-Forwarded-Proto nur mit TRUST_PROXY).
 */
function baseUrl(req, config) {
  if (config.publicUrl) return config.publicUrl;
  let proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (fwd === 'https' || fwd === 'http') proto = fwd;
  }
  const host = String(req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:[\]-]/g, '');
  return `${proto}://${host}`;
}

module.exports = { HttpError, send, sendHtml, sendText, sendJson, redirect, baseUrl };
