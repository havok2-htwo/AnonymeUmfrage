'use strict';

// Tests für die Auswertung: Mischen, Skalenstatistik, Auswahlzählung, Gesamtauswertung und die
// Routen /admin/surveys/:id/results(.pdf).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  shuffle, scaleStats, choiceStats, textAnswers, buildResults, answeredText,
} = require('../src/results');

test('shuffle: gleiche Elemente, Eingabe unverändert, Reihenfolge wechselt', () => {
  const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'b', 'b'];
  const copy = [...input];
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const out = shuffle(input);
    assert.deepEqual([...out].sort(), [...input].sort());
    seen.add(out.join(''));
  }
  assert.deepEqual(input, copy);
  assert.ok(seen.size > 1, 'Mischen ergibt unterschiedliche Reihenfolgen');
  assert.deepEqual(shuffle([]), []);
  assert.deepEqual(shuffle(['x']), ['x']);
});

test('shuffle: jede Position wird erreicht (grobe Gleichverteilung)', () => {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i += 1) counts[shuffle([1, 2, 3, 4]).indexOf(1)] += 1;
  for (const c of counts) assert.ok(c > 800 && c < 1200, `Verteilung ${counts}`);
});

test('scaleStats: Mittelwert, Median, Verteilung mit Nullen', () => {
  const s = scaleStats(['7', '8', '8', '10', '3', 'x', '11', '0', ' 9 '], { min: 1, max: 10, minLabel: 'schlecht' });
  assert.equal(s.n, 6); // ungültig: x, 11, 0
  assert.equal(s.meanText, '7,5'); // 45 / 6
  assert.equal(s.median, 8);
  assert.equal(s.medianText, '8');
  assert.equal(s.distribution.length, 10);
  assert.deepEqual(s.distribution.map((d) => d.count), [0, 0, 1, 0, 0, 0, 1, 2, 1, 1]);
  assert.equal(s.distribution[7].percentText, `33${String.fromCharCode(0xa0)}%`);
  assert.equal(s.minLabel, 'schlecht');

  const even = scaleStats(['1', '2', '3', '4'], { min: 0, max: 5 });
  assert.equal(even.medianText, '2,5');
  assert.equal(even.distribution[0].value, 0);
  assert.equal(even.distribution.length, 6);

  const empty = scaleStats([], {});
  assert.equal(empty.n, 0);
  assert.equal(empty.meanText, '–');
  assert.equal(empty.medianText, '–');
  assert.equal(empty.distribution.length, 10);
  assert.ok(empty.distribution.every((d) => d.count === 0 && d.percent === 0));

  const rounding = scaleStats(['7', '7', '8'], {});
  assert.equal(rounding.meanText, '7,3');
});

test('choiceStats: Optionsreihenfolge, unbekannte IDs ignoriert, Marker bei multi', () => {
  const options = [{ id: 'b2', label: 'Zwei' }, { id: 'a1', label: 'Eins' }, { id: 'c3', label: 'Drei' }];
  const single = choiceStats(['a1', 'a1', 'b2', 'zz', ''], { options }, false);
  assert.equal(single.n, 3);
  assert.deepEqual(single.options.map((o) => [o.id, o.count]), [['b2', 1], ['a1', 2], ['c3', 0]]);
  assert.equal(Math.round(single.options[1].percent), 67);

  const multi = choiceStats(['', '', 'a1', 'b2', 'a1', 'zz'], { options, maxChoices: 0 }, true);
  assert.equal(multi.n, 2);
  assert.deepEqual(multi.options.map((o) => o.count), [1, 2, 0]);
  assert.equal(multi.options[1].percent, 100);

  const none = choiceStats([], { options }, true);
  assert.equal(none.n, 0);
  assert.ok(none.options.every((o) => o.percent === 0));
});

test('textAnswers: leere entfernt, Inhalt vollständig', () => {
  const out = textAnswers(['eins', '', '   ', 'zwei', 'drei\nmit Umbruch']);
  assert.deepEqual([...out].sort(), ['drei\nmit Umbruch', 'eins', 'zwei']);
});

