'use strict';

// Fachlogik für Umfragen, Fragen und Teilnahmen (SPEC §3, §4, §5).
//
// Anonymität (SPEC §3):
// - submitResponse() speichert jede Antwort als eigene Zeile mit crypto.randomUUID() in `answers`
//   (WITHOUT ROWID). Es gibt keine Spalte, die Antworten derselben Teilnahme verbindet.
// - Zähler response_count statt Teilnahmeliste; Antworten + Zähler in EINER Transaktion.
// - Mehrfachauswahl: eine Zeile pro Option plus eine Markerzeile mit value = ''.
// - Nach jeder Teilnahme VACUUM (Datensätze liegen danach nach zufälliger ID geordnet). Schlägt es
//   fehl, wird es beim Schließen, beim Start und im Minuten-Takt nachgeholt (vacuumSafely).
// - Leere Teilnahmen (keine einzige Antwort) werden abgelehnt.
// - Es wird nichts geloggt: keine Anfragedaten, keine Antworten.
//
// Schnittstelle für die Auswertung (src/results.js, src/pdf.js):
//   getSurvey(db, id)               Zeile aus `surveys` (snake_case) oder null
//   getQuestions(db, surveyId)      Fragen nach position, `config` als Objekt
//   getAnswersByQuestion(db, qid)   string[] – alle gespeicherten Werte dieser Frage, roh
//                                   (bei multi inklusive der Markerzeilen '' – SPEC §4)
//   resultsAvailable(survey)        { ok, reason } – reason deutsch, leer bei ok

const crypto = require('node:crypto');
const { transaction, inTransaction, vacuum, nowIso, nowSec } = require('./db');
const { asArray, asString } = require('./http/body');

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const TYPES = ['text', 'longtext', 'scale', 'single', 'multi'];

const TYPE_LABELS = {
  text: 'Kurzer Text',
  longtext: 'Langer Text',
  scale: 'Skala',
  single: 'Einfachauswahl',
  multi: 'Mehrfachauswahl',
};

const STATUS_LABELS = { draft: 'Entwurf', open: 'Offen', closed: 'Geschlossen' };

const LIMITS = {
  surveyTitle: 200,
  intro: 5000,
  thanks: 2000,
  questionTitle: 500,
  help: 1000,
  optionLabel: 200,
  scaleLabel: 100,
  minOptions: 2,
  maxOptions: 30,
  maxQuestions: 200,
  minResponses: 2,
  maxMinResponses: 1000,
};

const TEXT_DEFAULTS = { text: 500, longtext: 5000 };
const TEXT_MAX = { text: 1000, longtext: 10000 };

const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;
const TZ = 'Europe/Berlin';

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

/** Fachlicher Fehler mit anzeigbarer deutscher Meldung (z. B. „nur im Entwurf möglich“). */
class SurveyError extends Error {
  constructor(userMessage, status = 409) {
    super(userMessage);
    this.name = 'SurveyError';
    this.userMessage = userMessage;
    this.status = status;
  }
}

