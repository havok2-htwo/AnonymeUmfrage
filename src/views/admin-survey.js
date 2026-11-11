'use strict';

// Adminbereich: eine Umfrage. Entwurf → Editor (Stammdaten, Fragen, Öffnen). Offen/geschlossen →
// Übersicht (Link, Teilnahmen, Ergebnisstatus, Schließen). Alles funktioniert mit normalen Formularen;
// public/js/admin.js blendet nur typabhängige Felder ein/aus, verbessert die Optionsliste und kopiert Links.

const { html, raw, classes, when, paragraphs, formatDate, formatDateTime, formatNumber } = require('./html');
const { flash, statusBadge, field, formErrors } = require('./admin');
const {
  TYPES, TYPE_LABELS, LIMITS, TEXT_DEFAULTS, TEXT_MAX, formatLocalDateTime, questionFormValues,
} = require('../surveys');

const EMPTY_QUESTION = {
  type: 'text', title: '', help: '', required: false, maxLength: '', scaleMin: '1', scaleMax: '10',
  minLabel: '', maxLabel: '', options: '', maxChoices: '0',
};

function selectOptions(list, current) {
  return list.map((o) => html`<option value="${o.value}"${String(o.value) === String(current) ? raw(' selected') : ''}>${o.label}</option>`);
}

/** Fragenformular (neu oder bearbeiten). key = 'neu' oder Fragen-ID, für eindeutige Feld-IDs. */
function questionForm({ req, csrfField, action, key, values = EMPTY_QUESTION, errors = {}, submitLabel }) {
  const v = { ...EMPTY_QUESTION, ...values };
  const id = (name) => `f${key}-${name}`;
  const err = (name) => errors[name] || '';
  const sel = (name, label, list, hint = '') => html`
    <div class="${classes('field', { 'has-error': err(name) })}">
      <label class="label" for="${id(name)}">${label}</label>
      <select class="select" id="${id(name)}" name="${name}"${hint ? html` aria-describedby="${id(name)}-hinweis"` : ''}>${selectOptions(list, v[name])}</select>
      ${when(hint, () => html`<p class="hint" id="${id(name)}-hinweis">${hint}</p>`)}
      ${when(err(name), () => html`<p class="field-error">${err(name)}</p>`)}
    </div>`;

  return html`
    <form method="post" action="${action}" class="form question-form" data-question-form>
      ${csrfField(req)}
      ${formErrors(errors)}
      <div class="field-row">
        ${sel('type', 'Fragetyp', TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })))}
        <div class="field field-check">
          <span class="label" aria-hidden="true">&nbsp;</span>
          <label class="check"><input type="checkbox" name="required" value="1"${v.required ? raw(' checked') : ''}><span class="check-label">Pflichtfrage</span></label>
        </div>
      </div>
      ${field({ id: id('title'), name: 'title', label: 'Frage', value: v.title, error: err('title'), required: true, attrs: html`maxlength="${LIMITS.questionTitle}"` })}
      ${field({ id: id('help'), name: 'help', label: 'Hilfetext (optional)', value: v.help, error: err('help'), type: 'textarea', rows: 2, hint: 'Erscheint klein unter der Frage.', attrs: html`maxlength="${LIMITS.help}"` })}

      <fieldset class="type-fields" data-types="text longtext">
        <legend class="type-fields-legend">Einstellungen für Textfragen</legend>
        ${field({
    id: id('maxLength'), name: 'maxLength', label: 'Maximale Länge in Zeichen', value: v.maxLength, error: err('maxLength'), type: 'number',
    hint: `Leer lassen für den Standard (kurzer Text ${TEXT_DEFAULTS.text}, langer Text ${TEXT_DEFAULTS.longtext}). Höchstens ${TEXT_MAX.text} bzw. ${TEXT_MAX.longtext}.`,
    attrs: html`min="1" max="${TEXT_MAX.longtext}" inputmode="numeric"`, className: 'field-narrow',
  })}
      </fieldset>

      <fieldset class="type-fields" data-types="scale">
        <legend class="type-fields-legend">Einstellungen für Skalen</legend>
        <div class="field-row">
          ${sel('scaleMin', 'Von', [{ value: 0, label: '0' }, { value: 1, label: '1' }])}
          ${sel('scaleMax', 'Bis', [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: n, label: String(n) })))}
        </div>
        <div class="field-row mt-4">
          ${field({ id: id('minLabel'), name: 'minLabel', label: 'Beschriftung kleinster Wert', value: v.minLabel, error: err('minLabel'), hint: 'z. B. „trifft gar nicht zu“', attrs: html`maxlength="${LIMITS.scaleLabel}"` })}
          ${field({ id: id('maxLabel'), name: 'maxLabel', label: 'Beschriftung größter Wert', value: v.maxLabel, error: err('maxLabel'), hint: 'z. B. „trifft voll zu“', attrs: html`maxlength="${LIMITS.scaleLabel}"` })}
        </div>
      </fieldset>

      <fieldset class="type-fields" data-types="single multi">
        <legend class="type-fields-legend">Einstellungen für Auswahlfragen</legend>
        <div class="${classes('field', 'options-field', { 'has-error': err('options') })}" data-options-editor>
          <label class="label" for="${id('options')}">Optionen</label>
          <textarea class="textarea" rows="5" id="${id('options')}" name="options" aria-describedby="${id('options')}-hinweis" data-options-source>${v.options}</textarea>
          <div class="options-list" data-options-list hidden></div>
          <p class="hint" id="${id('options')}-hinweis">Eine Option pro Zeile, ${LIMITS.minOptions} bis ${LIMITS.maxOptions} Optionen. Die Reihenfolge bleibt für alle gleich.</p>
          ${when(err('options'), () => html`<p class="field-error">${err('options')}</p>`)}
        </div>
        <div class="type-fields-sub" data-types="multi">
          ${field({
    id: id('maxChoices'), name: 'maxChoices', label: 'Höchstens auswählbar (nur Mehrfachauswahl)', value: v.maxChoices, error: err('maxChoices'), type: 'number',
    hint: '0 = beliebig viele.', attrs: html`min="0" max="${LIMITS.maxOptions}" inputmode="numeric"`, className: 'field-narrow',
  })}
        </div>
      </fieldset>

      <div class="actions">
        <button type="submit" class="btn btn-primary">${submitLabel}</button>
      </div>
    </form>`;
}

