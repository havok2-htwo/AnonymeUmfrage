'use strict';

// Teilnahme- und Auswertungsansicht: Skalenbeschriftung, Barrierefreiheit, Hilfetexte.

const test = require('node:test');
const assert = require('node:assert/strict');

const { questionBlock } = require('../src/views/survey');
const { resultsBody } = require('../src/views/results');
const { buildResults } = require('../src/results');

function scale(config, extra = {}) {
  return { id: 9, position: 1, type: 'scale', title: 'Wie zufrieden?', help: '', required: 0, config: { min: 1, max: 10, ...config }, ...extra };
}

test('Skala: nur vorhandene Enden werden beschriftet', () => {
  const onlyMin = String(questionBlock(scale({ minLabel: 'gar nicht', maxLabel: '' }), 1, {}));
  assert.match(onlyMin, /<span>1 = gar nicht<\/span>/);
  assert.doesNotMatch(onlyMin, /10 = /);
  assert.doesNotMatch(onlyMin, /scale-labels-end/);

  const onlyMax = String(questionBlock(scale({ minLabel: '', maxLabel: 'sehr' }), 1, {}));
  assert.match(onlyMax, /class="scale-labels scale-labels-end"/);
  assert.match(onlyMax, /<span>10 = sehr<\/span>/);
  assert.doesNotMatch(onlyMax, /1 = /);

  const none = String(questionBlock(scale({}), 1, {}));
  assert.doesNotMatch(none, /scale-labels/);
});

test('Skala: Spaltenzahl per Klasse, Beschriftung am fieldset, aria-invalid bei Fehler', () => {
  const ten = String(questionBlock(scale({ minLabel: 'gar nicht', maxLabel: 'sehr' }), 1, { error: 'Bitte einen Wert auswählen.' }));
  assert.match(ten, /class="scale scale-n-10"/);
  assert.match(ten, /<fieldset[^>]*aria-describedby="frage-9-eingabe-labels frage-9-fehler"/);
  assert.doesNotMatch(ten, /<div class="scale[^"]*"[^>]*aria-describedby/);
  assert.equal((ten.match(/aria-invalid="true"/g) || []).length, 10);
  assert.doesNotMatch(ten, /style="/);

  const eleven = String(questionBlock(scale({ min: 0, max: 10 }), 1, {}));
  assert.match(eleven, /class="scale scale-n-11"/);
  assert.doesNotMatch(eleven, /aria-invalid/);

  const choice = String(questionBlock({
    id: 4, position: 1, type: 'single', title: 'Eine', help: 'Hilfe', required: 1,
    config: { options: [{ id: 'aaaaaa', label: 'A' }, { id: 'bbbbbb', label: 'B' }] },
  }, 1, { error: 'Bitte eine Option auswählen.' }));
  assert.match(choice, /<fieldset[^>]*aria-describedby="frage-4-hilfe frage-4-fehler"/);
  assert.equal((choice.match(/aria-invalid="true"/g) || []).length, 2);
});

test('Auswertung: Hilfetext behält Absätze und Zeilenumbrüche', () => {
  const survey = { id: 1, title: 'T', intro: '', status: 'closed', min_responses: 2, response_count: 2 };
  const questions = [{ id: 1, position: 1, type: 'text', title: 'Frage', help: 'Erste Zeile\nzweite Zeile\n\nNeuer Absatz', required: 0, config: {} }];
  const page = String(resultsBody(buildResults(survey, questions, new Map([[1, ['a', 'b']]])), { version: '1.2.3' }));
  assert.match(page, /<div class="question-help"><p>Erste Zeile<br>\s*zweite Zeile<\/p><p>Neuer Absatz<\/p><\/div>/);
});
