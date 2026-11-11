'use strict';

// Teilnahmeseiten (SPEC §7 „Öffentlich“): Formular, abgeschlossen, Dank. Außerdem die Vorschau im
// Adminbereich (gleiches Formular, ohne Absenden). Funktioniert vollständig ohne JavaScript;
// public/js/survey.js ergänzt nur Fortschrittsanzeige und den lokalen Hinweis „bereits teilgenommen“.

const { html, raw, classes, paragraphs, when } = require('./html');
const { layout } = require('./layout');
const { surveyCode } = require('../surveys');

const ANON_NOTICE = 'Anonym: keine Anmeldung, keine Cookies, keine IP-Speicherung. Antworten werden je Frage getrennt gespeichert.';

function requiredMark(q) {
  return when(q.required, () => html`<span class="required-mark" aria-hidden="true">*</span><span class="visually-hidden"> (Pflichtfrage)</span>`);
}

function describedBy(...ids) {
  const list = ids.filter(Boolean).join(' ');
  return list ? html` aria-describedby="${list}"` : '';
}

function textInput(q, value, ctx) {
  const max = Number(q.config.maxLength) || (q.type === 'text' ? 500 : 5000);
  const common = html`id="${ctx.inputId}" name="q${q.id}" maxlength="${max}" aria-labelledby="${ctx.titleId}"${describedBy(ctx.helpId, ctx.errorId)}${q.required ? raw(' required') : ''}${ctx.error ? raw(' aria-invalid="true"') : ''}${ctx.disabled ? raw(' disabled') : ''}`;
  if (q.type === 'text') {
    return html`<input type="text" class="input" ${common} value="${value || ''}" autocomplete="off">`;
  }
  return html`<textarea class="textarea" rows="5" ${common} data-count="${max}">${value || ''}</textarea>
    <span class="char-count" hidden data-count-for="${ctx.inputId}">0 / ${max}</span>`;
}

function scaleBounds(q) {
  return {
    min: Number.isInteger(q.config.min) ? q.config.min : 1,
    max: Number.isInteger(q.config.max) ? q.config.max : 10,
  };
}

/** ID der Skalen-Endbeschriftung (für aria-describedby am fieldset) oder ''. */
function scaleLabelsId(q, inputId) {
  return q.type === 'scale' && (q.config.minLabel || q.config.maxLabel) ? `${inputId}-labels` : '';
}

function scaleInput(q, value, ctx) {
  const { min, max } = scaleBounds(q);
  const { minLabel, maxLabel } = q.config;
  const options = [];
  for (let n = min; n <= max; n += 1) {
    options.push(html`<label class="scale-option"><input type="radio" name="q${q.id}" value="${n}"${String(n) === String(value) ? raw(' checked') : ''}${q.required && n === min ? raw(' required') : ''}${ctx.error ? raw(' aria-invalid="true"') : ''}${ctx.disabled ? raw(' disabled') : ''}><span>${n}</span></label>`);
  }
  // Nur vorhandene Enden beschriften; ein einzelnes Ende-Label steht rechts (.scale-labels-end).
  return html`<div class="scale scale-n-${max - min + 1}">
      <div class="scale-options">${options}</div>
      ${when(ctx.labelsId, () => html`<div class="${classes('scale-labels', { 'scale-labels-end': !minLabel })}" id="${ctx.labelsId}">${when(minLabel, () => html`<span>${min} = ${minLabel}</span>`)}${when(maxLabel, () => html`<span>${max} = ${maxLabel}</span>`)}</div>`)}
    </div>`;
}

function choiceInput(q, value, ctx) {
  const multi = q.type === 'multi';
  const selected = new Set(multi ? (Array.isArray(value) ? value : []) : [value]);
  const items = (q.config.options || []).map((o, i) => html`
      <label class="check"><input type="${multi ? 'checkbox' : 'radio'}" name="q${q.id}" value="${o.id}"${selected.has(o.id) ? raw(' checked') : ''}${!multi && q.required && i === 0 ? raw(' required') : ''}${ctx.error ? raw(' aria-invalid="true"') : ''}${ctx.disabled ? raw(' disabled') : ''}><span class="check-label">${o.label}</span></label>`);
  const maxChoices = Number(q.config.maxChoices) || 0;
  return html`
    ${when(multi, () => html`<p class="hint mb-2">${maxChoices > 0 ? `Mehrfachauswahl, höchstens ${maxChoices}.` : 'Mehrfachauswahl möglich.'}</p>`)}
    <div class="choice-list">${items}</div>`;
}