function configSummary(q) {
  const c = q.config || {};
  if (q.type === 'text' || q.type === 'longtext') return `Bis ${formatNumber(c.maxLength || TEXT_DEFAULTS[q.type])} Zeichen`;
  if (q.type === 'scale') {
    const labels = [c.minLabel && `${c.min} = ${c.minLabel}`, c.maxLabel && `${c.max} = ${c.maxLabel}`].filter(Boolean);
    return `Skala ${c.min}–${c.max}${labels.length ? ` · ${labels.join(' · ')}` : ''}`;
  }
  const opts = (c.options || []).map((o) => o.label).join(' · ');
  const max = q.type === 'multi' && c.maxChoices ? ` (höchstens ${c.maxChoices})` : '';
  return `${opts}${max}`;
}

function questionMeta(q) {
  return html`<span class="badge badge-plain badge-neutral">${TYPE_LABELS[q.type]}</span>${when(q.required, () => html` <span class="badge badge-plain badge-info">Pflicht</span>`)}`;
}

function editorQuestion({ req, csrfField, survey, q, index, total, state }) {
  const editing = state.question && String(state.question.key) === String(q.id);
  const base = `/admin/surveys/${survey.id}/questions/${q.id}`;
  const move = (direction, label, disabled) => html`
    <form method="post" action="${base}/move">
      ${csrfField(req)}<input type="hidden" name="direction" value="${direction}">
      <button type="submit" class="btn btn-ghost btn-sm" aria-label="${`Frage ${index + 1} ${label}`}"${disabled ? raw(' disabled') : ''}>${label}</button>
    </form>`;
  return html`
    <article class="question-editor" id="frage-${q.id}">
      <div class="question-editor-head">
        <div class="question-editor-title">
          <span class="question-number">${index + 1}</span>
          <div>
            <h3 class="question-title">${q.title}</h3>
            <p class="small mt-2 mb-0">${questionMeta(q)} <span class="muted break">${configSummary(q)}</span></p>
          </div>
        </div>
        <div class="toolbar">
          ${move('up', 'Nach oben', index === 0)}
          ${move('down', 'Nach unten', index === total - 1)}
          <form method="post" action="${base}/delete" data-confirm="${`Frage ${index + 1} wirklich löschen?`}">
            ${csrfField(req)}
            <button type="submit" class="btn btn-ghost btn-sm">Löschen</button>
          </form>
        </div>
      </div>
      <details class="confirm question-edit mt-4"${editing ? raw(' open') : ''}>
        <summary>Bearbeiten</summary>
        <div class="confirm-body">
          ${questionForm({
    req, csrfField, action: base, key: q.id,
    values: editing ? state.question.values : questionFormValues(q),
    errors: editing ? state.question.errors : {},
    submitLabel: 'Frage speichern',
  })}
        </div>
      </details>
    </article>`;
}