/** Validierungsfehler: errors = { feld: 'Meldung' }, values = eingegebene Werte zum Wiederanzeigen. */
class ValidationError extends Error {
  constructor(errors, values) {
    super('Validierung fehlgeschlagen');
    this.name = 'ValidationError';
    this.errors = errors;
    this.values = values;
  }
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

/** Text bereinigen: Zeilenenden vereinheitlichen, Steuerzeichen außer \n und \t entfernen, trimmen. */
function cleanText(value, { multiline = true } = {}) {
  let s = asString(value).normalize('NFC').replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (!multiline) s = s.replace(/[\n\t]+/g, ' ');
  return s.trim();
}

/** Fisher-Yates mit crypto.randomInt (gibt eine neue, gemischte Liste zurück). */
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newSlug() {
  return crypto.randomBytes(16).toString('base64url');
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford-Base32, ohne I, L, O, U

/**
 * Kurzer, vergleichbarer Code einer Umfrage, z. B. „7K3M-Q9TD-4WXA“ (60 Bit aus sha256 des Slugs).
 * Teilnehmende vergleichen ihn untereinander: Wer einen anderen Code sieht, hat einen eigenen Link
 * bekommen. Der Code verrät den Slug nicht, und wer die Umfrage verwaltet, kann ihn nicht wählen. 60 Bit,
 * damit sich auch durch massenhaftes Anlegen kein Paar von Umfragen mit gleichem Code finden lässt
 * (Geburtstagsschranke etwa 2^30 Umfragen).
 */
function surveyCode(slug) {
  const digest = crypto.createHash('sha256').update(`anonyme-umfrage:code:${String(slug || '')}`).digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      bits -= 5;
      out += CODE_ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
    if (out.length === 12) break;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

function newOptionId(taken) {
  for (;;) {
    const id = crypto.randomBytes(3).toString('hex');
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function parseConfig(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function toInt(value) {
  const s = asString(value).trim();
  return /^-?\d{1,9}$/.test(s) ? Number(s) : NaN;
}

// --- Zeitzone: datetime-local-Felder werden als Uhrzeit in Europe/Berlin verstanden ---------------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function berlinParts(ms) {
  const out = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) out[p.type] = Number(p.value);
  return out;
}

function berlinOffsetMs(ms) {
  const p = berlinParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** 'YYYY-MM-DDTHH:MM' (Ortszeit Berlin) → Unix-Sekunden, NaN bei ungültiger Eingabe. */
function parseLocalDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(asString(value).trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x || 0));
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
    || h > 23 || mi > 59 || s > 59) return NaN;
  let guess = naive - berlinOffsetMs(naive);
  guess = naive - berlinOffsetMs(guess);
  return Math.floor(guess / 1000);
}

/** Unix-Sekunden → 'YYYY-MM-DDTHH:MM' in Berlin (für value von datetime-local). */
function formatLocalDateTime(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  const p = berlinParts(Number(sec) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// ---------------------------------------------------------------------------
// Automatisches Schließen
// ---------------------------------------------------------------------------

const CLOSE_DUE_SQL = "UPDATE surveys SET status = 'closed', "
  + "closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', closes_at, 'unixepoch') "
  + "WHERE status = 'open' AND closes_at IS NOT NULL AND closes_at <= ?";

// Antworten geschlossener Umfragen unter der Mindestzahl sind nie mehr abrufbar (Schließen ist endgültig).
// Gerade sie wären aus der Datei am leichtesten einer Person zuzuordnen; deshalb werden sie gelöscht.
// Der Zähler bleibt als Information erhalten.
const PURGE_UNDER_MIN_SQL = 'DELETE FROM answers WHERE question_id IN ('
  + 'SELECT q.id FROM questions q JOIN surveys s ON s.id = q.survey_id '
  + "WHERE s.status = 'closed' AND s.response_count < s.min_responses)";

/** Löscht die Antworten aller geschlossenen Umfragen unter der Mindestzahl. Gibt die Zahl der Zeilen zurück. */
function purgeUnderMinimum(db) {
  return Number(db.prepare(PURGE_UNDER_MIN_SQL).run().changes);
}

/**
 * Löschen ohne Ausnahme nach außen: Schlägt es fehl (volle Platte, fremde Sperre), holen der Minutentakt
 * (startAutoClose) und der Start es nach. Kein Log, denn eine Zeile im Moment des Schließens verriete nichts,
 * eine im Moment einer Teilnahme aber schon.
 */
function purgeSafely(db) {
  try {
    purgeUnderMinimum(db);
  } catch {
    // nachgeholt im Minutentakt
  }
}

// getSurvey() ruft closeIfDue() bei jedem Zugriff auf. Deshalb hier keine Schreibtransaktion auf Verdacht:
// Nur wenn wirklich geschlossen wurde, wird gelöscht. Bricht der Prozess dazwischen ab oder scheitert das
// Löschen, holen Minutentakt und Start (src/server.js) es nach.

/** Schließt alle offenen Umfragen, deren Schließzeitpunkt erreicht ist. Gibt die Anzahl zurück. */
function closeDueSurveys(db, now = nowSec()) {
  const changes = Number(db.prepare(CLOSE_DUE_SQL).run(now).changes);
  if (changes > 0) {
    purgeSafely(db);
    vacuumSafely(db);
  }
  return changes;
}

function closeIfDue(db, id, now = nowSec()) {
  const changes = Number(db.prepare(`${CLOSE_DUE_SQL} AND id = ?`).run(now, id).changes);
  if (changes > 0) {
    purgeSafely(db);
    vacuumSafely(db);
  }
}

// ---------------------------------------------------------------------------
// VACUUM (SPEC §3 Regel 13)
// ---------------------------------------------------------------------------

/** Datenbanken, bei denen ein VACUUM fehlgeschlagen ist und nachgeholt werden muss. */
const vacuumPending = new WeakSet();

/**
 * Schreibt die Datenbank neu. Schlägt das fehl (z. B. SQLITE_BUSY, SQLITE_FULL), wird nur der
 * Fehlercode auf stderr gemeldet (keine Daten) und das VACUUM als ausstehend markiert. Nachgeholt wird
 * bei der nächsten Teilnahme, beim Schließen, beim Start und im Minuten-Takt von startAutoClose().
 * Innerhalb einer Transaktion wird nur vorgemerkt.
 * @returns {boolean} true, wenn das VACUUM gelaufen ist
 */
function vacuumSafely(db) {
  if (inTransaction(db)) {
    vacuumPending.add(db);
    return false;
  }
  try {
    vacuum(db);
    vacuumPending.delete(db);
    return true;
  } catch (err) {
    vacuumPending.add(db);
    const code = String((err && (err.errcode ?? err.code)) || 'unbekannt').replace(/[^A-Za-z0-9_]/g, '');
    process.stderr.write(`[warnung] VACUUM fehlgeschlagen (${code})
`);
    return false;
  }
}

/** Steht ein nachzuholendes VACUUM aus? */
function isVacuumPending(db) {
  return vacuumPending.has(db);
}

/**
 * Startet den Minuten-Takt für das automatische Schließen. Der Timer hält den Prozess nicht am Leben
 * und beendet sich selbst, sobald die Datenbank geschlossen ist.
 */
function startAutoClose(db, intervalMs = 60 * 1000) {
  const timer = setInterval(() => {
    try {
      if (db.isOpen === false) {
        clearInterval(timer);
        return;
      }
      closeDueSurveys(db);
      // Ein fehlgeschlagenes Löschen unter der Mindestzahl nachholen. Ohne Treffer ändert das DELETE nichts.
      if (purgeUnderMinimum(db) > 0) vacuumSafely(db);
      if (vacuumPending.has(db)) vacuumSafely(db);
    } catch {
      // Datenbank geschlossen oder gesperrt: still beenden bzw. beim nächsten Takt erneut versuchen.
      if (db.isOpen === false) clearInterval(timer);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Umfrage nach ID (snake_case-Spalten wie im Schema) oder null. Schließt fällige Umfragen vorher. */
function getSurvey(db, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  closeIfDue(db, n);
  return db.prepare('SELECT * FROM surveys WHERE id = ?').get(n) || null;
}

/** Umfrage nach Slug oder null. Schließt fällige Umfragen vorher. */
function getSurveyBySlug(db, slug) {
  const s = String(slug || '');
  if (!SLUG_RE.test(s)) return null;
  const row = db.prepare('SELECT id FROM surveys WHERE slug = ?').get(s);
  return row ? getSurvey(db, row.id) : null;
}

/** Fragen einer Umfrage in fester Reihenfolge; `config` ist bereits ein Objekt. */
function getQuestions(db, surveyId) {
  return db.prepare('SELECT * FROM questions WHERE survey_id = ? ORDER BY position, id').all(Number(surveyId))
    .map((q) => ({ ...q, required: Number(q.required), config: parseConfig(q.config) }));
}

function getQuestion(db, surveyId, questionId) {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND survey_id = ?').get(Number(questionId), Number(surveyId));
  return q ? { ...q, required: Number(q.required), config: parseConfig(q.config) } : null;
}

/**
 * Alle gespeicherten Werte einer Frage als string[] (Reihenfolge nach zufälliger ID, nicht gemischt –
 * das Mischen ist Aufgabe der Auswertung). Bei multi sind Markerzeilen ('') enthalten.
 */
function getAnswersByQuestion(db, questionId) {
  return db.prepare('SELECT value FROM answers WHERE question_id = ?').all(Number(questionId)).map((r) => String(r.value));
}

/** Liste für die Adminübersicht. */
function listSurveys(db) {
  closeDueSurveys(db);
  return db.prepare(`
    SELECT s.*, a.display_name AS created_by_name,
           (SELECT COUNT(*) FROM questions q WHERE q.survey_id = s.id) AS question_count
    FROM surveys s LEFT JOIN admins a ON a.id = s.created_by
    ORDER BY s.created_at DESC, s.id DESC`).all();
}

/** Dürfen Ergebnisse angezeigt werden? (SPEC §3 Regel 5) */
function resultsAvailable(survey) {
  if (!survey) return { ok: false, reason: 'Die Umfrage gibt es nicht.' };
  if (survey.status === 'draft') {
    return { ok: false, reason: 'Die Umfrage ist noch ein Entwurf. Ergebnisse gibt es erst, wenn sie geöffnet und wieder geschlossen wurde.' };
  }
  if (survey.status === 'open') {
    return { ok: false, reason: 'Die Umfrage ist noch offen. Zum Schutz der Anonymität gibt es Ergebnisse erst nach dem Schließen.' };
  }
  const n = Number(survey.response_count);
  const min = Number(survey.min_responses);
  // Sicher fehlschlagen: Ist min keine ganze Zahl ab der Untergrenze (fehlt, null, Text …), bleibt gesperrt.
  if (survey.min_responses === null || survey.min_responses === undefined
    || !(Number.isInteger(min) && min >= LIMITS.minResponses)) {
    return { ok: false, reason: 'Die Mindestzahl dieser Umfrage ist ungültig. Zum Schutz der Anonymität bleiben die Ergebnisse gesperrt.' };
  }
  if (n === 0) return { ok: false, reason: 'Es gab keine Teilnahmen.' };
  if (n < min) {
    return {
      ok: false,
      reason: `Es liegen ${n} von mindestens ${min} nötigen Teilnahmen vor. Zum Schutz der Anonymität bleiben die Ergebnisse gesperrt; die Antworten wurden beim Schließen gelöscht.`,
    };
  }
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Umfragen anlegen und ändern
// ---------------------------------------------------------------------------

function requireSurvey(db, id) {
  const survey = getSurvey(db, id);
  if (!survey) throw new SurveyError('Die Umfrage gibt es nicht.', 404);
  return survey;
}

function requireDraft(survey) {
  if (survey.status !== 'draft') {
    throw new SurveyError('Das ist nur im Entwurf möglich. Nach dem Öffnen sind die Fragen eingefroren. Wer etwas ändern will, dupliziert die Umfrage.');
  }
}

function validateTitle(title) {
  if (!title) return 'Bitte einen Titel eingeben.';
  if (title.length > LIMITS.surveyTitle) return `Der Titel darf höchstens ${LIMITS.surveyTitle} Zeichen lang sein.`;
  return null;
}

/** Neue Umfrage als Entwurf. @returns {number} ID */
function createSurvey(db, { title, adminId = null }) {
  const t = cleanText(title, { multiline: false });
  const err = validateTitle(t);
  if (err) throw new ValidationError({ title: err }, { title: asString(title) });
  for (let i = 0; i < 5; i += 1) {
    try {
      const info = db.prepare('INSERT INTO surveys (slug, title, status, created_by, created_at) VALUES (?, ?, \'draft\', ?, ?)')
        .run(newSlug(), t, adminId, nowIso());
      return Number(info.lastInsertRowid);
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message)) || i === 4) throw e;
    }
  }
  throw new Error('Kein freier Slug gefunden.');
}

/**
 * Stammdaten aus einem Formular prüfen.
 * Felder: title, intro, thanks, min_responses, closes_at (datetime-local, leer = kein Termin).
 */
function parseSurveyMeta(form, { now = nowSec() } = {}) {
  const values = {
    title: asString(form.title),
    intro: asString(form.intro),
    thanks: asString(form.thanks),
    min_responses: asString(form.min_responses),
    closes_at: asString(form.closes_at),
  };
  const errors = {};
  const data = {
    title: cleanText(values.title, { multiline: false }),
    intro: cleanText(values.intro),
    thanks: cleanText(values.thanks),
  };
  const titleErr = validateTitle(data.title);
  if (titleErr) errors.title = titleErr;
  if (data.intro.length > LIMITS.intro) errors.intro = `Die Einleitung darf höchstens ${LIMITS.intro} Zeichen lang sein.`;
  if (data.thanks.length > LIMITS.thanks) errors.thanks = `Der Dankestext darf höchstens ${LIMITS.thanks} Zeichen lang sein.`;

  const min = toInt(values.min_responses);
  if (!Number.isInteger(min) || min < LIMITS.minResponses || min > LIMITS.maxMinResponses) {
    errors.min_responses = `Bitte eine ganze Zahl von ${LIMITS.minResponses} bis ${LIMITS.maxMinResponses} eingeben.`;
  } else {
    data.min_responses = min;
  }

  const closes = parseClosesAt(values.closes_at, now);
  if (closes.error) errors.closes_at = closes.error;
  else data.closes_at = closes.value;

  return { ok: Object.keys(errors).length === 0, errors, values, data };
}

function parseClosesAt(raw, now = nowSec()) {
  const s = asString(raw).trim();
  if (!s) return { value: null };
  const sec = parseLocalDateTime(s);
  if (!Number.isFinite(sec)) return { error: 'Bitte Datum und Uhrzeit vollständig angeben.' };
  if (sec <= now) return { error: 'Der Zeitpunkt muss in der Zukunft liegen.' };
  return { value: sec };
}

/** Stammdaten speichern (nur Entwurf). Wirft ValidationError bzw. SurveyError. */
function updateSurveyMeta(db, id, form) {
  const survey = requireSurvey(db, id);
  requireDraft(survey);
  const parsed = parseSurveyMeta(form);
  if (!parsed.ok) throw new ValidationError(parsed.errors, parsed.values);
  const d = parsed.data;
  db.prepare('UPDATE surveys SET title = ?, intro = ?, thanks = ?, min_responses = ?, closes_at = ? WHERE id = ? AND status = \'draft\'')
    .run(d.title, d.intro, d.thanks, d.min_responses, d.closes_at, survey.id);
}

/**
 * Schließzeitpunkt einer offenen Umfrage ändern oder entfernen (kein Strukturmerkmal, SPEC §3 Regel 7
 * betrifft nur Fragen, Typen, Optionen, Reihenfolge und Mindestanzahl).
 */
function updateClosesAt(db, id, form) {
  const survey = requireSurvey(db, id);
  if (survey.status === 'closed') throw new SurveyError('Die Umfrage ist bereits geschlossen.');
  const closes = parseClosesAt(form.closes_at);
  if (closes.error) throw new ValidationError({ closes_at: closes.error }, { closes_at: asString(form.closes_at) });
  db.prepare('UPDATE surveys SET closes_at = ? WHERE id = ? AND status != \'closed\'').run(closes.value, survey.id);
}

/** Entwurf → offen. Mindestens eine Frage nötig. */
function openSurvey(db, id) {
  return transaction(db, () => {
    const survey = requireSurvey(db, id);
    if (survey.status === 'open') throw new SurveyError('Die Umfrage ist bereits offen.');
    if (survey.status === 'closed') {
      throw new SurveyError('Eine geschlossene Umfrage kann nicht wieder geöffnet werden. Wer weitermachen will, dupliziert sie.');
    }
    const questions = getQuestions(db, survey.id);
    if (questions.length === 0) throw new SurveyError('Zum Öffnen braucht die Umfrage mindestens eine Frage.');
    for (const q of questions) {
      if ((q.type === 'single' || q.type === 'multi') && (q.config.options || []).length < LIMITS.minOptions) {
        throw new SurveyError(`Frage ${q.position} braucht mindestens ${LIMITS.minOptions} Optionen.`);
      }
    }
    if (survey.closes_at !== null && survey.closes_at <= nowSec()) {
      throw new SurveyError('Der Zeitpunkt für das automatische Schließen liegt in der Vergangenheit. Bitte in den Stammdaten ändern.');
    }
    db.prepare("UPDATE surveys SET status = 'open', opened_at = ?, response_count = 0 WHERE id = ? AND status = 'draft'")
      .run(nowIso(), survey.id);
  });
}

/** Offen → geschlossen (endgültig). */
function closeSurvey(db, id) {
  const survey = requireSurvey(db, id);
  if (survey.status === 'draft') throw new SurveyError('Ein Entwurf kann nicht geschlossen werden.');
  if (survey.status === 'closed') throw new SurveyError('Die Umfrage ist bereits geschlossen.');
  transaction(db, () => {
    db.prepare("UPDATE surveys SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(nowIso(), survey.id);
    purgeUnderMinimum(db);
  });
  vacuumSafely(db); // Regel 13 auch dann sicherstellen, wenn ein VACUUM nach einer Teilnahme fehlschlug
}

/** Kopie als Entwurf: neue Slug, gleiche Fragen, keine Antworten. @returns {number} neue ID */
function duplicateSurvey(db, id, adminId = null) {
  const survey = requireSurvey(db, id);
  return transaction(db, () => {
    const suffix = ' (Kopie)';
    const title = survey.title.length + suffix.length > LIMITS.surveyTitle
      ? survey.title.slice(0, LIMITS.surveyTitle - suffix.length) + suffix
      : survey.title + suffix;
    const info = db.prepare(`INSERT INTO surveys (slug, title, intro, thanks, status, min_responses, created_by, created_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(newSlug(), title, survey.intro, survey.thanks, survey.min_responses, adminId, nowIso());
    const newId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO questions (survey_id, position, type, title, help, required, config) VALUES (?, ?, ?, ?, ?, ?, ?)');
    getQuestions(db, survey.id).forEach((q, i) => {
      insert.run(newId, i + 1, q.type, q.title, q.help, q.required ? 1 : 0, JSON.stringify(q.config));
    });
    return newId;
  });
}

/** Ist die Eingabe eine gültige Löschbestätigung (Titel oder „löschen“)? */
function isDeleteConfirmation(survey, input) {
  const s = cleanText(input, { multiline: false });
  if (!s) return false;
  return s === survey.title.trim() || s.toLocaleLowerCase('de-DE') === 'löschen';
}

/** Löscht eine Umfrage samt Fragen und Antworten und schreibt die Datenbank neu. */
function deleteSurvey(db, id) {
  const survey = requireSurvey(db, id);
  db.prepare('DELETE FROM surveys WHERE id = ?').run(survey.id);
  vacuumSafely(db); // secure_delete hat die Daten bereits überschrieben
}

// ---------------------------------------------------------------------------
// Fragen
// ---------------------------------------------------------------------------

/**
 * Optionen aus Textzeilen (eine pro Zeile) mit stabilen IDs.
 * Zuordnung: 1. gleicher Text → gleiche ID; 2. übrige Zeilen übernehmen die ID der bisherigen Option an
 * derselben Position, falls diese nicht schon vergeben wurde (= Umbenennen); 3. sonst neue Zufalls-ID.
 */
function assignOptionIds(labels, previous = []) {
  const prev = Array.isArray(previous) ? previous.filter((o) => o && typeof o.id === 'string') : [];
  const used = new Set();
  const taken = new Set(prev.map((o) => o.id));
  const result = labels.map((label) => ({ id: null, label }));
  for (const item of result) {
    const match = prev.find((o) => o.label === item.label && !used.has(o.id));
    if (match) {
      item.id = match.id;
      used.add(match.id);
    }
  }
  result.forEach((item, i) => {
    if (item.id) return;
    const atPos = prev[i];
    if (atPos && !used.has(atPos.id)) {
      item.id = atPos.id;
      used.add(atPos.id);
    }
  });
  for (const item of result) {
    if (!item.id) {
      item.id = newOptionId(taken);
      used.add(item.id);
    }
  }
  return result;
}

/**
 * Fragenformular prüfen. Felder: type, title, help, required, maxLength, scaleMin, scaleMax, minLabel,
 * maxLabel, options (eine Option pro Zeile), maxChoices.
 * @param {object} form
 * @param {object|null} existing  bisherige Frage (für stabile Option-IDs)
 */
function parseQuestionForm(form, existing = null) {
  const values = {
    type: asString(form.type),
    title: asString(form.title),
    help: asString(form.help),
    required: asString(form.required) === '1',
    maxLength: asString(form.maxLength),
    scaleMin: asString(form.scaleMin),
    scaleMax: asString(form.scaleMax),
    minLabel: asString(form.minLabel),
    maxLabel: asString(form.maxLabel),
    options: asString(form.options),
    maxChoices: asString(form.maxChoices),
  };
  const errors = {};
  const type = TYPES.includes(values.type) ? values.type : null;
  if (!type) errors.type = 'Bitte einen Fragetyp wählen.';

  const title = cleanText(values.title, { multiline: false });
  if (!title) errors.title = 'Bitte die Frage eingeben.';
  else if (title.length > LIMITS.questionTitle) errors.title = `Die Frage darf höchstens ${LIMITS.questionTitle} Zeichen lang sein.`;

  const help = cleanText(values.help);
  if (help.length > LIMITS.help) errors.help = `Der Hilfetext darf höchstens ${LIMITS.help} Zeichen lang sein.`;

  let config = {};
  if (type === 'text' || type === 'longtext') {
    const raw = values.maxLength.trim();
    let maxLength = TEXT_DEFAULTS[type];
    if (raw) {
      const n = toInt(raw);
      if (!Number.isInteger(n) || n < 1 || n > TEXT_MAX[type]) {
        errors.maxLength = `Bitte eine ganze Zahl von 1 bis ${TEXT_MAX[type]} eingeben oder leer lassen.`;
      } else {
        maxLength = n;
      }
    }
    config = { maxLength };
  } else if (type === 'scale') {
    const min = values.scaleMin.trim() === '' ? 1 : toInt(values.scaleMin);
    const max = values.scaleMax.trim() === '' ? 10 : toInt(values.scaleMax);
    if (min !== 0 && min !== 1) errors.scaleMin = 'Der kleinste Wert ist 0 oder 1.';
    if (!Number.isInteger(max) || max < 2 || max > 10) errors.scaleMax = 'Der größte Wert liegt zwischen 2 und 10.';
    const minLabel = cleanText(values.minLabel, { multiline: false });
    const maxLabel = cleanText(values.maxLabel, { multiline: false });
    if (minLabel.length > LIMITS.scaleLabel) errors.minLabel = `Höchstens ${LIMITS.scaleLabel} Zeichen.`;
    if (maxLabel.length > LIMITS.scaleLabel) errors.maxLabel = `Höchstens ${LIMITS.scaleLabel} Zeichen.`;
    config = { min, max, minLabel, maxLabel };
  } else if (type === 'single' || type === 'multi') {
    const labels = values.options.split(/\r?\n|\r/).map((l) => cleanText(l, { multiline: false })).filter(Boolean);
    const seen = new Set();
    const dupes = labels.filter((l) => {
      const key = l.toLocaleLowerCase('de-DE');
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (labels.length < LIMITS.minOptions) errors.options = `Bitte mindestens ${LIMITS.minOptions} Optionen eingeben (eine pro Zeile).`;
    else if (labels.length > LIMITS.maxOptions) errors.options = `Höchstens ${LIMITS.maxOptions} Optionen.`;
    else if (dupes.length) errors.options = 'Jede Option darf nur einmal vorkommen.';
    else if (labels.some((l) => l.length > LIMITS.optionLabel)) errors.options = `Eine Option darf höchstens ${LIMITS.optionLabel} Zeichen lang sein.`;
    const previous = existing && existing.config && Array.isArray(existing.config.options) ? existing.config.options : [];
    config = { options: errors.options ? [] : assignOptionIds(labels, previous) };
    if (type === 'multi') {
      const raw = values.maxChoices.trim();
      let maxChoices = 0;
      if (raw) {
        const n = toInt(raw);
        if (!Number.isInteger(n) || n < 0 || (labels.length >= LIMITS.minOptions && n > labels.length)) {
          errors.maxChoices = 'Bitte 0 (beliebig) oder eine Zahl bis zur Anzahl der Optionen eingeben.';
        } else {
          maxChoices = n;
        }
      }
      config.maxChoices = maxChoices;
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values,
    data: { type, title, help, required: values.required ? 1 : 0, config },
  };
}

/** Werte eines bestehenden Fragenformulars zum Vorbelegen. */
function questionFormValues(q) {
  const c = q.config || {};
  return {
    type: q.type,
    title: q.title,
    help: q.help,
    required: Boolean(q.required),
    maxLength: q.type === 'text' || q.type === 'longtext' ? String(c.maxLength ?? '') : '',
    scaleMin: q.type === 'scale' ? String(c.min ?? 1) : '1',
    scaleMax: q.type === 'scale' ? String(c.max ?? 10) : '10',
    minLabel: q.type === 'scale' ? c.minLabel || '' : '',
    maxLabel: q.type === 'scale' ? c.maxLabel || '' : '',
    options: Array.isArray(c.options) ? c.options.map((o) => o.label).join('\n') : '',
    maxChoices: q.type === 'multi' ? String(c.maxChoices ?? 0) : '0',
  };
}

/** Frage anhängen (nur Entwurf). @returns {number} ID */
function addQuestion(db, surveyId, form) {
  return transaction(db, () => {
    const survey = requireSurvey(db, surveyId);
    requireDraft(survey);
    const parsed = parseQuestionForm(form);
    if (!parsed.ok) throw new ValidationError(parsed.errors, parsed.values);
    const count = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS maxPos FROM questions WHERE survey_id = ?').get(survey.id);
    if (count.n >= LIMITS.maxQuestions) throw new SurveyError(`Höchstens ${LIMITS.maxQuestions} Fragen pro Umfrage.`);
    const d = parsed.data;
    const info = db.prepare('INSERT INTO questions (survey_id, position, type, title, help, required, config) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(survey.id, count.maxPos + 1, d.type, d.title, d.help, d.required, JSON.stringify(d.config));
    return Number(info.lastInsertRowid);
  });
}

function requireQuestion(db, survey, questionId) {
  const q = getQuestion(db, survey.id, questionId);
  if (!q) throw new SurveyError('Diese Frage gibt es nicht.', 404);
  return q;
}

/** Frage ändern (nur Entwurf). */
function updateQuestion(db, surveyId, questionId, form) {
  transaction(db, () => {
    const survey = requireSurvey(db, surveyId);
    requireDraft(survey);
    const q = requireQuestion(db, survey, questionId);
    const parsed = parseQuestionForm(form, q);
    if (!parsed.ok) throw new ValidationError(parsed.errors, parsed.values);
    const d = parsed.data;
    db.prepare('UPDATE questions SET type = ?, title = ?, help = ?, required = ?, config = ? WHERE id = ?')
      .run(d.type, d.title, d.help, d.required, JSON.stringify(d.config), q.id);
  });
}

function renumber(db, surveyId) {
  const rows = db.prepare('SELECT id FROM questions WHERE survey_id = ? ORDER BY position, id').all(surveyId);
  const upd = db.prepare('UPDATE questions SET position = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i + 1, r.id));
}

/** Frage löschen (nur Entwurf), Nummerierung schließt die Lücke. */
function deleteQuestion(db, surveyId, questionId) {
  transaction(db, () => {
    const survey = requireSurvey(db, surveyId);
    requireDraft(survey);
    const q = requireQuestion(db, survey, questionId);
    db.prepare('DELETE FROM questions WHERE id = ?').run(q.id);
    renumber(db, survey.id);
  });
}

/** Frage nach oben/unten verschieben (nur Entwurf). direction: 'up' | 'down'. */
function moveQuestion(db, surveyId, questionId, direction) {
  if (direction !== 'up' && direction !== 'down') throw new SurveyError('Ungültige Richtung.', 400);
  transaction(db, () => {
    const survey = requireSurvey(db, surveyId);
    requireDraft(survey);
    requireQuestion(db, survey, questionId);
    renumber(db, survey.id);
    const list = db.prepare('SELECT id, position FROM questions WHERE survey_id = ? ORDER BY position').all(survey.id);
    const i = list.findIndex((r) => r.id === Number(questionId));
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    const upd = db.prepare('UPDATE questions SET position = ? WHERE id = ?');
    upd.run(list[j].position, list[i].id);
    upd.run(list[i].position, list[j].id);
  });
}

// ---------------------------------------------------------------------------
// Teilnahme
// ---------------------------------------------------------------------------

/**
 * Antworten prüfen. Liest nur die Felder q<id> der Fragen dieser Umfrage.
 * @returns {{ ok:boolean, errors:Record<number,string>, values:Record<number,string|string[]>, rows:Array<{questionId:number, value:string}> }}
 */
function validateAnswers(questions, form) {
  const errors = {};
  const values = {};
  const rows = [];
  for (const q of questions) {
    const key = `q${q.id}`;
    const c = q.config || {};
    if (q.type === 'text' || q.type === 'longtext') {
      const v = cleanText(form[key], { multiline: q.type === 'longtext' });
      values[q.id] = asString(form[key]);
      const max = Number(c.maxLength) || TEXT_DEFAULTS[q.type];
      if (!v) {
        if (q.required) errors[q.id] = 'Bitte diese Frage beantworten.';
      } else if (v.length > max) {
        errors[q.id] = `Die Antwort darf höchstens ${max} Zeichen lang sein (jetzt ${v.length}).`;
      } else {
        rows.push({ questionId: q.id, value: v });
      }
    } else if (q.type === 'scale') {
      const raw = asString(form[key]).trim();
      values[q.id] = raw;
      const min = Number.isInteger(c.min) ? c.min : 1;
      const max = Number.isInteger(c.max) ? c.max : 10;
      if (!raw) {
        if (q.required) errors[q.id] = 'Bitte einen Wert auswählen.';
      } else {
        const n = toInt(raw);
        if (!Number.isInteger(n) || n < min || n > max || String(n) !== raw) {
          errors[q.id] = `Bitte einen Wert von ${min} bis ${max} auswählen.`;
        } else {
          rows.push({ questionId: q.id, value: String(n) });
        }
      }
    } else if (q.type === 'single') {
      const raw = asString(form[key]);
      values[q.id] = raw;
      const ids = new Set((c.options || []).map((o) => o.id));
      if (!raw) {
        if (q.required) errors[q.id] = 'Bitte eine Option auswählen.';
      } else if (!ids.has(raw)) {
        errors[q.id] = 'Bitte eine der angebotenen Optionen auswählen.';
      } else {
        rows.push({ questionId: q.id, value: raw });
      }
    } else if (q.type === 'multi') {
      const raw = asArray(form[key]).map(String).filter((v) => v !== '');
      values[q.id] = raw;
      const ids = new Set((c.options || []).map((o) => o.id));
      const maxChoices = Number(c.maxChoices) || 0;
      if (raw.length === 0) {
        if (q.required) errors[q.id] = 'Bitte mindestens eine Option auswählen.';
      } else if (raw.some((v) => !ids.has(v))) {
        errors[q.id] = 'Bitte nur angebotene Optionen auswählen.';
      } else if (new Set(raw).size !== raw.length) {
        errors[q.id] = 'Jede Option kann nur einmal gewählt werden.';
      } else if (maxChoices > 0 && raw.length > maxChoices) {
        errors[q.id] = `Bitte höchstens ${maxChoices} Optionen auswählen.`;
      } else {
        for (const v of raw) rows.push({ questionId: q.id, value: v });
        rows.push({ questionId: q.id, value: '' }); // Marker „hat geantwortet“ (SPEC §4)
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors, values, rows };
}

/**
 * Eine Teilnahme speichern (SPEC §3 Regeln 1, 2, 4, 11, 12, 13).
 * Bei Validierungsfehlern wird nichts gespeichert und { ok:false, errors, values } zurückgegeben.
 * Ist die Umfrage nicht (mehr) offen, wird SurveyError geworfen.
 */
function submitResponse(db, surveyId, form) {
  const survey = getSurvey(db, surveyId);
  if (!survey || survey.status !== 'open') throw new SurveyError('Diese Umfrage nimmt keine Antworten mehr an.', 409);
  const questions = getQuestions(db, survey.id);
  const result = validateAnswers(questions, form);
  if (!result.ok) return { ok: false, errors: result.errors, values: result.values };
  // Eine leere Teilnahme würde nur den Zähler erhöhen. Damit ließe sich die Mindestzahl (Regel 5)
  // erreichen, ohne dass echte Antworten vorliegen – die übrigen wären dann einer Person zuzuordnen.
  if (result.rows.length === 0) {
    return { ok: false, errors: { _form: 'Bitte mindestens eine Frage beantworten.' }, values: result.values };
  }

  transaction(db, () => {
    const info = db.prepare("UPDATE surveys SET response_count = response_count + 1 WHERE id = ? AND status = 'open' "
      + 'AND (closes_at IS NULL OR closes_at > ?)').run(survey.id, nowSec());
    if (Number(info.changes) !== 1) throw new SurveyError('Diese Umfrage nimmt keine Antworten mehr an.', 409);
    const insert = db.prepare('INSERT INTO answers (id, question_id, value) VALUES (?, ?, ?)');
    // Einfügereihenfolge zusätzlich mischen; VACUUM ordnet danach ohnehin nach zufälliger ID.
    for (const row of shuffle(result.rows)) insert.run(crypto.randomUUID(), row.questionId, row.value);
  });
  // Schlägt das VACUUM fehl, ist die Teilnahme trotzdem gespeichert; vacuumSafely() merkt es vor.
  vacuumSafely(db);
  return { ok: true };
}

module.exports = {
  TYPES,
  TYPE_LABELS,
  STATUS_LABELS,
  LIMITS,
  TEXT_DEFAULTS,
  TEXT_MAX,
  SurveyError,
  ValidationError,
  cleanText,
  shuffle,
  parseLocalDateTime,
  formatLocalDateTime,
  closeDueSurveys,
  purgeUnderMinimum,
  surveyCode,
  startAutoClose,
  vacuumSafely,
  isVacuumPending,
  getSurvey,
  getSurveyBySlug,
  getQuestions,
  getQuestion,
  getAnswersByQuestion,
  listSurveys,
  resultsAvailable,
  createSurvey,
  parseSurveyMeta,
  updateSurveyMeta,
  updateClosesAt,
  openSurvey,
  closeSurvey,
  duplicateSurvey,
  isDeleteConfirmation,
  deleteSurvey,
  assignOptionIds,
  parseQuestionForm,
  questionFormValues,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  moveQuestion,
  validateAnswers,
  submitResponse,
};
