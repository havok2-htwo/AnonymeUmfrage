'use strict';

// Cookie-Helfer. Cookies gibt es nur unter /admin (SPEC §3 Regel 9).

function parseCookies(req) {
  const out = Object.create(null);
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Baut einen Set-Cookie-Wert.
 * @param {object} opts { maxAge (Sekunden), path, httpOnly, secure, sameSite }
 */
function serializeCookie(name, value, opts = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Ungültiger Cookie-Name.');
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    if (opts.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  parts.push(`Path=${opts.path || '/admin'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Strict'}`);
  return parts.join('; ');
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : [prev]), cookie]);
}

function setCookie(res, name, value, opts) {
  appendSetCookie(res, serializeCookie(name, value, opts));
}

function clearCookie(res, name, opts = {}) {
  appendSetCookie(res, serializeCookie(name, '', { ...opts, maxAge: 0 }));
}

module.exports = { parseCookies, serializeCookie, setCookie, clearCookie };