/** Eine Frage als fieldset mit legend (Nummer, Titel, Pflichtmarkierung), Hilfetext und Fehler. */
function questionBlock(q, number, { value, error, disabled }) {
  const base = `frage-${q.id}`;
  const ctx = {
    inputId: `${base}-eingabe`,
    titleId: `${base}-titel`,
    helpId: q.help ? `${base}-hilfe` : '',
    errorId: error ? `${base}-fehler` : '',
    labelsId: scaleLabelsId(q, `${base}-eingabe`),
    error,
    disabled,
  };
  let body;
  if (q.type === 'text' || q.type === 'longtext') body = textInput(q, value, ctx);
  else if (q.type === 'scale') body = scaleInput(q, value, ctx);
  else body = choiceInput(q, value, ctx);
  // Textfelder verweisen selbst auf Hilfe und Fehler; bei Auswahlgruppen übernimmt das das fieldset
  // (bei Skalen inklusive der Endbeschriftung, damit Screenreader sie ansagen).
  const isText = q.type === 'text' || q.type === 'longtext';
  return html`
    <fieldset class="${classes('question', { 'has-error': error })}" id="${base}" data-question data-required="${q.required ? '1' : '0'}"${isText ? '' : describedBy(ctx.helpId, ctx.labelsId, ctx.errorId)}>
      <legend class="question-head"><span class="question-number" aria-hidden="true">${number}</span><span class="question-title" id="${ctx.titleId}"><span class="visually-hidden">Frage ${number}: </span>${q.title}${requiredMark(q)}</span></legend>
      ${when(q.help, () => html`<div class="question-help" id="${ctx.helpId}">${paragraphs(q.help)}</div>`)}
      ${when(error, () => html`<p class="field-error mb-2" id="${ctx.errorId}">${error}</p>`)}
      <div class="question-body">${body}</div>
    </fieldset>`;
}

function errorSummary(questions, errors) {
  const entries = questions.map((q, i) => ({ q, n: i + 1, msg: errors[q.id] })).filter((e) => e.msg);
  if (errors._form && !entries.length) {
    return html`
    <div class="alert alert-error" role="alert" id="fehler" tabindex="-1">
      <strong class="alert-title">${errors._form}</strong>
      Es wurde nichts gespeichert. Eine leere Teilnahme wird nicht gezählt, damit die Mindestzahl nur durch echte Antworten erreicht wird.
    </div>`;
  }
  if (!entries.length) return '';
  return html`
    <div class="alert alert-error" role="alert" id="fehler" tabindex="-1">
      <strong class="alert-title">${entries.length === 1 ? 'Eine Antwort fehlt oder ist ungültig.' : `${entries.length} Antworten fehlen oder sind ungültig.`}</strong>
      Es wurde nichts gespeichert. Bitte korrigieren und erneut absenden.
      <ul>${entries.map((e) => html`<li><a href="#frage-${e.q.id}">Frage ${e.n}</a>: ${e.msg}</li>`)}</ul>
    </div>`;
}

/**
 * Umfrage-Code mit Aufforderung zum Vergleichen. Bekommt jede Person einen eigenen Link (eigene Umfrage),
 * sehen alle verschiedene Codes – das kann die Software nicht verhindern, aber so wird es erkennbar.
 */
function codeNotice(survey) {
  return html`<p class="survey-code small">Umfrage-Code: <strong class="mono">${surveyCode(survey.slug)}</strong>.
        Alle Eingeladenen sehen denselben Code (hier, direkt unter dem Titel; ein Code im Einleitungstext zählt nicht).
        Vergleicht ihn untereinander: Wer einen anderen Code sieht, hat einen eigenen Link bekommen, und dann ist die
        Umfrage für diese Person nicht anonym.</p>`;
}

function surveyHead(survey) {
  return html`
    <header class="survey-head">
      <h1 class="page-title">${survey.title}</h1>
      ${codeNotice(survey)}
      ${when(survey.intro, () => html`<div class="lead survey-intro">${paragraphs(survey.intro)}</div>`)}
      <p class="survey-anon small">${ANON_NOTICE} <a href="/transparenz">Mehr zur Anonymität</a></p>
    </header>`;
}

/**
 * Formularseite.
 * @param {object} o
 * @param {object} o.survey
 * @param {Array}  o.questions
 * @param {object} [o.errors]   { [questionId]: Meldung }
 * @param {object} [o.values]   { [questionId]: Wert | Werte[] }
 * @param {boolean} [o.preview] Vorschau im Adminbereich (ohne Absenden)
 * @param {object} [o.req]      Anfrage (nur Vorschau: Admin-Navigation)
 */
