'use strict';

// Datenbank: Schema, Migration und allgemeine Hilfsfunktionen (SPEC §4, §3 Regel 13).
// Fachliche Zugriffsfunktionen liegen in surveys.js / results.js und nutzen diese Helfer.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  thanks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','open','closed')),
  min_responses INTEGER NOT NULL DEFAULT 3 CHECK (min_responses >= 2),
  closes_at INTEGER,
  response_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','longtext','scale','single','multi')),
  title TEXT NOT NULL,
  help TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS questions_survey ON questions(survey_id, position);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS answers_question ON answers(question_id);
`;

// Pro Datenbankverbindung: aktuelle Verschachtelungstiefe von transaction().
const txDepth = new WeakMap();

function applyPragmas(db) {
  // Regel 13: kein WAL (würde Reihenfolge in der -wal-Datei konservieren), gelöschte Daten überschreiben.
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec('PRAGMA secure_delete = ON;');
  // VACUUM baut die Datei in einer temporären Datenbank neu auf. Die liegt sonst im Temp-Verzeichnis (im
  // Container im Overlay-Dateisystem) und wäre als gelöschte Datei eine zweite Kopie der Antworten.
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
}

function migrate(db) {
  db.exec(SCHEMA_V1);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Datenbank hat Schema-Version ${current}, diese Programmversion kennt nur ${SCHEMA_VERSION}.`);
  }
  // Schema 2: Admins können zum Passwortwechsel gezwungen werden (Standardzugang admin/admin).
  const adminCols = db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
  if (!adminCols.includes('must_change_password')) {
    db.exec('ALTER TABLE admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
  // Künftige Migrationen: if (current < 3) { … } usw.
  if (current !== SCHEMA_VERSION) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(SCHEMA_VERSION));
  }
}

/**
 * Öffnet (oder erstellt) die Datenbank. `file` = Pfad oder ':memory:'.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  applyPragmas(db);
  migrate(db);
  return db;
}

/**
 * Führt fn(db) in einer Transaktion aus. Wirft fn, wird alles zurückgerollt.
 * Verschachtelte Aufrufe nutzen SAVEPOINTs. fn muss synchron sein (DatabaseSync).
 */
function transaction(db, fn) {
  const depth = txDepth.get(db) || 0;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn(db);
    if (result && typeof result.then === 'function') {
      throw new Error('transaction(): fn darf kein Promise zurückgeben.');
    }
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    } catch { /* Rollback-Fehler verdecken nicht den eigentlichen Fehler */ }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

/**
 * Schreibt die Datenbank neu (SPEC §3 Regel 13: nach jeder Teilnahme aufrufen).
 * Darf nicht innerhalb einer Transaktion laufen.
 */
function vacuum(db) {
  if ((txDepth.get(db) || 0) > 0) throw new Error('vacuum() innerhalb einer Transaktion ist nicht möglich.');
  db.exec('VACUUM');
}

/** Läuft gerade eine Transaktion über transaction()? */
function inTransaction(db) {
  return (txDepth.get(db) || 0) > 0;
}

/** Aktueller Zeitpunkt als ISO-Text (für created_at, opened_at, closed_at). */
function nowIso() {
  return new Date().toISOString();
}

/** Aktuelle Unix-Sekunden. */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

module.exports = { openDatabase, transaction, inTransaction, vacuum, nowIso, nowSec, SCHEMA_VERSION };
