'use strict';

// Konfiguration aus Umgebungsvariablen (SPEC §9).
// loadConfig() liest standardmäßig process.env; Tests übergeben ein eigenes Objekt.

const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'ja', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'nein', 'off'].includes(v)) return false;
  return fallback;
}

function parseIntSafe(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

function loadConfig(env = process.env) {
  const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR || './data');
  const publicUrl = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

  const cookieSecureRaw = String(env.COOKIE_SECURE || 'auto').trim().toLowerCase();
  const cookieSecure = cookieSecureRaw === 'auto'
    ? publicUrl.toLowerCase().startsWith('https://')
    : parseBool(cookieSecureRaw, false);

  return Object.freeze({
    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, 'public'),
    port: parseIntSafe(env.PORT, 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'umfrage.db'),
    publicUrl,
    cookieSecure,
    trustProxy: parseBool(env.TRUST_PROXY, false),
    repo: env.REPO || 'havok2-htwo/AnonymeUmfrage',
    integrityCheck: parseBool(env.INTEGRITY_CHECK, true),
    adminUser: env.ADMIN_USER || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionHours: parseIntSafe(env.SESSION_HOURS, 12, 1, 24 * 30),
  });
}

module.exports = { loadConfig, ROOT_DIR };