test('buildResults: alle Typen, n von N, Reihenfolge nach position', () => {
  const survey = { id: 1, title: 'Test', intro: '', status: 'closed', response_count: 4, opened_at: null, closed_at: null };
  const options = [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }];
  const questions = [
    { id: 12, position: 2, type: 'single', title: 'Zwei', help: '', required: 1, config: { options } },
    { id: 11, position: 1, type: 'scale', title: 'Eins', help: '', required: 0, config: { min: 1, max: 10 } },
    { id: 13, position: 3, type: 'multi', title: 'Drei', help: '', required: 0, config: { options } },
    { id: 14, position: 4, type: 'longtext', title: 'Vier', help: '', required: 0, config: {} },
    { id: 15, position: 5, type: 'text', title: 'Fünf', help: '', required: 0, config: {} },
  ];
  const answers = new Map([
    [11, ['5', '6']], [12, ['x', 'y', 'y', 'x']], [13, ['', 'x', 'y']], [14, ['a', 'b', 'c']],
  ]);
  const r = buildResults(survey, questions, answers);
  assert.equal(r.total, 4);
  assert.deepEqual(r.questions.map((q) => q.title), ['Eins', 'Zwei', 'Drei', 'Vier', 'Fünf']);
  assert.deepEqual(r.questions.map((q) => q.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.questions.map((q) => q.n), [2, 4, 1, 3, 0]);
  assert.equal(r.questions[0].answeredText, '2 von 4 haben geantwortet');
  assert.equal(r.questions[4].answers.length, 0);
  assert.equal(answeredText(0, 3), '0 von 3 haben geantwortet');
  // Objekt statt Map geht auch
  assert.equal(buildResults(survey, questions, { 14: ['z'] }).questions[3].n, 1);
});

// ---------------------------------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------------------------------

