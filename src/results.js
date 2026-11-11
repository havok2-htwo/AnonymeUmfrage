'use strict';

// Auswertung (SPEC §7 „Auswertung“): Statistik pro Frage und sicheres Mischen.
//
// Alles hier sind reine Funktionen ohne Datenbankzugriff. Die Route (src/routes/results.js) lädt
// Umfrage, Fragen und Antworten und ruft buildResults(survey, questions, answersByQuestionId) auf.
// HTML-Ansicht und PDF arbeiten beide mit demselben Ergebnisobjekt.
//
// Anonymität (SPEC §3 Regel 3): Freitexte werden bei jedem Aufruf neu gemischt (Fisher-Yates mit
// crypto.randomInt). Bei Skalen und Auswahlfragen werden nur Zählwerte ausgegeben, keine Einzelwerte
// in Speicherreihenfolge.

const { randomInt } = require('node:crypto');

/**
 * Gibt eine neu gemischte Kopie zurück (Fisher-Yates mit kryptografischem Zufall).
 * Das Eingabe-Array bleibt unverändert.
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function shuffle(items) {
  const out = Array.from(items || []);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1); // 0 … i
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Zahl deutsch mit fester Anzahl Nachkommastellen, z. B. 7.25 → "7,3". */
function formatDecimal(n, digits) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Zahl deutsch mit höchstens einer Nachkommastelle, ganze Zahlen ohne Komma: 8 → "8", 7.5 → "7,5". */
function formatShort(n) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n);
}

/** Anteil in Prozent (0 … 100), bei n = 0 immer 0. */
function percentOf(count, n) {
  return n > 0 ? (count / n) * 100 : 0;
}

const NBSP = String.fromCharCode(0xa0); // geschütztes Leerzeichen

/** Prozent als Text ohne Nachkommastelle: "33 %" (mit geschütztem Leerzeichen). */
function formatPercent(percent) {
  return `${formatDecimal(Math.round(percent), 0)}${NBSP}%`;
}

/** „n von N haben geantwortet“ */
function answeredText(n, total) {
  return `${n} von ${total} haben geantwortet`;
}

/** Hinweis für ausgeblendete Fragen (weniger Antworten als die Mindestzahl). */
function suppressedText(n) {
  return `Zu wenige Antworten (${n}), zum Schutz der Anonymität ausgeblendet.`;
}

function toInt(value) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Skalengrenzen aus der Konfiguration, wie SPEC §5 (Standard 1–10). */
function scaleBounds(config = {}) {
  let min = toInt(config.min);
  let max = toInt(config.max);
  if (min === null || min < 0 || min > 1) min = 1;
  if (max === null || max < 2 || max > 10) max = 10;
  return { min, max };
}

/**
 * Statistik für eine Skalenfrage.
 * Ungültige Werte (keine ganze Zahl, außerhalb [min, max]) werden ignoriert.
 * @param {string[]} values  gespeicherte Werte (Zahl als Text)
 * @param {object} config    Fragekonfiguration { min, max, minLabel, maxLabel }
 */
function scaleStats(values, config = {}) {
  const { min, max } = scaleBounds(config);
  const counts = new Map();
  for (let v = min; v <= max; v += 1) counts.set(v, 0);
  const nums = [];
  for (const raw of values || []) {
    const v = toInt(raw);
    if (v === null || v < min || v > max) continue;
    counts.set(v, counts.get(v) + 1);
    nums.push(v);
  }
  const n = nums.length;
  let mean = null;
  let median = null;
  if (n > 0) {
    mean = nums.reduce((a, b) => a + b, 0) / n;
    nums.sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    median = n % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }
  const distribution = [];
  for (const [value, count] of counts) {
    const percent = percentOf(count, n);
    distribution.push({ value, label: String(value), count, percent, percentText: formatPercent(percent) });
  }
  return {
    n,
    min,
    max,
    minLabel: String(config.minLabel || ''),
    maxLabel: String(config.maxLabel || ''),
    mean,
    median,
    meanText: mean === null ? '–' : formatDecimal(mean, 1),
    medianText: median === null ? '–' : formatShort(median),
    distribution,
  };
}

/**
 * Zählung für Einzel- und Mehrfachauswahl, in Optionsreihenfolge.
 * - single: n = Anzahl gültiger Antworten.
 * - multi:  Zeilen mit value = '' sind Marker (eine pro Teilnahme mit Auswahl) und ergeben n;
 *           sie zählen bei keiner Option mit.
 * Antworten mit unbekannter Option-ID werden ignoriert.
 * @param {string[]} values
 * @param {object} config  { options: [{ id, label }] }
 * @param {boolean} multi
 */
