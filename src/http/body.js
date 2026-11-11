'use strict';

// Body-Parser: application/x-www-form-urlencoded (wiederholte Schlüssel → Array) und kleines JSON.
// Standardlimit 256 KB (SPEC §7). Inhalte werden nie geloggt.

const { HttpError } = require('./respond');

const DEFAULT_LIMIT = 256 * 1024;
const JSON_LIMIT = 64 * 1024;

/** Liest den Rohkörper. Wirft HttpError(413) bei Überschreitung des Limits. */
function readBody(req, limit = DEFAULT_LIMIT) {
  if (req.rawBody) return Promise.resolve(req.rawBody);
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'Die gesendeten Daten sind zu groß.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.resume();
        reject(new HttpError(413, 'Die gesendeten Daten sind zu groß.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      resolve(req.rawBody);
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * Zerlegt einen urlencoded-Text. Einzelner Schlüssel → String, wiederholter Schlüssel → Array.
 * Das Ergebnis hat keinen Prototyp (kein __proto__-Problem).
 */
function parseUrlEncoded(text) {
  const out = Object.create(null);
  const params = new URLSearchParams(text);
  for (const [key, value] of params) {
    if (key in out) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function contentType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/**
 * Liest ein Formular (urlencoded). Ergebnis wird in req.body zwischengespeichert.
 * @returns {Promise<Record<string, string|string[]>>}
 */
async function readForm(req, { limit = DEFAULT_LIMIT } = {}) {
  if (req.body) return req.body;
  const type = contentType(req);
  const buf = await readBody(req, limit);
  if (buf.length === 0) {
    req.body = Object.create(null);
    return req.body;
  }
  if (type !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, 'Dieses Datenformat wird nicht unterstützt.');
  }
  req.body = parseUrlEncoded(buf.toString('utf8'));
  return req.body;
}

/** Liest einen kleinen JSON-Körper. */
async function readJson(req, { limit = JSON_LIMIT } = {}) {
  if (contentType(req) !== 'application/json') throw new HttpError(415, 'JSON erwartet.');
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'Ungültiges JSON.');
  }
}

/** Wert als Array (für Mehrfachauswahl): undefined → [], 'a' → ['a']. */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Wert als einzelner String (bei Array der letzte Eintrag), Standard ''. */
function asString(value) {
  if (Array.isArray(value)) return String(value[value.length - 1] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

module.exports = { DEFAULT_LIMIT, readBody, readForm, readJson, parseUrlEncoded, asArray, asString };