async function login(app) {
  const res = await fetch(`${app.url}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: app.url },
    body: 'username=admin&password=geheim-genug-123',
  });
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie').split(';')[0];
}

function insertSurvey(db, { status, responses, min = 3, title }) {
  const slug = crypto.randomBytes(16).toString('base64url');
  const info = db.prepare(`INSERT INTO surveys (slug, title, intro, status, min_responses, response_count, created_at, opened_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, title, 'Einleitung mit Ümlauten', status, min, responses,
    '2026-11-01T08:00:00.000Z', '2026-11-02T08:00:00.000Z', status === 'closed' ? '2026-11-09T16:00:00.000Z' : null);
  return Number(info.lastInsertRowid);
}

function insertQuestion(db, surveyId, position, type, title, config, values) {
  const info = db.prepare('INSERT INTO questions (survey_id, position, type, title, help, required, config) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(surveyId, position, type, title, '', JSON.stringify(config));
  const qid = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO answers (id, question_id, value) VALUES (?, ?, ?)');
  for (const v of values) ins.run(crypto.randomUUID(), qid, v);
  return qid;
}

test('HTTP: Auswertung und PDF nur für geschlossene Umfragen mit genug Teilnahmen', async (t) => {
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/server');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-results-'));
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'geheim-genug-123',
  });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const closedId = insertSurvey(app.db, { status: 'closed', responses: 3, title: 'Größe <script>alert(1)</script>' });
  const options = [{ id: 'o1', label: 'Gut' }, { id: 'o2', label: 'Schlecht' }];
  insertQuestion(app.db, closedId, 1, 'scale', 'Zufriedenheit', { min: 1, max: 10 }, ['7', '8', '9']);
  insertQuestion(app.db, closedId, 2, 'single', 'Bewertung', { options }, ['o1', 'o1', 'o2']);
  insertQuestion(app.db, closedId, 3, 'multi', 'Angebote', { options, maxChoices: 0 }, ['', '', 'o1', 'o2', 'o1']);
  insertQuestion(app.db, closedId, 4, 'longtext', 'Frage mit <b>HTML</b>', {}, ['Antwort <i>eins</i>', 'Weißwurst 😀', 'drei']);
  insertQuestion(app.db, closedId, 5, 'text', 'Optional leer', {}, []);
  const openId = insertSurvey(app.db, { status: 'open', responses: 5, title: 'Noch offen' });
  const fewId = insertSurvey(app.db, { status: 'closed', responses: 2, title: 'Zu wenige' });

  // ohne Anmeldung → Login
  const anon = await fetch(`${app.url}/admin/surveys/${closedId}/results`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  const anonPdf = await fetch(`${app.url}/admin/surveys/${closedId}/results.pdf`, { redirect: 'manual' });
  assert.equal(anonPdf.status, 303);

  const sid = await login(app);
  const get = (p) => fetch(`${app.url}${p}`, { headers: { cookie: sid }, redirect: 'manual' });

  const page = await get(`/admin/surveys/${closedId}/results`);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /Größe &lt;script&gt;/);
  assert.match(body, /Frage mit &lt;b&gt;HTML&lt;\/b&gt;/);
  assert.match(body, /Antwort &lt;i&gt;eins&lt;\/i&gt;/);
  assert.match(body, /3 von 3 haben geantwortet/);
  assert.match(body, /2 von 3 haben geantwortet/); // multi: zwei Marker
  assert.match(body, /0 von 3 haben geantwortet/);
  assert.match(body, /Durchschnitt/);
  assert.match(body, /bar-fill w-67/);
  assert.match(body, /results\.pdf/);
  assert.doesNotMatch(body, /style="/);

  const pdf = await get(`/admin/surveys/${closedId}/results.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="umfrage-groesse-script-alert-1-script-ergebnis\.pdf"; filename\*=UTF-8''umfrage-gr%C3%B6%C3%9Fe-/);
  assert.equal(pdf.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');

  const open = await get(`/admin/surveys/${openId}/results`);
  assert.equal(open.status, 200);
  assert.match(await open.text(), /noch nicht verfügbar/);
  assert.equal((await get(`/admin/surveys/${openId}/results.pdf`)).status, 409);
  assert.equal((await get(`/admin/surveys/${fewId}/results.pdf`)).status, 409);
  assert.equal((await get('/admin/surveys/99999/results')).status, 404);
  assert.equal((await get('/admin/surveys/abc/results.pdf')).status, 404);
});

test('buildResults: Fragen unter der Mindestzahl werden ausgeblendet (Regel 5/12)', () => {
  const survey = { id: 1, title: 'Test', intro: '', status: 'closed', min_responses: 3, response_count: 3, opened_at: null, closed_at: null };
  const options = [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }];
  const questions = [
    { id: 1, position: 1, type: 'scale', title: 'Skala', help: '', required: 0, config: { min: 0, max: 5 } },
    { id: 2, position: 2, type: 'longtext', title: 'Lang', help: '', required: 0, config: {} },
    { id: 3, position: 3, type: 'multi', title: 'Mehr', help: '', required: 0, config: { options } },
    { id: 4, position: 4, type: 'single', title: 'Eine', help: '', required: 0, config: { options } },
    { id: 5, position: 5, type: 'text', title: 'Leer', help: '', required: 0, config: {} },
  ];
  const answers = new Map([
    [1, ['4']], [2, ['nur eine Person', 'und noch eine']], [3, ['', 'x', 'y']], [4, ['x', 'y', 'x']],
  ]);
  const r = buildResults(survey, questions, answers);
  const [sc, lt, mu, si, leer] = r.questions;
  for (const q of [sc, lt, mu]) {
    assert.equal(q.suppressed, true, q.title);
    assert.equal(q.scale, undefined);
    assert.equal(q.choice, undefined);
    assert.equal(q.answers, undefined);
    assert.match(q.suppressedText, /^Zu wenige Antworten \(\d\), zum Schutz der Anonymität ausgeblendet\.$/);
  }
  assert.deepEqual(sc.range, { min: 0, max: 5 });
  assert.equal(lt.n, 2);
  assert.equal(lt.answeredText, '2 von 3 haben geantwortet');
  assert.equal(JSON.stringify(r).includes('nur eine Person'), false);
  assert.equal(si.suppressed, false);
  assert.equal(si.choice.n, 3);
  // n = 0 verrät nichts und wird normal angezeigt
  assert.equal(leer.suppressed, false);
  assert.deepEqual(leer.answers, []);

  // HTML und PDF zeigen nur den Hinweis
  const { resultsBody } = require('../src/views/results');
  const page = String(resultsBody(r, { version: '1.2.3' }));
  assert.equal((page.match(/zum Schutz der Anonymität ausgeblendet/g) || []).length, 3);
  assert.equal(page.includes('nur eine Person'), false);
  const { renderResultsPdf } = require('../src/pdf');
  return renderResultsPdf(r, { version: '1.2.3', integrityText: 'x' }).then((buf) => {
    assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');
  });
});
