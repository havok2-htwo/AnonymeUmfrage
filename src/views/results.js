'use strict';

// HTML-Ansicht der Auswertung (SPEC §7 „Auswertung“). Balken über die Klassen .w-0 … .w-100
// (kein Inline-Style wegen CSP). Funktioniert ohne JavaScript; Drucken über das PDF oder die
// Druckfunktion des Browsers (eigenes Druck-Stylesheet in app.css).

const { html, paragraphs, formatDate, widthClass, classes } = require('./html');
const { integrityLabel } = require('../integrity');

function period(survey) {
  const a = formatDate(survey.openedAt) || '–';
  const b = formatDate(survey.closedAt) || '–';
  return `${a} – ${b}`;
}

function barList(rows, labelFn = (r) => r.label) {
  return html`
    <ul class="bar-list">
      ${rows.map((row) => html`
        <li class="bar-row">
          <span class="bar-label">${labelFn(row) || '–'}</span>
          <span class="bar-track" aria-hidden="true"><span class="${classes('bar-fill', widthClass(row.percent))}"></span></span>
          <span class="bar-value">${row.count}<span class="muted">${row.percentText}</span></span>
        </li>`)}
    </ul>`;
}

function scaleBody(q) {
  const s = q.scale;
  const ends = [];
  if (s.minLabel) ends.push(`${s.min} = ${s.minLabel}`);
  if (s.maxLabel) ends.push(`${s.max} = ${s.maxLabel}`);
  return html`
    <dl class="result-figures">
      <div><dt>Durchschnitt</dt><dd>${s.meanText}</dd></div>
      <div><dt>Median</dt><dd>${s.medianText}</dd></div>
      <div><dt>Skala</dt><dd>${s.min}–${s.max}</dd></div>
    </dl>
    ${barList(s.distribution)}
    ${ends.length ? html`<p class="result-scale-ends">${ends.join(' · ')}</p>` : ''}`;
}

function choiceBody(q) {
  if (!q.choice.options.length) return html`<p class="muted">Keine Optionen.</p>`;
  return barList(q.choice.options);
}

function textBody(q) {
  if (!q.answers.length) return html`<p class="muted">Keine Antworten.</p>`;
  return html`<ul class="answer-list">${q.answers.map((a) => html`<li>${a}</li>`)}</ul>`;
}

function questionSection(q) {
  let body;
  if (q.suppressed) body = html`<p class="result-suppressed muted">${q.suppressedText}</p>`;
  else if (q.kind === 'scale') body = scaleBody(q);
  else if (q.kind === 'choice') body = choiceBody(q);
  else body = textBody(q);
  return html`
    <section class="result-question" aria-labelledby="frage-${q.id}">
      <div class="question-head">
        <span class="question-number">${q.number}</span>
        <h2 class="question-title" id="frage-${q.id}">${q.title}</h2>
      </div>
      ${q.help ? html`<div class="question-help">${paragraphs(q.help)}</div>` : ''}
      <p class="result-meta">${q.answeredText} · ${q.typeLabel}</p>
      ${body}
    </section>`;
}

/**
 * Inhalt der Auswertungsseite.
 * @param {ReturnType<import('../results').buildResults>} results
 * @param {object} o
 * @param {string} o.version
 * @param {object} [o.integrityStatus]  Rückgabe von getIntegrityStatus()
 */
function resultsBody(results, { version, integrityStatus } = {}) {
  const { survey, total, questions } = results;
  const label = integrityLabel(integrityStatus);
  return html`
    <div class="page-head">
      <div class="page-head-text">
        <p class="eyebrow">Auswertung</p>
        <h1 class="page-title">${survey.title}</h1>
      </div>
      <div class="page-actions">
        <a class="btn btn-primary" href="/admin/surveys/${survey.id}/results.pdf">PDF herunterladen</a>
        <a class="btn btn-secondary" href="/admin/surveys/${survey.id}">Zur Umfrage</a>
      </div>
    </div>

    ${survey.intro ? html`<div class="lead result-intro">${paragraphs(survey.intro)}</div>` : ''}

    <div class="stats result-stats">
      <div class="stat"><span class="stat-value">${total}</span><span class="stat-label">Teilnahmen</span></div>
      <div class="stat"><span class="stat-value result-period">${period(survey)}</span><span class="stat-label">Zeitraum (geöffnet – geschlossen)</span></div>
      <div class="stat"><span class="stat-value">${questions.length}</span><span class="stat-label">Fragen</span></div>
    </div>

    <p class="result-version">
      <span>Version ${version}</span>
      <a class="${classes('badge', label.badge)}" href="/transparenz">${label.text}</a>
    </p>

    <div class="alert alert-info no-print result-print-hint">
      <p class="mb-0">Freitexte erscheinen bei jedem Aufruf in neuer, zufälliger Reihenfolge. Zum Drucken das
      PDF herunterladen oder die Druckfunktion des Browsers verwenden – die Druckansicht ist hell und ohne
      Navigation.</p>
    </div>

    <div class="result-list">
      ${questions.length ? questions.map(questionSection) : html`<p class="muted">Diese Umfrage hat keine Fragen.</p>`}
    </div>`;
}

module.exports = { resultsBody };