function choiceStats(values, config = {}, multi = false) {
  const options = Array.isArray(config.options) ? config.options : [];
  const counts = new Map(options.map((o) => [String(o.id), 0]));
  let markers = 0;
  let valid = 0;
  for (const raw of values || []) {
    const v = String(raw ?? '');
    if (v === '') {
      if (multi) markers += 1;
      continue;
    }
    if (!counts.has(v)) continue;
    counts.set(v, counts.get(v) + 1);
    valid += 1;
  }
  const n = multi ? markers : valid;
  return {
    n,
    options: options.map((o) => {
      const count = counts.get(String(o.id)) || 0;
      const percent = percentOf(count, n);
      return { id: String(o.id), label: String(o.label ?? ''), count, percent, percentText: formatPercent(percent) };
    }),
  };
}

/** Freitexte: leere entfernen, gemischt zurückgeben. */
function textAnswers(values) {
  return shuffle((values || []).map((v) => String(v ?? '')).filter((v) => v.trim() !== ''));
}

const KIND = { text: 'text', longtext: 'text', scale: 'scale', single: 'choice', multi: 'choice' };

const TYPE_LABEL = {
  text: 'Freitext (kurz)',
  longtext: 'Freitext (lang)',
  scale: 'Skala',
  single: 'Einzelauswahl',
  multi: 'Mehrfachauswahl',
};

function getAnswers(answersByQuestionId, id) {
  if (!answersByQuestionId) return [];
  if (answersByQuestionId instanceof Map) return answersByQuestionId.get(id) || answersByQuestionId.get(String(id)) || [];
  return answersByQuestionId[id] || [];
}

/**
 * Komplette Auswertung einer Umfrage.
 * @param {object} survey     Zeile aus surveys (snake_case, SPEC §4)
 * @param {object[]} questions Fragen nach position sortiert, config bereits als Objekt
 * @param {Map|object} answersByQuestionId  questionId → string[]
 *
 * Fragen, die weniger als survey.min_responses Personen beantwortet haben (aber mindestens eine),
 * werden mit suppressed: true und ohne scale/choice/answers zurückgegeben (SPEC §3 Regel 5).
 */
function buildResults(survey, questions, answersByQuestionId) {
  const total = Math.max(0, Number(survey.response_count) || 0);
  const minResponses = Math.max(0, Number(survey.min_responses) || 0);
  const list = [...(questions || [])].sort((a, b) => a.position - b.position);
  const out = list.map((q, index) => {
    const config = q.config && typeof q.config === 'object' ? q.config : {};
    const values = getAnswers(answersByQuestionId, q.id);
    const kind = KIND[q.type] || 'text';
    const base = {
      id: q.id,
      number: index + 1,
      type: q.type,
      typeLabel: TYPE_LABEL[q.type] || q.type,
      kind,
      title: String(q.title ?? ''),
      help: String(q.help ?? ''),
      required: Boolean(q.required),
      total,
    };
    let detail;
    if (kind === 'scale') detail = { scale: scaleStats(values, config) };
    else if (kind === 'choice') detail = { choice: choiceStats(values, config, q.type === 'multi') };
    else detail = { answers: textAnswers(values) };
    const n = detail.scale ? detail.scale.n : detail.choice ? detail.choice.n : detail.answers.length;
    // Regel 5/12: Haben weniger Personen diese Frage beantwortet als die Mindestzahl, bleiben die Inhalte
    // verborgen. Sonst wären einzelne Antworten erkennbar und über Fragen hinweg verknüpfbar.
    if (n > 0 && n < minResponses) {
      const range = kind === 'scale' ? { min: detail.scale.min, max: detail.scale.max } : null;
      return {
        ...base, suppressed: true, range, n, answeredText: answeredText(n, total), suppressedText: suppressedText(n),
      };
    }
    return { ...base, ...detail, suppressed: false, n, answeredText: answeredText(n, total) };
  });
  return {
    survey: {
      id: survey.id,
      title: String(survey.title ?? ''),
      intro: String(survey.intro ?? ''),
      status: survey.status,
      openedAt: survey.opened_at || null,
      closedAt: survey.closed_at || null,
      responseCount: total,
    },
    total,
    questions: out,
  };
}

module.exports = {
  shuffle,
  scaleStats,
  choiceStats,
  textAnswers,
  buildResults,
  answeredText,
  suppressedText,
  formatPercent,
  formatDecimal,
  scaleBounds,
  TYPE_LABEL,
};
