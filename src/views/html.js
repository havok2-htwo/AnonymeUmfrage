'use strict';

// HTML-Vorlagen mit automatischem Escaping.
//
//   html`<h1>${title}</h1>`            title wird escaped
//   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`   Arrays werden verbunden
//   raw('<b>vertrauenswürdig</b>')      nur für fest eingebaute, geprüfte Fragmente
//
// null, undefined und false ergeben einen leeren Text. Ergebnis ist ein SafeHtml-Objekt;
// String(x) oder x.toString() liefert den fertigen Text.

class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Markiert einen Text als sicheres HTML (wird nicht escaped). */
function raw(value) {
  return new SafeHtml(String(value ?? ''));
}

function isSafe(value) {
  return value instanceof SafeHtml;
}

/** Klassenliste: classes('btn', cond && 'is-active', { 'has-error': err }) → "btn is-active has-error". */
function classes(...items) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object') for (const [k, v] of Object.entries(item)) if (v) out.push(k);
  }
  return out.join(' ');
}

/** Bedingtes Fragment: when(cond, () => html`…`). */
function when(condition, fn) {
  return condition ? fn() : '';
}

/** Verbindet Fragmente mit einem (escapten) Trenner. */
function join(items, separator = '') {
  return new SafeHtml(items.map(render).join(render(separator)));
}

/** Mehrzeiliger Text → Absätze mit <br>, escaped. */
function nl2br(text) {
  const parts = String(text ?? '').split(/\r?\n/);
  return new SafeHtml(parts.map(escapeHtml).join('<br>'));
}

/** Text in Absätze (Leerzeile trennt), escaped. */
function paragraphs(text, className) {
  const blocks = String(text ?? '').split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  const cls = className ? ` class="${escapeHtml(className)}"` : '';
  return new SafeHtml(blocks.map((b) => `<p${cls}>${nl2br(b).value}</p>`).join(''));
}

const TZ = 'Europe/Berlin';
const dateFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Datum TT.MM.JJJJ (akzeptiert ISO-Text, Date, Unix-Sekunden oder -Millisekunden). */
function formatDate(value) {
  const d = toDate(value);
  return d ? dateFmt.format(d) : '';
}

/** Datum und Uhrzeit TT.MM.JJJJ, HH:MM. */
function formatDateTime(value) {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : '';
}

/** Zahl deutsch formatiert, z. B. formatNumber(7.25, 1) → "7,3". */
function formatNumber(n, digits = 0) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Prozentwert 0..100 als ganze Zahl für die Balkenklassen .w-0 … .w-100. */
function widthClass(percent) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return `w-${p}`;
}

module.exports = {
  SafeHtml,
  html,
  raw,
  isSafe,
  escapeHtml,
  classes,
  when,
  join,
  nl2br,
  paragraphs,
  formatDate,
  formatDateTime,
  formatNumber,
  widthClass,
};