function metaForm({ req, csrfField, survey, state }) {
  const errors = (state.meta && state.meta.errors) || {};
  const v = (state.meta && state.meta.values) || {
    title: survey.title,
    intro: survey.intro,
    thanks: survey.thanks,
    min_responses: String(survey.min_responses),
    closes_at: formatLocalDateTime(survey.closes_at),
  };
  return html`
    <form method="post" action="/admin/surveys/${survey.id}" class="form">
      ${csrfField(req)}
      ${formErrors(errors)}
      ${field({ id: 'meta-title', name: 'title', label: 'Titel', value: v.title, error: errors.title, required: true, attrs: html`maxlength="${LIMITS.surveyTitle}"` })}
      ${field({ id: 'meta-intro', name: 'intro', label: 'Einleitung', value: v.intro, error: errors.intro, type: 'textarea', rows: 4, hint: 'Steht über den Fragen. Leerzeile = neuer Absatz.', attrs: html`maxlength="${LIMITS.intro}"` })}
      ${field({ id: 'meta-thanks', name: 'thanks', label: 'Dankestext', value: v.thanks, error: errors.thanks, type: 'textarea', rows: 3, hint: 'Erscheint nach dem Absenden. Leer = Standardtext.', attrs: html`maxlength="${LIMITS.thanks}"` })}
      <div class="field-row mt-4">
        ${field({
    id: 'meta-min', name: 'min_responses', label: 'Mindestanzahl Teilnahmen', value: v.min_responses, error: errors.min_responses, type: 'number', required: true,
    hint: `Ergebnisse gibt es erst ab dieser Zahl (mindestens ${LIMITS.minResponses}). Nach dem Öffnen nicht mehr änderbar.`,
    attrs: html`min="${LIMITS.minResponses}" max="${LIMITS.maxMinResponses}" inputmode="numeric"`,
  })}
        ${field({
    id: 'meta-closes', name: 'closes_at', label: 'Automatisch schließen am (optional)', value: v.closes_at, error: errors.closes_at, type: 'datetime-local',
    hint: 'Uhrzeit in deutscher Zeit. Leer = nur von Hand schließen.',
  })}
      </div>
      <div class="actions"><button type="submit" class="btn btn-primary">Stammdaten speichern</button></div>
    </form>`;
}

function duplicateForm({ req, csrfField, survey }) {
  return html`
    <form method="post" action="/admin/surveys/${survey.id}/duplicate">
      ${csrfField(req)}
      <button type="submit" class="btn btn-secondary">Duplizieren</button>
    </form>`;
}

function deletePanel({ req, csrfField, survey, state }) {
  const error = state.deleteError || '';
  return html`
    <details class="confirm danger-zone"${error ? raw(' open') : ''}>
      <summary>Umfrage löschen</summary>
      <div class="confirm-body">
        <div class="confirm-panel">
          <p class="mt-0">Löscht die Umfrage mit allen Fragen${survey.response_count ? ` und ${formatNumber(survey.response_count)} Teilnahmen` : ''} unwiderruflich.</p>
          <form method="post" action="/admin/surveys/${survey.id}/delete" class="form" data-delete-form>
            ${csrfField(req)}
            ${field({
    id: 'loeschen-bestaetigung', name: 'confirm', label: 'Zur Bestätigung den Titel der Umfrage oder „löschen“ eintippen', error,
    attrs: html`autocomplete="off" data-expected="${survey.title}"`,
  })}
            <div class="actions"><button type="submit" class="btn btn-danger" data-delete-button>Endgültig löschen</button></div>
          </form>
        </div>
      </div>
    </details>`;
}

function actionError(state) {
  return when(state.actionError, () => html`<div class="alert alert-error" role="alert">${state.actionError}</div>`);
}

