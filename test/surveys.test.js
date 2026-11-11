'use strict';

// Tests für Umfragen, Fragen, Teilnahme und Adminoberfläche (SPEC §3, §5, §7, §11).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const s = require('../src/surveys');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

function setup() {
  const db = openDatabase(':memory:');
  const id = s.createSurvey(db, { title: 'Mitarbeiterumfrage' });
  return { db, id };
}

function q(db, id, form) {
  return s.addQuestion(db, id, form);
}

test('Fragetypen: Validierung der Konfiguration', () => {
  const { db, id } = setup();
  assert.throws(() => q(db, id, { type: 'single', title: 'Nur eine', options: 'A' }), (e) => Boolean(e instanceof s.ValidationError && e.errors.options));
  assert.throws(() => q(db, id, { type: 'single', title: 'Doppelt', options: 'A\na' }), (e) => Boolean(/nur einmal/.test(e.errors.options)));
  assert.throws(() => q(db, id, { type: 'scale', title: 'Skala', scaleMin: '2', scaleMax: '10' }), (e) => Boolean(e.errors.scaleMin));
  assert.throws(() => q(db, id, { type: 'scale', title: 'Skala', scaleMin: '1', scaleMax: '11' }), (e) => Boolean(e.errors.scaleMax));
  assert.throws(() => q(db, id, { type: 'nix', title: 'x' }), (e) => Boolean(e.errors.type));
  assert.throws(() => q(db, id, { type: 'text', title: '  ' }), (e) => Boolean(e.errors.title));
  assert.throws(() => q(db, id, { type: 'multi', title: 'M', options: 'a\nb', maxChoices: '3' }), (e) => Boolean(e.errors.maxChoices));

  const scaleId = q(db, id, { type: 'scale', title: 'Zufriedenheit', minLabel: 'gar nicht', maxLabel: 'sehr' });
  const question = s.getQuestion(db, id, scaleId);
  assert.deepEqual(question.config, { min: 1, max: 10, minLabel: 'gar nicht', maxLabel: 'sehr' });
  const textId = q(db, id, { type: 'text', title: 'Kurz' });
  assert.equal(s.getQuestion(db, id, textId).config.maxLength, 500);
  const longId = q(db, id, { type: 'longtext', title: 'Lang', maxLength: '' });
  assert.equal(s.getQuestion(db, id, longId).config.maxLength, 5000);
  assert.deepEqual(s.getQuestions(db, id).map((x) => x.position), [1, 2, 3]);
  db.close();
});

test('Option-IDs bleiben beim Bearbeiten stabil', () => {
  const { db, id } = setup();
  const qid = q(db, id, { type: 'single', title: 'Team', options: 'Vertrieb\nTechnik\nVerwaltung' });
  const before = s.getQuestion(db, id, qid).config.options;
  assert.equal(before.length, 3);
  assert.ok(before.every((o) => /^[0-9a-f]{6}$/.test(o.id)));
  // Umsortieren, eine umbenennen (Position 3), eine neu
  s.updateQuestion(db, id, qid, { type: 'single', title: 'Team', options: 'Technik\nVertrieb\nVerwaltung & Einkauf\nSonstiges' });
  const after = s.getQuestion(db, id, qid).config.options;
  const byLabel = Object.fromEntries(after.map((o) => [o.label, o.id]));
  assert.equal(byLabel.Technik, before[1].id);
  assert.equal(byLabel.Vertrieb, before[0].id);
  assert.equal(byLabel['Verwaltung & Einkauf'], before[2].id);
  assert.ok(!before.some((o) => o.id === byLabel.Sonstiges));
  db.close();
});

test('Reihenfolge: verschieben und löschen nummeriert neu', () => {
  const { db, id } = setup();
  const a = q(db, id, { type: 'text', title: 'A' });
  const b = q(db, id, { type: 'text', title: 'B' });
  const c = q(db, id, { type: 'text', title: 'C' });
  s.moveQuestion(db, id, c, 'up');
  assert.deepEqual(s.getQuestions(db, id).map((x) => x.title), ['A', 'C', 'B']);
  s.moveQuestion(db, id, a, 'up'); // schon oben: keine Änderung
  s.deleteQuestion(db, id, a);
  assert.deepEqual(s.getQuestions(db, id).map((x) => [x.title, x.position]), [['C', 1], ['B', 2]]);
  assert.ok(b);
  db.close();
});

