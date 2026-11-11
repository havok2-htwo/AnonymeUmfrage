'use strict';

// PDF-Export: Erzeugung mit allen Fragetypen, Umlauten, Emoji, sehr langen Texten und leeren Fragen;
// Dateiname und Content-Disposition.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildResults } = require('../src/results');
const { renderResultsPdf, pdfFilename, contentDisposition, slugify, periodText } = require('../src/pdf');

function sample({ manyQuestions = 1 } = {}) {
  const survey = {
    id: 7,
    title: 'Mitarbeiterbefragung Größe & Übermaß – Teamklima 2026',
    intro: 'Liebe Kolleginnen und Kollegen,\n\ndiese Umfrage ist anonym. Grüße aus dem Büro!',
    status: 'closed',
    response_count: 5,
    opened_at: '2026-11-02T08:00:00.000Z',
    closed_at: '2026-11-13T16:00:00.000Z',
  };
  const options = [
    { id: 'a', label: 'Sehr zufrieden' },
    { id: 'b', label: 'Eine sehr lange Beschriftung mit Ümlauten, die in der Spalte umbrechen muss, äöüß ÄÖÜ' },
    { id: 'c', label: 'Gar nicht' },
  ];
  const questions = [];
  const answers = new Map();
  let id = 1;
  const add = (type, title, config, values, help = '') => {
    questions.push({ id, position: id, type, title, help, required: 0, config });
    answers.set(id, values);
    id += 1;
  };
  for (let i = 0; i < manyQuestions; i += 1) {
    add('scale', 'Wie zufrieden bist du insgesamt?', { min: 1, max: 10, minLabel: 'gar nicht', maxLabel: 'völlig' }, ['7', '8', '8', '10', '3']);
    add('scale', 'Skala ohne Antworten (optional)', { min: 0, max: 5 }, []);
    add('single', 'Kommunikation im Team', { options }, ['a', 'b', 'b', 'zz', 'c']);
    add('multi', 'Welche Angebote nutzt du?', { options, maxChoices: 0 }, ['', '', '', 'a', 'b', 'a', 'c']);
    add('longtext', 'Was sollten wir verbessern? Äußere dich gern ausführlich.', {}, [
      'Mehr Ruhe im Großraumbüro 😀👍🏽 und weniger Meetings.',
      'Weißwurst-Frühstück öfter!\nZweite Zeile.\n\nDritter Absatz.',
      'x'.repeat(4000),
      'Lorem ipsum dolor sit amet, äöü ß ÄÖÜ. '.repeat(250),
      '😀😀😀',
      'Steuerzeichen\u0007 und\ttabs',
    ], 'Optionaler Hinweistext.');
    add('text', 'Optionale Frage ohne Antworten', {}, []);
  }
  return buildResults(survey, questions, answers);
}

test('PDF: beginnt mit %PDF, alle Typen, Umlaute, Emoji, lange Texte', async () => {
  const buf = await renderResultsPdf(sample(), { version: '1.2.3', integrityText: 'Code identisch mit GitHub-Version v1.2.3' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(buf.subarray(-16).toString('latin1'), /%%EOF/);
  const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 3, `mehrere Seiten erwartet, erhalten: ${pages}`);
});

test('PDF: viele Fragen und Umfrage ohne Fragen', async () => {
  const many = await renderResultsPdf(sample({ manyQuestions: 6 }), { version: '1.2.3' });
  assert.equal(many.subarray(0, 4).toString('latin1'), '%PDF');
  const empty = buildResults({ id: 1, title: '', intro: '', status: 'closed', response_count: 0 }, [], new Map());
  const buf = await renderResultsPdf(empty, { version: '1.2.3' });
  assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');
});

test('Dateiname und Content-Disposition', () => {
  assert.equal(slugify('Größe & Übermaß 2026', true), 'groesse-uebermass-2026');
  assert.equal(slugify('Größe & Übermaß 2026'), 'größe-übermaß-2026');
  assert.deepEqual(pdfFilename('Teamklima'), { ascii: 'umfrage-teamklima-ergebnis.pdf', utf8: 'umfrage-teamklima-ergebnis.pdf' });
  assert.equal(pdfFilename('😀').ascii, 'umfrage-ergebnis.pdf');
  const cd = contentDisposition('Größe "Test"; x');
  assert.equal(cd, "attachment; filename=\"umfrage-groesse-test-x-ergebnis.pdf\"; filename*=UTF-8''umfrage-gr%C3%B6%C3%9Fe-test-x-ergebnis.pdf");
  assert.ok(slugify('a'.repeat(200)).length <= 60);
  assert.equal(periodText('2026-11-02T08:00:00.000Z', null), '02.11.2026 – –');
});

/** Rendert und zeichnet jeden doc.text()-Aufruf mit Seitennummer auf. */
async function renderTraced(results) {
  const PDFDocument = require('pdfkit');
  const orig = PDFDocument.prototype.text;
  const calls = [];
  PDFDocument.prototype.text = function traced(text, ...rest) {
    const out = orig.call(this, text, ...rest);
    const r = this.bufferedPageRange();
    // Seite des Aufrufs: nach dem Schreiben (pdfkit bricht ggf. vorher selbst um)
    calls.push({ text: String(text), page: r.start + r.count - 1 });
    return out;
  };
  try {
    await renderResultsPdf(results, { version: '1.2.3', integrityText: 'Code nicht geprüft' });
  } finally {
    PDFDocument.prototype.text = orig;
  }
  return calls;
}

test('PDF: Skalenblock mit Legende bleibt auf einer Seite', async () => {
  const survey = { id: 1, title: 'Skalen', intro: '', status: 'closed', min_responses: 3, response_count: 3 };
  // Vorangestellte Textfragen verschieben die Skalen schrittweise bis über den Seitenrand.
  for (let k = 0; k <= 14; k += 1) {
    const questions = [];
    const answers = new Map();
    let id = 1;
    for (let i = 0; i < k; i += 1) {
      questions.push({ id, position: id, type: 'text', title: `Text ${i}`, help: '', required: 0, config: {} });
      answers.set(id, ['eins', 'zwei', 'drei']);
      id += 1;
    }
    for (let i = 0; i < 3; i += 1) {
      questions.push({
        id, position: id, type: 'scale', title: `Skala ${i}`, help: '', required: 0,
        config: { min: 1, max: 10, minLabel: 'gar nicht', maxLabel: 'voll und ganz' },
      });
      answers.set(id, ['3', '7', '9']);
      id += 1;
    }
    const calls = await renderTraced(buildResults(survey, questions, answers));
    const starts = calls.map((c, i) => (c.text.startsWith('Durchschnitt') ? i : -1)).filter((i) => i >= 0);
    assert.equal(starts.length, 3);
    for (const i of starts) {
      // Kennzahlen, Legende, dann 10 Zeilen mit je Beschriftung und Wert
      const block = calls.slice(i, i + 2 + 20);
      assert.equal(block[1].text, '1 = gar nicht · 10 = voll und ganz');
      assert.equal(block[block.length - 2].text, '10');
      const pages = new Set(block.map((c) => c.page));
      assert.equal(pages.size, 1, `k=${k}: Skalenblock über ${pages.size} Seiten verteilt`);
    }
  }
});
