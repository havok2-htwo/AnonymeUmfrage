'use strict';

// Regressionstests für die Anonymitätsregeln (SPEC §3), die ein Umbau leicht unbemerkt brechen könnte:
// nichts im Log beim Teilnehmen, keine Zugriffe auf IP- oder Browserdaten im Code, Mischen in der
// Auswertung, no-store auf allen öffentlichen Antworten, Sperre bei ungültiger Mindestzahl, Löschen der
// Antworten beim Schließen unter der Mindestzahl, verborgene Teilnahmezahl, Umfrage-Code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const s = require('../src/surveys');
const { buildResults } = require('../src/results');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

const PASSWORD = 'geheim-genug-123';

function form(data) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined) p.append(k, v);
  }
  return p.toString();
}

/**
 * Fängt Textausgaben ab, die während fn() auf stdout/stderr geschrieben werden. Die Anwendung schreibt
 * nur Strings; der Test-Runner schickt seine Ergebnisse als Binärdaten über stdout, die gehen durch.
 */
async function captureOutput(fn) {
  const written = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const trap = (orig, stream) => (chunk, ...rest) => {
    if (typeof chunk === 'string') {
      written.push(chunk);
      return true;
    }
    return orig.call(stream, chunk, ...rest);
  };
  process.stdout.write = trap(out, process.stdout);
  process.stderr.write = trap(err, process.stderr);
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return written;
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

test('Code: kein Zugriff auf IP-Adresse, User-Agent, Weiterleitungs-Header oder console.* (Regel 1)', () => {
  const root = path.join(__dirname, '..');
  const files = [...listFiles(path.join(root, 'src')), ...listFiles(path.join(root, 'public', 'js'))]
    .filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  const forbidden = [
    /remoteAddress/, /socket\.address/, /x-forwarded-for/i, /x-real-ip/i, /forwarded['"\]]/i,
    /user-agent/i, /req\.headers\.referer/i, /\bconsole\.(log|info|debug|warn|error)\b/,
    /navigator\.sendBeacon/, /\bfetch\(/, /XMLHttpRequest/,
  ];
  const hits = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    // Die CLI läuft nur im Terminal und darf mit dem Menschen davor reden; integrity.js spricht mit GitHub.
    if (rel === 'src/cli.js' || rel === 'src/integrity.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of forbidden) if (re.test(text)) hits.push(`${rel}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('Auswertung: Freitexte kommen bei wiederholtem Abruf in wechselnder Reihenfolge (Regel 3)', () => {
  const survey = { id: 1, title: 'T', status: 'closed', response_count: 8, min_responses: 3 };
  const questions = [{ id: 1, position: 1, type: 'text', title: 'F', config: {} }];
  const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const orders = new Set();
  for (let i = 0; i < 20; i += 1) {
    const r = buildResults(survey, questions, new Map([[1, values]]));
    assert.deepEqual([...r.questions[0].answers].sort(), values);
    orders.add(r.questions[0].answers.join(''));
  }
  assert.ok(orders.size > 1, 'Die Reihenfolge ändert sich nie');
});

test('Ergebnissperre schlägt sicher fehl, wenn min_responses fehlt oder ungültig ist (Regel 5)', () => {
  for (const min of [undefined, null, NaN, 'drei', {}]) {
    const r = s.resultsAvailable({ status: 'closed', response_count: 50, min_responses: min });
    assert.equal(r.ok, false, `min_responses=${String(min)}`);
  }
  assert.equal(s.resultsAvailable({ status: 'closed', response_count: 3, min_responses: 3 }).ok, true);
  assert.equal(s.resultsAvailable({ status: 'closed', response_count: 2, min_responses: 3 }).ok, false);
  assert.match(s.resultsAvailable({ status: 'closed', response_count: 5, min_responses: null }).reason, /ungültig/);
  assert.match(s.resultsAvailable({ status: 'closed', response_count: 0, min_responses: 3 }).reason, /keine Teilnahmen/);
  assert.match(s.resultsAvailable({ status: 'closed', response_count: 2, min_responses: 3 }).reason, /gelöscht/);
});

test('Löschen unter der Mindestzahl wird nach einem Fehlschlag im Minutentakt nachgeholt', async () => {
  const db = openDatabase(':memory:');
  const id = s.createSurvey(db, { title: 'Nachholen' });
  const qid = s.addQuestion(db, id, { type: 'text', title: 'Text' });
  s.openSurvey(db, id);
  assert.equal(s.submitResponse(db, id, { [`q${qid}`]: 'BLEIBT-NICHT' }).ok, true);
  db.prepare('UPDATE surveys SET closes_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, id);
  const prepare = db.prepare.bind(db);
  let fail = true;
  db.prepare = (sql) => {
    if (fail && /^DELETE FROM answers/.test(sql)) throw Object.assign(new Error('disk full'), { errcode: 13 });
    return prepare(sql);
  };
  // Automatisches Schließen beim Zugriff: kein Fehler nach außen, Antwort bleibt zunächst stehen
  assert.equal(s.getSurvey(db, id).status, 'closed');
  assert.equal(prepare('SELECT COUNT(*) AS n FROM answers').get().n, 1);
  fail = false;
  const timer = s.startAutoClose(db, 10);
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(timer);
  assert.equal(prepare('SELECT COUNT(*) AS n FROM answers').get().n, 0);
  db.close();
});

test('Schließen unter der Mindestzahl löscht die Antworten, auch aus der Datei (Regel 5, 13)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-purge-'));
  try {
    const file = path.join(dir, 'umfrage.db');
    const db = openDatabase(file);
    // Umfrage A: von Hand geschlossen, 1 von 3 Teilnahmen
    const a = s.createSurvey(db, { title: 'A' });
    const qa = s.addQuestion(db, a, { type: 'text', title: 'Text' });
    s.openSurvey(db, a);
    assert.equal(s.submitResponse(db, a, { [`q${qa}`]: 'EINZIGE-ANTWORT-A' }).ok, true);
    // Umfrage B: automatisch geschlossen, 2 von 3 Teilnahmen
    const b = s.createSurvey(db, { title: 'B' });
    const qb = s.addQuestion(db, b, { type: 'text', title: 'Text' });
    s.openSurvey(db, b);
    for (const v of ['ANTWORT-B1', 'ANTWORT-B2']) assert.equal(s.submitResponse(db, b, { [`q${qb}`]: v }).ok, true);
    // Umfrage C: 3 von 3, bleibt erhalten
    const c = s.createSurvey(db, { title: 'C' });
    const qc = s.addQuestion(db, c, { type: 'text', title: 'Text' });
    s.openSurvey(db, c);
    for (const v of ['BLEIBT-1', 'BLEIBT-2', 'BLEIBT-3']) assert.equal(s.submitResponse(db, c, { [`q${qc}`]: v }).ok, true);

    s.closeSurvey(db, a);
    db.prepare('UPDATE surveys SET closes_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, b);
    s.closeDueSurveys(db);
    s.closeSurvey(db, c);

    const count = (id) => db.prepare('SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.survey_id = ?').get(id).n;
    assert.equal(count(a), 0);
    assert.equal(count(b), 0);
    assert.equal(count(c), 3);
    // Der Zähler bleibt als Information erhalten
    assert.equal(s.getSurvey(db, a).response_count, 1);
    assert.equal(s.getSurvey(db, b).response_count, 2);
    assert.equal(s.getSurvey(db, b).status, 'closed');
    db.close();

    const raw = fs.readFileSync(file).toString('latin1');
    for (const v of ['EINZIGE-ANTWORT-A', 'ANTWORT-B1', 'ANTWORT-B2']) assert.equal(raw.includes(v), false, `${v} steht noch in der Datei`);
    assert.equal(raw.includes('BLEIBT-1'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Umfrage-Code: fest pro Slug, verschieden je Umfrage, verrät den Slug nicht', () => {
  const slug = 'saCmzRKBtiYwU5ellOSOqw';
  const code = s.surveyCode(slug);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(s.surveyCode(slug), code);
  assert.notEqual(s.surveyCode('saCmzRKBtiYwU5ellOSOqx'), code);
  assert.equal(slug.toUpperCase().includes(code.replace('-', '').slice(0, 4)), false);
  const codes = new Set();
  for (let i = 0; i < 2000; i += 1) codes.add(s.surveyCode(`slug-${i}`));
  assert.equal(codes.size, 2000);
});

test('HTTP: Teilnehmen schreibt nichts ins Log, alle öffentlichen Antworten no-store, Zahl verborgen, Code sichtbar', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-anon-'));
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD,
  });
  let app;
  await captureOutput(async () => { app = await createApp({ config }); });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = app.url;

  // Umfrage direkt über die Fachlogik anlegen
  const id = s.createSurvey(app.db, { title: 'Log-Test' });
  const qText = s.addQuestion(app.db, id, { type: 'text', title: 'Kurz', required: '1' });
  const qMulti = s.addQuestion(app.db, id, { type: 'multi', title: 'Mehr', options: 'A\nB\nC' });
  s.updateSurveyMeta(app.db, id, { title: 'Log-Test', min_responses: '3', closes_at: '' });
  s.openSurvey(app.db, id);
  const { slug } = s.getSurvey(app.db, id);
  const opt = s.getQuestion(app.db, id, qMulti).config.options.map((o) => o.id);

  const statuses = {};
  const written = await captureOutput(async () => {
    const pub = await fetch(`${base}/u/${slug}`);
    statuses.form = [pub.status, pub.headers.get('cache-control')];
    const html = await pub.text();
    assert.ok(html.includes(s.surveyCode(slug)), 'Umfrage-Code fehlt auf der Teilnahmeseite');
    assert.match(html, /<form method="post"[^>]* autocomplete="off"/);

    const post = (data) => fetch(`${base}/u/${slug}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'GEHEIM-UA', 'x-forwarded-for': '203.0.113.7' },
      body: form(data),
    });
    const bad = await post({ [`q${qMulti}`]: [opt[0]] });
    statuses.invalid = [bad.status, bad.headers.get('cache-control')];
    for (const text of ['TEXT-EINS', 'TEXT-ZWEI', 'TEXT-DREI']) {
      const ok = await post({ [`q${qText}`]: text, [`q${qMulti}`]: [opt[1]] });
      assert.equal(ok.status, 303);
      statuses.redirect = [ok.status, ok.headers.get('cache-control')];
    }
    const thanks = await fetch(`${base}/u/${slug}/danke`);
    statuses.thanks = [thanks.status, thanks.headers.get('cache-control')];
    const missing = await fetch(`${base}/u/AAAAAAAAAAAAAAAAAAAAAA`);
    statuses.notFound = [missing.status, missing.headers.get('cache-control')];
    const weird = await fetch(`${base}/u/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":"GEHEIM"}' });
    statuses.unsupported = [weird.status, weird.headers.get('cache-control')];
  });
  assert.deepEqual(written, [], `Ausgabe beim Teilnehmen: ${written.join('')}`);
  assert.deepEqual(statuses, {
    form: [200, 'no-store'],
    invalid: [422, 'no-store'],
    redirect: [303, 'no-store'],
    thanks: [200, 'no-store'],
    notFound: [404, 'no-store'],
    unsupported: [415, 'no-store'],
  });

  // Adminbereich: solange offen, keine Teilnahmezahl, aber der Code
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: form({ username: 'admin', password: PASSWORD }),
  });
  const sid = login.headers.get('set-cookie').split(';')[0];
  const overview = await (await fetch(`${base}/admin/surveys/${id}`, { headers: { cookie: sid } })).text();
  assert.match(overview, /data-count-hidden/);
  assert.doesNotMatch(overview, /<span class="stat-value">3<\/span><span class="stat-label">Teilnahmen/);
  assert.ok(overview.includes(s.surveyCode(slug)));

  // Nach dem Schließen steht die Zahl da, und die geschlossene Seite zeigt weiter den Code
  s.closeSurvey(app.db, id);
  const closedView = await (await fetch(`${base}/admin/surveys/${id}`, { headers: { cookie: sid } })).text();
  assert.match(closedView, /<span class="stat-value">3<\/span><span class="stat-label">Teilnahmen/);
  const closedPub = await (await fetch(`${base}/u/${slug}`)).text();
  assert.ok(closedPub.includes(s.surveyCode(slug)));
});