test('Statuswechsel: öffnen ohne Fragen verboten, eingefroren, schließen endgültig', () => {
  const { db, id } = setup();
  assert.throws(() => s.openSurvey(db, id), /mindestens eine Frage/);
  const qid = q(db, id, { type: 'text', title: 'A' });
  s.openSurvey(db, id);
  assert.equal(s.getSurvey(db, id).status, 'open');
  assert.ok(s.getSurvey(db, id).opened_at);
  assert.throws(() => q(db, id, { type: 'text', title: 'B' }), /nur im Entwurf/);
  assert.throws(() => s.updateQuestion(db, id, qid, { type: 'text', title: 'neu' }), /nur im Entwurf/);
  assert.throws(() => s.deleteQuestion(db, id, qid), /nur im Entwurf/);
  assert.throws(() => s.moveQuestion(db, id, qid, 'down'), /nur im Entwurf/);
  assert.throws(() => s.updateSurveyMeta(db, id, { title: 'x', min_responses: '5' }), /nur im Entwurf/);
  s.closeSurvey(db, id);
  assert.equal(s.getSurvey(db, id).status, 'closed');
  assert.throws(() => s.openSurvey(db, id), /nicht wieder geöffnet/);
  assert.throws(() => s.closeSurvey(db, id), /bereits geschlossen/);
  assert.throws(() => s.submitResponse(db, id, { [`q${qid}`]: 'x' }), s.SurveyError);
  db.close();
});

