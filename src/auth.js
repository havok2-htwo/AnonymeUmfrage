'use strict';

// Adminsicherheit (SPEC §10): scrypt-Passwörter, Sitzungen mit CSRF-Token, Login-Bremse im Speicher.
// Es werden keine IP-Adressen gespeichert.

const crypto = require('node:crypto');
const { nowIso, nowSec } = require('./db');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, saltBytes: 16 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1024;
const SESSION_COOKIE = 'sid';

const LOGIN_FAILED_MESSAGE = 'Benutzername oder Passwort ist falsch.';
const LOGIN_LOCKED_MESSAGE = 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.';

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// ---------------------------------------------------------------------------
// Passwörter
// ---------------------------------------------------------------------------

/** Liefert eine Fehlermeldung oder null, wenn das Passwort zulässig ist. */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'Das Passwort ist zu lang.';
  return null;
}

/** Hash im Format scrypt$N$r$p$salt_b64$hash_b64. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync(String(password).normalize('NFC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Prüft ein Passwort gegen einen gespeicherten Hash (zeitkonstant). */
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;
  let key;
  try {
    key = await scryptAsync(String(password).normalize('NFC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Für unbekannte Benutzer wird gegen diesen Hash geprüft, damit die Antwortzeit gleich bleibt.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validateUsername(username) {
  const u = normalizeUsername(username);
  if (u.length < 2 || u.length > 64) return 'Der Benutzername muss 2 bis 64 Zeichen lang sein.';
  if (!/^[\p{L}\p{N}._@-]+$/u.test(u)) {
    return 'Der Benutzername darf nur Buchstaben, Ziffern und . _ @ - enthalten.';
  }
  return null;
}

function countAdmins(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

function listAdmins(db) {
  return db.prepare('SELECT id, username, display_name, created_at FROM admins ORDER BY username').all();
}

function getAdminById(db, id) {
  return db.prepare('SELECT id, username, display_name, created_at FROM admins WHERE id = ?').get(id) || null;
}

function getAdminByUsername(db, username) {
  return db.prepare('SELECT id, username, display_name, created_at FROM admins WHERE username = ?')
    .get(normalizeUsername(username)) || null;
}

/** Fehler mit deutscher, anzeigbarer Meldung (err.userMessage). */
class AuthError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.name = 'AuthError';
    this.userMessage = userMessage;
  }
}

/**
 * Legt einen Admin an. Wirft AuthError bei ungültigen Daten oder vergebenem Namen.
 * @returns {Promise<number>} neue Admin-ID
 */
async function createAdmin(db, { username, displayName, password }) {
  const u = normalizeUsername(username);
  const userErr = validateUsername(u);
  if (userErr) throw new AuthError(userErr);
  const pwErr = validatePassword(password);
  if (pwErr) throw new AuthError(pwErr);
  const name = String(displayName || '').trim() || u;
  if (name.length > 100) throw new AuthError('Der Anzeigename ist zu lang.');
  if (getAdminByUsername(db, u)) throw new AuthError('Dieser Benutzername ist bereits vergeben.');
  const hash = await hashPassword(password);
  const info = db.prepare('INSERT INTO admins (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(u, name, hash, nowIso());
  return Number(info.lastInsertRowid);
}

/** Setzt ein neues Passwort und beendet alle Sitzungen dieses Admins. */
async function setPassword(db, adminId, password) {
  const pwErr = validatePassword(password);
  if (pwErr) throw new AuthError(pwErr);
  const hash = await hashPassword(password);
  const info = db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, adminId);
  if (info.changes === 0) throw new AuthError('Admin nicht gefunden.');
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
}

/** Löscht einen Admin (Sitzungen per ON DELETE CASCADE). */
function deleteAdmin(db, adminId) {
  return db.prepare('DELETE FROM admins WHERE id = ?').run(adminId).changes > 0;
}

// ---------------------------------------------------------------------------
// Login-Bremse (nur im Speicher, ohne IP-Adressen)
// ---------------------------------------------------------------------------

function createThrottle({
  maxPerUser = 5, lockMs = 15 * 60 * 1000, maxGlobalPerMinute = 30, maxInFlight = 4, now = () => Date.now(),
} = {}) {
  // username (klein) -> { failures, lockedUntil, last, pending }
  // pending zählt laufende Prüfungen. Sie werden vor dem (asynchronen) scrypt reserviert, damit
  // parallele Anfragen die Grenzen nicht umgehen können.
  const users = new Map();
  let globalFailures = []; // Zeitstempel der Fehlversuche der letzten Minute
  let globalPending = 0;

  function prune(t) {
    globalFailures = globalFailures.filter((ts) => t - ts < 60 * 1000);
    if (users.size > 10000) {
      for (const [k, v] of users) {
        if (!v.pending && v.lockedUntil < t && t - v.last > lockMs) users.delete(k);
      }
    }
  }

  /** Fehlversuche, die noch zählen (eine abgelaufene Sperre setzt sie zurück). */
  function activeFailures(entry, t) {
    if (!entry) return 0;
    if (entry.lockedUntil && entry.lockedUntil <= t) return 0;
    return entry.failures;
  }

  function blocked(key, t) {
    prune(t);
    if (globalFailures.length + globalPending >= maxGlobalPerMinute) return true;
    const entry = users.get(key);
    if (!entry) return false;
    if (entry.lockedUntil > t) return true;
    return activeFailures(entry, t) + (entry.pending || 0) >= maxPerUser;
  }

  function recordFailure(username) {
    const t = now();
    globalFailures.push(t);
    const key = String(username).toLowerCase();
    const entry = users.get(key) || { failures: 0, lockedUntil: 0, last: t, pending: 0 };
    if (entry.lockedUntil && entry.lockedUntil <= t) { entry.failures = 0; entry.lockedUntil = 0; }
    entry.failures += 1;
    entry.last = t;
    if (entry.failures >= maxPerUser) entry.lockedUntil = t + lockMs;
    users.set(key, entry);
  }

  function recordSuccess(username) {
    const key = String(username).toLowerCase();
    const entry = users.get(key);
    if (!entry) return;
    if (entry.pending) { entry.failures = 0; entry.lockedUntil = 0; } else users.delete(key);
  }

  return {
    /** true, wenn für diesen Namen gerade kein Versuch erlaubt ist (laufende Prüfungen zählen mit). */
    isBlocked(username) {
      return blocked(String(username).toLowerCase(), now());
    },
    /**
     * Reserviert synchron einen Versuch, bevor das Passwort geprüft wird. false = abgelehnt (gesperrt
     * oder schon zu viele Prüfungen gleichzeitig). Nach true muss end() aufgerufen werden.
     */
    begin(username) {
      const key = String(username).toLowerCase();
      const t = now();
      if (globalPending >= maxInFlight || blocked(key, t)) return false;
      const entry = users.get(key) || { failures: 0, lockedUntil: 0, last: t, pending: 0 };
      entry.pending = (entry.pending || 0) + 1;
      entry.last = t;
      users.set(key, entry);
      globalPending += 1;
      return true;
    },
    /** Gibt die Reservierung frei und verbucht Erfolg oder Fehlversuch. */
    end(username, ok) {
      const key = String(username).toLowerCase();
      const entry = users.get(key);
      if (entry && entry.pending) entry.pending -= 1;
      if (globalPending > 0) globalPending -= 1;
      if (ok) recordSuccess(username);
      else recordFailure(username);
      const after = users.get(key);
      if (after && !after.pending && !after.failures && !after.lockedUntil) users.delete(key);
    },
    recordFailure,
    recordSuccess,
    reset() {
      users.clear();
      globalFailures = [];
      globalPending = 0;
    },
  };
}

const defaultThrottle = createThrottle();

/**
 * Prüft Benutzername und Passwort.
 * Der Versuch wird vor dem scrypt-Aufruf reserviert (throttle.begin), damit parallele Anfragen die
 * Login-Bremse nicht umgehen (SPEC §10).
 * @returns {Promise<{ok:true, admin:object} | {ok:false, error:string, locked:boolean}>}
 */
async function verifyLogin(db, username, password, throttle = defaultThrottle) {
  const u = normalizeUsername(username).slice(0, 64);
  if (!throttle.begin(u)) return { ok: false, error: LOGIN_LOCKED_MESSAGE, locked: true };
  let ok = false;
  try {
    const row = u ? db.prepare('SELECT id, username, display_name, password_hash FROM admins WHERE username = ?').get(u) : null;
    const pw = typeof password === 'string' ? password.slice(0, MAX_PASSWORD_LENGTH) : '';
    const match = await verifyPassword(pw, row ? row.password_hash : await dummyHash());
    if (!row || !match) return { ok: false, error: LOGIN_FAILED_MESSAGE, locked: false };
    ok = true;
    return { ok: true, admin: { id: row.id, username: row.username, display_name: row.display_name } };
  } finally {
    throttle.end(u, ok);
  }
}

// ---------------------------------------------------------------------------
// Sitzungen
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Neue Sitzung. Das Token steht nur im Cookie, in der DB liegt sein sha256-Hash.
 * @returns {{token:string, csrf:string, expiresAt:number}}
 */
function createSession(db, adminId, hours = 12) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expiresAt = nowSec() + Math.round(hours * 3600);
  db.prepare('INSERT INTO sessions (token_hash, admin_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), adminId, csrf, expiresAt);
  return { token, csrf, expiresAt };
}

/**
 * Sucht die Sitzung zum Token.
 * @returns {{tokenHash:string, csrf:string, expiresAt:number, admin:{id,username,display_name}} | null}
 */
function getSession(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db.prepare(`
    SELECT s.token_hash, s.csrf, s.expires_at, a.id, a.username, a.display_name
    FROM sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at <= nowSec()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return {
    tokenHash: row.token_hash,
    csrf: row.csrf,
    expiresAt: row.expires_at,
    admin: { id: row.id, username: row.username, display_name: row.display_name },
  };
}

function destroySession(db, token) {
  if (typeof token !== 'string' || !token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Löscht abgelaufene Sitzungen. @returns {number} Anzahl gelöschter Zeilen */
function cleanupSessions(db) {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSec()).changes);
}

/** Zeitkonstanter Vergleich zweier Texte (z. B. CSRF-Token). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  SESSION_COOKIE,
  MIN_PASSWORD_LENGTH,
  LOGIN_FAILED_MESSAGE,
  LOGIN_LOCKED_MESSAGE,
  AuthError,
  validatePassword,
  validateUsername,
  hashPassword,
  verifyPassword,
  countAdmins,
  listAdmins,
  getAdminById,
  getAdminByUsername,
  createAdmin,
  setPassword,
  deleteAdmin,
  createThrottle,
  defaultThrottle,
  verifyLogin,
  createSession,
  getSession,
  destroySession,
  cleanupSessions,
  safeEqual,
};
