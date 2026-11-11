'use strict';

// Zentrale Fehlerbehandlung. Es werden niemals Anfragedaten geloggt: keine IP, keine URL-Parameter,
// kein Körper, keine Header und auch keine Fehlermeldungstexte (sie könnten Eingaben enthalten,
// z. B. bei JSON-Fehlern). Geloggt werden nur Fehlertyp, Code und Stackframes.

const { HttpError, sendHtml, sendText } = require('./respond');
const views = require('../views/errors');

function logError(err) {
  const name = (err && err.name) || 'Error';
  const code = err && err.code ? ` (${String(err.code).slice(0, 40)})` : '';
  const frames = String((err && err.stack) || '')
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, 8)
    .join('\n');
  process.stderr.write(`[fehler] ${name}${code}\n${frames}\n`);
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}

/** Beantwortet einen Fehler. Nie mit Anfragedaten im Log. */
function handleError(err, req, res) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) logError(err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Antworten auf Fehler nie mit Cookies aus einem halbfertigen Handler ausliefern.
  if (!req.path || !req.path.startsWith('/admin')) res.removeHeader('Set-Cookie');
  res.removeHeader('Content-Disposition');
  res.setHeader('Cache-Control', 'no-store');
  const message = err instanceof HttpError ? err.userMessage : '';
  if (status === 413 || status === 415) res.setHeader('Connection', 'close');
  if (!wantsHtml(req)) {
    sendText(res, status, message || (status >= 500 ? 'Interner Fehler' : 'Fehler'));
    return;
  }
  const admin = req.admin ? req : null;
  if (status >= 500) sendHtml(res, status, views.serverErrorPage(admin));
  else if (status === 404) sendHtml(res, 404, views.notFoundPage(admin));
  else sendHtml(res, status, views.errorPage(status, message, admin));
}

module.exports = { handleError, logError };