/** Editor für Entwürfe. */
function editorBody({ req, csrfField, survey, questions, notice, state = {} }) {
  const newKey = state.question && state.question.key === 'neu';
  return html`
    <div class="page-head">
      <div class="page-head-text">
        <p class="eyebrow">${statusBadge(survey.status)}</p>
        <h1 class="page-title break">${survey.title}</h1>
        <p class="muted mb-0">Im Entwurf lässt sich alles ändern. Nach dem Öffnen sind die Fragen eingefroren.</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-secondary" href="/admin/surveys/${survey.id}/preview">Vorschau</a>
        ${duplicateForm({ req, csrfField, survey })}
      </div>
    </div>
    ${flash(notice)}
    ${actionError(state)}

    <section class="section" aria-labelledby="stammdaten">
      <h2 class="section-title" id="stammdaten">Stammdaten</h2>
      <div class="panel">${metaForm({ req, csrfField, survey, state })}</div>
    </section>

    <section class="section" aria-labelledby="fragen">
      <h2 class="section-title" id="fragen">Fragen <span class="muted">(${questions.length})</span></h2>
      ${questions.length
    ? questions.map((q, i) => editorQuestion({ req, csrfField, survey, q, index: i, total: questions.length, state }))
    : html`<div class="panel panel-muted"><p class="muted mb-0">Noch keine Fragen. Unten die erste hinzufügen.</p></div>`}
      <div class="panel panel-accent mt-4" id="frage-neu">
        <h3 class="panel-title">Frage hinzufügen</h3>
        ${questionForm({
    req, csrfField, action: `/admin/surveys/${survey.id}/questions`, key: 'neu',
    values: newKey ? state.question.values : EMPTY_QUESTION,
    errors: newKey ? state.question.errors : {},
    submitLabel: 'Frage hinzufügen',
  })}
      </div>
    </section>

    <section class="section" aria-labelledby="oeffnen">
      <h2 class="section-title" id="oeffnen">Umfrage öffnen</h2>
      <div class="confirm-panel is-warn">
        <p class="mt-0">Nach dem Öffnen kann über den Link teilgenommen werden. Fragen, Typen, Optionen, Reihenfolge und
          Mindestanzahl lassen sich dann nicht mehr ändern.</p>
        ${when(!questions.length, () => html`<p class="mb-0"><strong>Zum Öffnen braucht die Umfrage mindestens eine Frage.</strong></p>`)}
        <form method="post" action="/admin/surveys/${survey.id}/open" data-confirm="Umfrage jetzt öffnen? Die Fragen sind danach eingefroren.">
          ${csrfField(req)}
          <div class="actions">
            <button type="submit" class="btn btn-primary"${questions.length ? '' : raw(' disabled')}>Umfrage öffnen</button>
            <a class="btn btn-secondary" href="/admin/surveys/${survey.id}/preview">Vorher Vorschau ansehen</a>
          </div>
        </form>
      </div>
    </section>

    <section class="section" aria-label="Löschen">
      ${deletePanel({ req, csrfField, survey, state })}
    </section>`;
}

function resultsPanel(survey, results) {
  if (results.ok) {
    return html`
      <div class="panel panel-accent">
        <h2 class="panel-title">Ergebnisse</h2>
        <p class="muted">Die Umfrage ist geschlossen und hat genug Teilnahmen. Freitexte werden in zufälliger Reihenfolge gezeigt.</p>
        <div class="actions">
          <a class="btn btn-primary" href="/admin/surveys/${survey.id}/results">Auswertung ansehen</a>
          <a class="btn btn-secondary" href="/admin/surveys/${survey.id}/results.pdf">PDF herunterladen</a>
        </div>
      </div>`;
  }
  return html`
    <div class="alert alert-warn">
      <strong class="alert-title">Ergebnisse gesperrt</strong>
      ${results.reason}
      ${when(survey.status === 'open', () => html` Bis dahin ist nur die Anzahl der Teilnahmen sichtbar.`)}
    </div>`;
}

