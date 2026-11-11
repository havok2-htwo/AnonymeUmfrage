'use strict';

// Escaping (SPEC §11): Nutzerdaten mit <script> werden in allen Ansichten escaped ausgegeben.

const test = require('node:test');
const assert = require('node:assert/strict');

const { html, escapeHtml, paragraphs, nl2br } = require('../src/views/html');
const { surveyFormPage, closedPage, thanksPage } = require('../src/views/survey');
const { resultsBody } = require('../src/views/results');
const { buildResults } = require('../src/results');
const { layout } = require('../src/views/layout');

const EVIL = '<script>alert("x")</script>';
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

/** Keine ausführbaren Skripte außer den eigenen Dateien mit src="/js/…". */
function assertNoInjectedScript(page) {
  assert.doesNotMatch(page, /<script>alert/);
  for (const m of page.matchAll(/<script\b([^>]*)>/g)) {
    assert.match(m[1], /\ssrc="\/js\/[a-z-]+\.js\?v=[^"]+"/, `Skript ohne eigene Quelle: ${m[0]}`);
  }
  assert.doesNotMatch(page, /\sstyle="/);
  assert.doesNotMatch(page, /\son[a-z]+="/);
}

const options = [{ id: 'a1b2c3', label: EVIL }, { id: 'd4e5f6', label: 'Zwei & „drei“' }];
const survey = {
  id: 7, slug: 'AAAAAAAAAAAAAAAAAAAAAA', title: `Umfrage ${EVIL}`, intro: `Hallo ${EVIL}\nZeile 2`, thanks: `Danke ${EVIL}`,
  status: 'closed', min_responses: 3, response_count: 3, opened_at: '2026-11-01T08:00:00.000Z', closed_at: '2026-11-10T08:00:00.000Z',
};
const questions = [
  { id: 1, position: 1, type: 'text', title: `Text ${EVIL}`, help: `Hilfe ${EVIL}`, required: 1, config: { maxLength: 500 } },
  { id: 2, position: 2, type: 'longtext', title: 'Lang', help: '', required: 0, config: { maxLength: 5000 } },
  { id: 3, position: 3, type: 'scale', title: 'Skala', help: '', required: 0, config: { min: 1, max: 10, minLabel: EVIL, maxLabel: 'gut' } },
  { id: 4, position: 4, type: 'single', title: 'Eine', help: '', required: 0, config: { options } },
  { id: 5, position: 5, type: 'multi', title: 'Mehrere', help: '', required: 0, config: { options, maxChoices: 0 } },
];

test('html-Helfer escapen alle Sonderzeichen', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(String(html`<a title="${EVIL}">${EVIL}</a>`), `<a title="${ESCAPED}">${ESCAPED}</a>`);
  assert.equal(String(paragraphs(`${EVIL}\n\nzwei`)), `<p>${ESCAPED}</p><p>zwei</p>`);
  assert.match(String(nl2br(`a\n${EVIL}`)), /a<br>&lt;script&gt;/);
});

test('Teilnahmeseite: Titel, Hilfe, Optionen und eingegebene Werte escaped', () => {
  const page = surveyFormPage({
    survey: { ...survey, status: 'open' },
    questions,
    values: { 1: EVIL, 2: `Mehr ${EVIL}` },
    errors: { 1: 'Bitte ausfüllen.' },
  });
  assert.ok(page.includes(`Text ${ESCAPED}`));
  assert.ok(page.includes(`Hilfe ${ESCAPED}`));
  assert.ok(page.includes(`Umfrage ${ESCAPED}`));
  assert.ok(page.includes(ESCAPED));
  assert.ok(page.includes('Zwei &amp; „drei“'));
  assertNoInjectedScript(page);
});

test('Abschluss- und Dankeseite escaped', () => {
  for (const page of [closedPage(survey), thanksPage(survey)]) {
    assert.ok(page.includes(ESCAPED));
    assertNoInjectedScript(page);
  }
});

test('Auswertung: Fragetitel, Optionen und Freitexte escaped', () => {
  const answers = new Map([
    [1, [EVIL, 'normal']], [2, [`<img src=x onerror=alert(1)>`]], [3, ['5', '7', '9']],
    [4, ['a1b2c3', 'd4e5f6', 'a1b2c3']], [5, ['', 'a1b2c3', '', 'd4e5f6']],
  ]);
  // Mindestzahl 1: hier geht es ums Escaping, nicht ums Ausblenden kleiner Fragen.
  const results = buildResults({ ...survey, min_responses: 1 }, questions, answers);
  const page = layout({ title: `Auswertung: ${survey.title}`, body: resultsBody(results, { version: '0.1.0' }) });
  assert.ok(page.includes(`Text ${ESCAPED}`));
  assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(page, /<img src=x/);
  assertNoInjectedScript(page);
});