function surveyFormPage({ survey, questions, errors = {}, values = {}, preview = false, req = null }) {
  const hasRequired = questions.some((q) => q.required);
  const blocks = questions.map((q, i) => questionBlock(q, i + 1, { value: values[q.id], error: errors[q.id], disabled: false }));
  const footer = preview
    ? html`<div class="actions survey-submit"><button type="button" class="btn btn-primary" disabled aria-disabled="true">Antworten absenden</button><span class="muted small">In der Vorschau wird nichts gesendet.</span></div>`
    : html`<div class="actions survey-submit"><button type="submit" class="btn btn-primary" data-submit>Antworten absenden</button></div>`;
  const inner = html`
    ${when(hasRequired, () => html`<p class="hint mb-4">Mit <span class="required-mark" aria-hidden="true">*</span> markierte Fragen sind Pflicht.</p>`)}
    ${blocks}
    ${footer}`;

  const body = html`
    ${when(preview, () => html`
      <div class="alert alert-warn no-print">
        <strong class="alert-title">Vorschau</strong>
        So sehen Teilnehmende die Umfrage. Absenden ist hier deaktiviert.
        <a href="/admin/surveys/${survey.id}">Zurück zur Umfrage</a>
      </div>`)}
    ${surveyHead(survey)}
    ${when(!preview, () => html`
      <div class="alert alert-info" id="bereits-teilgenommen" hidden data-done-slug="${survey.slug}">
        <strong class="alert-title">Auf diesem Gerät wurde bereits teilgenommen.</strong>
        Dieser Hinweis wird nur in diesem Browser gespeichert und nie gesendet. Wenn sich mehrere Personen ein Gerät teilen, kann trotzdem erneut ausgefüllt werden.
        <div class="actions mt-2"><button type="button" class="btn btn-secondary btn-sm" data-retake>Trotzdem erneut ausfüllen</button></div>
      </div>`)}
    ${errorSummary(questions, errors)}
    <p class="survey-progress small muted" hidden data-progress aria-live="polite"></p>
    ${preview
    ? html`<div class="survey-form">${inner}</div>`
    : html`<form method="post" action="/u/${survey.slug}" class="form survey-form" id="umfrage" accept-charset="utf-8" autocomplete="off">${inner}</form>`}`;

  return layout({
    title: preview ? `Vorschau: ${survey.title}` : survey.title,
    body,
    req: preview ? req : null,
    width: 'narrow',
    scripts: preview ? [] : ['/js/survey.js'],
    bodyClass: 'page-survey',
  });
}

function closedPage(survey) {
  const body = html`
    <section class="panel message-panel message-info">
      <h1 class="page-title">Diese Umfrage ist abgeschlossen</h1>
      <p class="lead">„${survey.title}“ nimmt keine Antworten mehr an. Danke für das Interesse.</p>
      ${codeNotice(survey)}
      <p class="muted small"><a href="/transparenz">So funktioniert die Anonymität</a></p>
    </section>`;
  return layout({ title: 'Umfrage abgeschlossen', body, width: 'narrow' });
}

function thanksPage(survey) {
  const body = html`
    <section class="panel message-panel message-success" id="teilnahme-fertig" data-done-slug="${survey.slug}">
      <h1 class="page-title">Danke für die Teilnahme</h1>
      ${survey.thanks
    ? html`<div class="lead">${paragraphs(survey.thanks)}</div>`
    : html`<p class="lead">Die Antworten wurden anonym gespeichert.</p>`}
      <p class="muted small">Gespeichert wurden nur die Antworten selbst, je Frage getrennt und ohne Zeitpunkt, IP-Adresse oder Kennung.
        <a href="/transparenz">Mehr zur Anonymität</a></p>
      <p class="muted small">Auf einem geteilten Gerät: Tab jetzt schließen, damit niemand mit „Zurück“ hierher kommt.
        Der Browserverlauf und der Hinweis „bereits teilgenommen“ bleiben trotzdem auf dem Gerät. Spurlos geht es nur in
        einem privaten Fenster, das danach geschlossen wird.</p>
    </section>`;
  return layout({ title: 'Danke', body, width: 'narrow', scripts: ['/js/survey.js'] });
}

module.exports = { surveyFormPage, closedPage, thanksPage, questionBlock, ANON_NOTICE };