test('Teilnahme: Validierung aller Typen, Pflichtfragen, Atomarität', () => {
  const { db, id } = setup();
  const t = q(db, id, { type: 'text', title: 'Kurz', required: '1', maxLength: '10' });
  const l = q(db, id, { type: 'longtext', title: 'Lang' });
  const sc = q(db, id, { type: 'scale', title: 'Skala', scaleMin: '0', scaleMax: '5', required: '1' });
  const si = q(db, id, { type: 'single', title: 'Eine', options: 'Ja\nNein' });
  const mu = q(db, id, { type: 'multi', title: 'Mehrere', options: 'A\nB\nC', maxChoices: '2' });
  s.openSurvey(db, id);
  const opts = (qid) => s.getQuestion(db, id, qid).config.options.map((o) => o.id);
  const [ja] = opts(si);
  const [oa, ob, oc] = opts(mu);

  const bad = s.submitResponse(db, id, {
    [`q${t}`]: '  ',
    [`q${sc}`]: '6',
    [`q${si}`]: 'falsch',
    [`q${mu}`]: [oa, ob, oc],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[t] && bad.errors[sc] && bad.errors[si] && bad.errors[mu]);
  assert.equal(bad.errors[l], undefined);
  assert.deepEqual(bad.values[mu], [oa, ob, oc]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 0);
  assert.equal(s.getSurvey(db, id).response_count, 0);

  assert.equal(s.submitResponse(db, id, { [`q${t}`]: 'x'.repeat(11), [`q${sc}`]: '3' }).errors[t] !== undefined, true);
  assert.equal(s.submitResponse(db, id, { [`q${t}`]: 'ok', [`q${sc}`]: '3', [`q${mu}`]: [oa, oa] }).ok, false);
  assert.equal(s.submitResponse(db, id, { [`q${t}`]: 'ok', [`q${sc}`]: '3.5' }).ok, false);

  const good = s.submitResponse(db, id, {
    [`q${t}`]: ' Hallo\u0007 ',
    [`q${l}`]: 'Zeile 1\r\nZeile 2',
    [`q${sc}`]: '0',
    [`q${si}`]: ja,
    [`q${mu}`]: [oa, oc],
  });
  assert.equal(good.ok, true);
  assert.deepEqual(s.getAnswersByQuestion(db, t), ['Hallo']);
  assert.deepEqual(s.getAnswersByQuestion(db, l), ['Zeile 1\nZeile 2']);
  assert.deepEqual(s.getAnswersByQuestion(db, sc), ['0']);
  assert.deepEqual(s.getAnswersByQuestion(db, si), [ja]);
  assert.deepEqual(s.getAnswersByQuestion(db, mu).sort(), ['', oa, oc].sort());
  assert.equal(s.getSurvey(db, id).response_count, 1);

  // Optionale leere Antworten werden nicht gespeichert
  assert.equal(s.submitResponse(db, id, { [`q${t}`]: 'zwei', [`q${sc}`]: '1' }).ok, true);
  assert.equal(s.getAnswersByQuestion(db, l).length, 1);
  assert.equal(s.getAnswersByQuestion(db, mu).length, 3);

  const ids = db.prepare('SELECT id FROM answers').all().map((r) => r.id);
  assert.ok(ids.every((x) => /^[0-9a-f-]{36}$/.test(x)));
  db.close();
});

test('Ergebnisse gesperrt solange offen bzw. unter Mindestanzahl', () => {
  const { db, id } = setup();
  const t = q(db, id, { type: 'text', title: 'A' });
  assert.equal(s.resultsAvailable(s.getSurvey(db, id)).ok, false);
  s.openSurvey(db, id);
  s.submitResponse(db, id, { [`q${t}`]: 'eins' });
  s.submitResponse(db, id, { [`q${t}`]: 'zwei' });
  s.submitResponse(db, id, { [`q${t}`]: 'drei' });
  const open = s.resultsAvailable(s.getSurvey(db, id));
  assert.equal(open.ok, false);
  assert.match(open.reason, /noch offen/);
  s.closeSurvey(db, id);
  assert.deepEqual(s.resultsAvailable(s.getSurvey(db, id)), { ok: true, reason: '' });

  const id2 = s.createSurvey(db, { title: 'Klein' });
  s.updateSurveyMeta(db, id2, { title: 'Klein', min_responses: '5' });
  const t2 = q(db, id2, { type: 'text', title: 'A' });
  s.openSurvey(db, id2);
  s.submitResponse(db, id2, { [`q${t2}`]: 'x' });
  s.closeSurvey(db, id2);
  const few = s.resultsAvailable(s.getSurvey(db, id2));
  assert.equal(few.ok, false);
  assert.match(few.reason, /1 von mindestens 5/);
  assert.throws(() => s.updateSurveyMeta(db, id2, { title: 'x', min_responses: '1' }), /nur im Entwurf/);
  db.close();
});

test('Automatisches Schließen, Duplizieren, Löschen', () => {
  const { db, id } = setup();
  const t = q(db, id, { type: 'text', title: 'A' });
  s.openSurvey(db, id);
  db.prepare('UPDATE surveys SET closes_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, id);
  assert.equal(s.getSurvey(db, id).status, 'closed');
  assert.ok(s.getSurvey(db, id).closed_at);
  assert.throws(() => s.submitResponse(db, id, { [`q${t}`]: 'zu spät' }), s.SurveyError);

  const copy = s.duplicateSurvey(db, id, null);
  const dup = s.getSurvey(db, copy);
  assert.equal(dup.status, 'draft');
  assert.equal(dup.response_count, 0);
  assert.notEqual(dup.slug, s.getSurvey(db, id).slug);
  assert.match(dup.slug, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(dup.title, 'Mitarbeiterumfrage (Kopie)');
  assert.equal(s.getQuestions(db, copy).length, 1);

  assert.equal(s.isDeleteConfirmation(dup, 'LÖSCHEN'), true);
  assert.equal(s.isDeleteConfirmation(dup, 'Mitarbeiterumfrage (Kopie)'), true);
  assert.equal(s.isDeleteConfirmation(dup, 'nein'), false);
  s.deleteSurvey(db, copy);
  assert.equal(s.getSurvey(db, copy), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE survey_id = ?').get(copy).n, 0);
  db.close();
});

test('Ortszeit Berlin für datetime-local', () => {
  const sec = s.parseLocalDateTime('2026-07-01T12:00');
  assert.equal(new Date(sec * 1000).toISOString(), '2026-07-01T10:00:00.000Z');
  const winter = s.parseLocalDateTime('2026-12-24T18:30');
  assert.equal(new Date(winter * 1000).toISOString(), '2026-12-24T17:30:00.000Z');
  assert.equal(s.formatLocalDateTime(winter), '2026-12-24T18:30');
  assert.ok(Number.isNaN(s.parseLocalDateTime('2026-02-30T10:00')));
});

// ---------------------------------------------------------------------------
// HTTP Ende-zu-Ende: Adminbereich und Teilnahme (Auswertung und PDF: test/e2e.test.js, test/results.test.js)
// ---------------------------------------------------------------------------

function form(data) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return p.toString();
}

test('HTTP: Umfrage bauen, öffnen, anonym teilnehmen, schließen', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-surveys-'));
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'geheim-genug-123',
  });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = app.url;

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=geheim-genug-123',
  });
  let sid = login.headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(`${base}${p}`, { headers: { cookie: sid }, redirect: 'manual' });
  let csrf = (await (await get('/admin')).text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (p, data) => fetch(`${base}${p}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: form({ _csrf: csrf, ...data }),
  });

  // Anlegen
  const created = await post('/admin/surveys', { title: 'Team <script>alert(1)</script>' });
  assert.equal(created.status, 303);
  const surveyPath = created.headers.get('location').split('?')[0];
  assert.match(surveyPath, /^\/admin\/surveys\/\d+$/);
  const editor = await (await get(surveyPath)).text();
  assert.match(editor, /Team &lt;script&gt;/);
  assert.doesNotMatch(editor, /<script>alert/);
  assert.doesNotMatch(editor, /style="/);

  // Fragen
  assert.equal((await post(`${surveyPath}/questions`, { type: 'scale', title: 'Wie zufrieden?', required: '1' })).status, 303);
  assert.equal((await post(`${surveyPath}/questions`, { type: 'longtext', title: 'Was fehlt <b>dir</b>?' })).status, 303);
  assert.equal((await post(`${surveyPath}/questions`, { type: 'multi', title: 'Was nutzt du?', options: 'Kaffee\nTee\nWasser' })).status, 303);
  const invalid = await post(`${surveyPath}/questions`, { type: 'single', title: 'Kaputt', options: 'nur eine' });
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /mindestens 2 Optionen/);
  assert.equal((await post(`${surveyPath}/open`, {})).status, 303);
  const overview = await (await get(surveyPath)).text();
  const slug = overview.match(/\/u\/([A-Za-z0-9_-]{22})/)[1];
  assert.match(overview, /Ergebnisse gesperrt/);
  assert.match(overview, /noch offen/);

  // Nach dem Öffnen keine Änderung mehr
  assert.equal((await post(`${surveyPath}/questions`, { type: 'text', title: 'Neu' })).status, 409);

  // Öffentliche Seite: keine Cookies, no-store, escaped
  const pub = await fetch(`${base}/u/${slug}`, { headers: { cookie: sid } });
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('set-cookie'), null);
  assert.equal(pub.headers.get('cache-control'), 'no-store');
  const pubHtml = await pub.text();
  assert.match(pubHtml, /Was fehlt &lt;b&gt;dir&lt;\/b&gt;\?/);
  assert.match(pubHtml, /keine Cookies, keine IP-Speicherung/);
  assert.doesNotMatch(pubHtml, /Abmelden/);
  assert.doesNotMatch(pubHtml, /style="/);
  const ids = [...pubHtml.matchAll(/name="(q\d+)"/g)].map((m) => m[1]);
  const [qScale, qLong, qMulti] = [...new Set(ids)];
  const optionIds = [...pubHtml.matchAll(new RegExp(`name="${qMulti}" value="([0-9a-f]{6})"`, 'g'))].map((m) => m[1]);
  assert.equal(optionIds.length, 3);

  // Fehler → 422 mit erhaltenen Werten
  const bad = await fetch(`${base}/u/${slug}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ [qLong]: 'Behalte mich', [qMulti]: [optionIds[1]] }),
  });
  assert.equal(bad.status, 422);
  const badHtml = await bad.text();
  assert.match(badHtml, /Behalte mich/);
  assert.match(badHtml, new RegExp(`value="${optionIds[1]}" checked`));
  assert.match(badHtml, /Bitte einen Wert auswählen/);

  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${base}/u/${slug}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ [qScale]: String(i + 5), [qLong]: `Antwort ${i}`, [qMulti]: [optionIds[0], optionIds[2]] }),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/u/${slug}/danke`);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  const thanks = await fetch(`${base}/u/${slug}/danke`);
  assert.equal(thanks.status, 200);
  assert.match(await thanks.text(), /data-done-slug="/);

  // Entwurf und Unbekanntes → 404
  assert.equal((await fetch(`${base}/u/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  assert.equal((await fetch(`${base}/u/kurz`)).status, 404);

  // Solange offen: weder Inhalte noch die Zahl der Teilnahmen (sie verriete den Zeitpunkt jeder Teilnahme)
  const counted = await (await get(surveyPath)).text();
  assert.match(counted, /data-count-hidden><span class="stat-value">–<\/span><span class="stat-label">Teilnahmen/);
  assert.doesNotMatch(counted, /<span class="stat-value">3<\/span><span class="stat-label">Teilnahmen/);
  assert.doesNotMatch(counted, /und 3 Teilnahmen/);
  assert.doesNotMatch(counted, /Antwort 0/);
  const listOpen = await (await get('/admin')).text();
  assert.match(listOpen, /<td class="num"><span class="muted" title="Die Zahl erscheint erst nach dem Schließen">–<\/span><\/td>/);

  // Schließen nur mit Bestätigung
  assert.equal((await post(`${surveyPath}/close`, {})).status, 422);
  assert.equal((await post(`${surveyPath}/close`, { confirm: 'ja' })).status, 303);
  assert.equal((await post(`${surveyPath}/open`, {})).status, 409);
  const closedPub = await fetch(`${base}/u/${slug}`);
  assert.match(await closedPub.text(), /Diese Umfrage ist abgeschlossen/);
  const late = await fetch(`${base}/u/${slug}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ [qScale]: '5' }),
  });
  assert.equal(late.status, 409);
  const closedView = await (await get(surveyPath)).text();
  assert.match(closedView, /\/results"/);
  assert.match(closedView, /\/results\.pdf"/);

  // Vorschau, Duplizieren, Löschen
  const preview = await get(`${surveyPath}/preview`);
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Vorschau/);
  const dup = await post(`${surveyPath}/duplicate`, {});
  assert.equal(dup.status, 303);
  const dupPath = dup.headers.get('location').split('?')[0];
  assert.notEqual(dupPath, surveyPath);
  assert.equal((await post(`${dupPath}/delete`, { confirm: 'falsch' })).status, 422);
  assert.equal((await post(`${dupPath}/delete`, { confirm: 'löschen' })).status, 303);
  assert.equal((await get(dupPath)).status, 404);

  // Admins
  assert.equal((await get('/admin/admins')).status, 200);
  assert.equal((await post('/admin/admins', { username: 'zweite', display_name: 'Zweite', password: 'noch-ein-passwort', password2: 'noch-ein-passwort' })).status, 303);
  assert.equal((await post('/admin/admins', { username: 'zweite', password: 'noch-ein-passwort', password2: 'noch-ein-passwort' })).status, 422);
  const list = await (await get('/admin/admins')).text();
  const otherId = list.match(/\/admin\/admins\/(\d+)\/delete/)[1];
  assert.equal((await post(`/admin/admins/${otherId}/delete`, {})).status, 303);
  assert.equal((await post('/admin/passwort', { current: 'falsch-falsch', password: 'neues-passwort-1', password2: 'neues-passwort-1' })).status, 422);
  const changed = await post('/admin/passwort', { current: 'geheim-genug-123', password: 'neues-passwort-1', password2: 'neues-passwort-1' });
  assert.equal(changed.status, 303);
  const oldSid = sid;
  sid = changed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(sid, oldSid);
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie: oldSid }, redirect: 'manual' })).status, 303);
  const fresh = await get('/admin');
  assert.equal(fresh.status, 200);
  csrf = (await fresh.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  assert.ok(csrf);
});

test('Teilnahme ohne jede Antwort wird abgelehnt und nicht gezählt (Regel 5)', () => {
  const { db, id } = setup();
  const t = q(db, id, { type: 'text', title: 'Freiwillig' });
  const sc = q(db, id, { type: 'scale', title: 'Skala' });
  s.openSurvey(db, id);
  for (const form of [{}, { [`q${t}`]: '   ' }, { [`q${t}`]: '', [`q${sc}`]: '' }]) {
    const res = s.submitResponse(db, id, form);
    assert.equal(res.ok, false);
    assert.equal(res.errors._form, 'Bitte mindestens eine Frage beantworten.');
  }
  assert.equal(s.getSurvey(db, id).response_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 0);
  assert.equal(s.submitResponse(db, id, { [`q${sc}`]: '7' }).ok, true);
  assert.equal(s.getSurvey(db, id).response_count, 1);

  // Fehlermeldung erscheint im Formular
  const { surveyFormPage } = require('../src/views/survey');
  const page = surveyFormPage({ survey: s.getSurvey(db, id), questions: s.getQuestions(db, id), errors: { _form: 'Bitte mindestens eine Frage beantworten.' } });
  assert.match(page, /role="alert"[^]*Bitte mindestens eine Frage beantworten\./);
  db.close();
});

test('VACUUM: Fehlschlag wird gemeldet, vorgemerkt und beim Schließen nachgeholt (Regel 13)', (t) => {
  const { db, id } = setup();
  const qt = q(db, id, { type: 'text', title: 'A' });
  s.openSurvey(db, id);
  const exec = db.exec.bind(db);
  let fail = true;
  db.exec = (sql) => {
    if (fail && /^\s*VACUUM\s*$/i.test(sql)) throw Object.assign(new Error('database is locked: geheim'), { errcode: 5 });
    return exec(sql);
  };
  const written = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return true;
  };
  t.after(() => { process.stderr.write = origWrite; });
  try {
    assert.equal(s.submitResponse(db, id, { [`q${qt}`]: 'Inhalt-der-Antwort' }).ok, true);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(s.isVacuumPending(db), true);
  assert.deepEqual(written, ['[warnung] VACUUM fehlgeschlagen (5)\n']);
  assert.equal(written.join('').includes('Inhalt'), false);
  assert.equal(written.join('').includes('geheim'), false);

  fail = false;
  s.closeSurvey(db, id);
  assert.equal(s.isVacuumPending(db), false);
  db.close();
});

test('Datenbankdatei: Antworten liegen nach VACUUM nach ID geordnet, jede genau einmal (Regel 13)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-vacuum-'));
  try {
    const file = path.join(dir, 'umfrage.db');
    const db = openDatabase(file);
    const id = s.createSurvey(db, { title: 'Datei' });
    const q1 = q(db, id, { type: 'text', title: 'Eins' });
    const q2 = q(db, id, { type: 'text', title: 'Zwei' });
    s.openSurvey(db, id);
    const values = [];
    for (let p = 1; p <= 5; p += 1) {
      const form = { [`q${q1}`]: `P${p}_Q1_ende`, [`q${q2}`]: `P${p}_Q2_ende` };
      values.push(form[`q${q1}`], form[`q${q2}`]);
      assert.equal(s.submitResponse(db, id, form).ok, true);
    }
    const byId = db.prepare('SELECT value FROM answers ORDER BY id').all().map((r) => r.value);
    db.close();
    assert.ok(!fs.existsSync(`${file}-journal`));
    const raw = fs.readFileSync(file).toString('latin1');
    const offsets = new Map();
    for (const v of values) {
      const first = raw.indexOf(v);
      assert.ok(first >= 0, `${v} fehlt`);
      assert.equal(raw.indexOf(v, first + 1), -1, `${v} kommt mehrfach vor (Reste in freien Seiten?)`);
      offsets.set(v, first);
    }
    const byFile = [...values].sort((a, b) => offsets.get(a) - offsets.get(b));
    const reversed = [...byId].reverse();
    assert.ok(
      JSON.stringify(byFile) === JSON.stringify(byId) || JSON.stringify(byFile) === JSON.stringify(reversed),
      `Dateireihenfolge folgt nicht der ID-Reihenfolge: ${byFile.join(',')}`,
    );
    // Gegenprobe: Die Reihenfolge des Absendens ist (bei 10 zufälligen IDs) praktisch nie die der Datei.
    assert.notDeepEqual(byFile, values);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
