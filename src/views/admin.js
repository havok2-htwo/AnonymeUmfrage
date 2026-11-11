'use strict';

// Adminbereich: gemeinsame Bausteine (Hinweise, Statusbadges, Formularfelder) und die Umfrageliste.
// Editor und Übersicht einer Umfrage: ./admin-survey.js, Adminverwaltung: ./admin-admins.js.

const { html, raw, classes, when, formatDate, formatDateTime, formatNumber } = require('./html');
const { STATUS_LABELS } = require('../surveys');

// Kurze, feste Hinweise nach Weiterleitungen (?hinweis=<schlüssel>). Keine freien Texte aus der URL.
const NOTICES = {
  angelegt: 'Die Umfrage wurde als Entwurf angelegt. Jetzt Fragen hinzufügen.',
  gespeichert: 'Gespeichert.',
  'frage-neu': 'Frage hinzugefügt.',
  'frage-gespeichert': 'Frage gespeichert.',
  'frage-geloescht': 'Frage gelöscht.',
  'frage-verschoben': 'Reihenfolge geändert.',
  geoeffnet: 'Die Umfrage ist offen. Jetzt den Link teilen.',
  geschlossen: 'Die Umfrage ist geschlossen. Es werden keine Antworten mehr angenommen.',
  dupliziert: 'Kopie als Entwurf angelegt.',
  geloescht: 'Die Umfrage wurde gelöscht.',
  'admin-neu': 'Admin angelegt.',
  'admin-geloescht': 'Admin gelöscht.',
  passwort: 'Das Passwort wurde geändert. Andere Sitzungen dieses Kontos wurden beendet.',
};

function noticeFromQuery(req) {
  const key = req && req.query ? String(req.query.hinweis || '') : '';
  return NOTICES[key] || '';
}

function flash(text, kind = 'success') {
  return when(text, () => html`<div class="alert alert-${kind}" role="status">${text}</div>`);
}

function statusBadge(status) {
  return html`<span class="badge status-${status}">${STATUS_LABELS[status] || status}</span>`;
}

/**
 * Formularfeld mit Label, Hinweis und Fehler.
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.name
 * @param {string} o.label
 * @param {*}      [o.value]
 * @param {string} [o.error]
 * @param {string} [o.hint]
 * @param {string} [o.type]       input-Typ oder 'textarea'
 * @param {boolean} [o.required]  nur Markierung + required-Attribut
 * @param {*}      [o.attrs]      zusätzliche Attribute (SafeHtml)
 * @param {string} [o.className]  zusätzliche Klasse für das Feld
 */
function field({ id, name, label, value = '', error = '', hint = '', type = 'text', required = false, attrs = '', className = '', rows = 4 }) {
  const hintId = hint ? `${id}-hinweis` : '';
  const errorId = error ? `${id}-fehler` : '';
  const described = [hintId, errorId].filter(Boolean).join(' ');
  const common = html`id="${id}" name="${name}"${described ? html` aria-describedby="${described}"` : ''}${required ? raw(' required') : ''}${error ? raw(' aria-invalid="true"') : ''} ${attrs}`;
  const control = type === 'textarea'
    ? html`<textarea class="textarea" rows="${rows}" ${common}>${value}</textarea>`
    : html`<input class="input" type="${type}" value="${value}" ${common}>`;
  return html`
    <div class="${classes('field', className, { 'has-error': error })}">
      <label class="label" for="${id}">${label}${required ? html`<span class="required-mark" aria-hidden="true">*</span>` : ''}</label>
      ${control}
      ${when(hint, () => html`<p class="hint" id="${hintId}">${hint}</p>`)}
      ${when(error, () => html`<p class="field-error" id="${errorId}">${error}</p>`)}
    </div>`;
}

/** Fehlerliste oben in einem Formular. */
function formErrors(errors, title = 'Bitte die markierten Felder prüfen.') {
  const list = Object.values(errors || {}).filter(Boolean);
  if (!list.length) return '';
  return html`<div class="alert alert-error" role="alert"><strong class="alert-title">${title}</strong>
    <ul>${list.map((m) => html`<li>${m}</li>`)}</ul></div>`;
}

/** Umfrageliste GET /admin. */
function dashboardBody({ req, csrfField, surveys, notice, createError = '', createValue = '' }) {
  const rows = surveys.map((s) => html`
    <tr>
      <td><a href="/admin/surveys/${s.id}" class="break">${s.title}</a></td>
      <td>${statusBadge(s.status)}</td>
      <td class="num">${s.status === 'open' ? html`<span class="muted" title="Die Zahl erscheint erst nach dem Schließen">–</span>` : formatNumber(s.response_count)}</td>
      <td class="num">${formatNumber(s.question_count)}</td>
      <td>${s.created_by_name || html`<span class="muted">gelöscht</span>`}</td>
      <td class="nowrap">${formatDate(s.created_at)}</td>
      <td class="actions-cell">
        <a class="btn btn-secondary btn-sm" href="/admin/surveys/${s.id}">${s.status === 'draft' ? 'Bearbeiten' : 'Übersicht'}</a>
        ${when(s.status === 'closed' && s.response_count >= s.min_responses, () => html`<a class="btn btn-ghost btn-sm" href="/admin/surveys/${s.id}/results">Auswertung</a>`)}
      </td>
    </tr>`);

  return html`
    <div class="page-head">
      <div class="page-head-text">
        <h1 class="page-title">Umfragen</h1>
        <p class="muted mb-0">Entwürfe bearbeiten, offene Umfragen teilen, Ergebnisse nach dem Schließen ansehen.</p>
      </div>
    </div>
    ${flash(notice)}
    <section class="panel mb-6" aria-labelledby="neu-titel">
      <h2 class="panel-title" id="neu-titel">Neue Umfrage</h2>
      <form method="post" action="/admin/surveys" class="form new-survey-form">
        ${csrfField(req)}
        <div class="${classes('field', { 'has-error': createError })}">
          <label class="label" for="neu-title">Titel</label>
          <div class="inline-form">
            <input class="input" type="text" id="neu-title" name="title" maxlength="200" required value="${createValue}"${createError ? raw(' aria-invalid="true" aria-describedby="neu-title-fehler"') : ''}>
            <button type="submit" class="btn btn-primary">Anlegen</button>
          </div>
          ${when(createError, () => html`<p class="field-error" id="neu-title-fehler">${createError}</p>`)}
        </div>
      </form>
    </section>
    ${surveys.length
    ? html`
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">Alle Umfragen</caption>
          <thead><tr><th scope="col">Titel</th><th scope="col">Status</th><th scope="col" class="num">Teilnahmen</th><th scope="col" class="num">Fragen</th><th scope="col">Erstellt von</th><th scope="col">Erstellt am</th><th scope="col" class="actions-cell"><span class="visually-hidden">Aktionen</span></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    : html`<div class="panel panel-muted"><p class="muted mb-0">Noch keine Umfragen. Oben die erste anlegen.</p></div>`}`;
}

module.exports = {
  NOTICES, noticeFromQuery, flash, statusBadge, field, formErrors, dashboardBody, formatDateTime,
};