/** Übersicht für offene und geschlossene Umfragen. */
function overviewBody({ req, csrfField, survey, questions, notice, link, results, state = {} }) {
  const isOpen = survey.status === 'open';
  const closesErr = state.closesError || '';
  return html`
    <div class="page-head">
      <div class="page-head-text">
        <p class="eyebrow">${statusBadge(survey.status)}</p>
        <h1 class="page-title break">${survey.title}</h1>
      </div>
      <div class="page-actions">
        <a class="btn btn-secondary" href="/admin/surveys/${survey.id}/preview">Vorschau</a>
        ${duplicateForm({ req, csrfField, survey })}
      </div>
    </div>
    ${flash(notice)}
    ${actionError(state)}

    <div class="stats mb-6">
      <div class="stat"><span class="stat-value">${formatNumber(survey.response_count)}</span><span class="stat-label">Teilnahmen</span></div>
      <div class="stat"><span class="stat-value">${formatNumber(questions.length)}</span><span class="stat-label">Fragen</span></div>
      <div class="stat"><span class="stat-value">${formatNumber(survey.min_responses)}</span><span class="stat-label">Mindestanzahl für Ergebnisse</span></div>
    </div>

    ${when(isOpen, () => html`
    <section class="panel mb-4" aria-labelledby="link-titel">
      <h2 class="panel-title" id="link-titel">Link zum Teilen</h2>
      <p class="muted">Wer diesen Link hat, kann anonym teilnehmen. Am besten per E-Mail oder Chat an alle Teilnehmenden schicken.</p>
      <div class="copy-field">
        <input class="input" type="text" readonly value="${link}" id="umfrage-link" aria-label="Link zur Umfrage">
        <button type="button" class="btn btn-secondary" data-copy="umfrage-link" hidden>Link kopieren</button>
      </div>
    </section>`)}

    ${when(isOpen, () => html`
    <p class="hint mb-4">Eigene Testteilnahmen über den Link zählen mit. Wer selbst teilnimmt, um die Mindestzahl zu erreichen, hebt die Anonymität der übrigen Antworten auf. Zum Ausprobieren die Vorschau verwenden.</p>`)}
    ${when(state.vacuumPending, () => html`
    <div class="alert alert-warn mb-4">
      <strong class="alert-title">Datenbank-Neuordnung ausstehend</strong>
      Das Neuschreiben der Datenbank (VACUUM) nach der letzten Teilnahme ist fehlgeschlagen und wird automatisch nachgeholt.
    </div>`)}

    <section class="mb-4">${resultsPanel(survey, results)}</section>

    <section class="panel mb-4" aria-labelledby="daten-titel">
      <h2 class="panel-title" id="daten-titel">Daten</h2>
      <dl class="meta-list">
        <dt>Status</dt><dd>${statusBadge(survey.status)}</dd>
        <dt>Erstellt am</dt><dd>${formatDateTime(survey.created_at)}</dd>
        <dt>Geöffnet am</dt><dd>${formatDateTime(survey.opened_at) || '–'}</dd>
        ${survey.status === 'closed'
    ? html`<dt>Geschlossen am</dt><dd>${formatDateTime(survey.closed_at) || '–'}</dd>`
    : html`<dt>Schließt automatisch</dt><dd>${survey.closes_at ? formatDateTime(survey.closes_at) : 'nein, nur von Hand'}</dd>`}
        ${when(!isOpen, () => html`<dt>Link</dt><dd class="mono break">${link}</dd>`)}
      </dl>
      ${when(survey.intro, () => html`<h3 class="small mt-4 mb-2">Einleitung</h3><div class="muted">${paragraphs(survey.intro)}</div>`)}
    </section>

    ${when(isOpen, () => html`
    <section class="panel mb-4" aria-labelledby="termin-titel">
      <h2 class="panel-title" id="termin-titel">Automatisch schließen</h2>
      <form method="post" action="/admin/surveys/${survey.id}" class="form">
        ${csrfField(req)}
        <div class="inline-form inline-form-field">
          ${field({
    id: 'closes-at', name: 'closes_at', label: 'Zeitpunkt (deutsche Zeit, leer = nur von Hand)', type: 'datetime-local',
    value: state.closesValue !== undefined ? state.closesValue : formatLocalDateTime(survey.closes_at), error: closesErr,
  })}
          <button type="submit" class="btn btn-secondary">Speichern</button>
        </div>
      </form>
    </section>`)}

    <section class="panel mb-4" aria-labelledby="fragen-titel">
      <h2 class="panel-title" id="fragen-titel">Fragen</h2>
      <ol class="question-overview">
        ${questions.map((q) => html`<li><span class="break">${q.title}</span> ${questionMeta(q)}</li>`)}
      </ol>
    </section>

    ${when(isOpen, () => html`
    <section class="section">
      <details class="confirm"${state.closeError ? raw(' open') : ''}>
        <summary>Umfrage schließen</summary>
        <div class="confirm-body">
          <div class="confirm-panel is-warn">
            <p class="mt-0"><strong>Schließen ist endgültig.</strong> Danach sind keine Antworten mehr möglich und die Umfrage
              kann nicht wieder geöffnet werden. So lässt sich keine einzelne spätere Antwort einer Person zuordnen.
              Wer weitermachen will, dupliziert die Umfrage.</p>
            <form method="post" action="/admin/surveys/${survey.id}/close" class="form">
              ${csrfField(req)}
              <label class="check check-plain"><input type="checkbox" name="confirm" value="ja" required><span class="check-label">Ich habe verstanden, dass das Schließen endgültig ist.</span></label>
              ${when(state.closeError, () => html`<p class="field-error mt-2">${state.closeError}</p>`)}
              <div class="actions"><button type="submit" class="btn btn-danger">Endgültig schließen</button></div>
            </form>
          </div>
        </div>
      </details>
    </section>`)}

    <section class="section" aria-label="Löschen">
      ${deletePanel({ req, csrfField, survey, state })}
    </section>`;
}

module.exports = { editorBody, overviewBody, questionForm, EMPTY_QUESTION };
