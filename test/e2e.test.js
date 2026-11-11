'use strict';

// HTTP-Ende-zu-Ende (SPEC §11): Server auf freiem Port mit leerem DATA_DIR, Admin anlegen, einloggen,
// Umfrage mit allen fünf Fragetypen bauen, öffnen, drei Teilnahmen, schließen, Auswertung und PDF abrufen.
// Dazu: keine Cookies auf öffentlichen Seiten, Sicherheitsheader, Schließen endgültig, Ergebnisse gesperrt,
// Datenbank ohne verbindende Spalte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');
const { version } = require('../package.json');

const PASSWORD = 'geheim-genug-123';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
  + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function form(data) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined) p.append(k, v);
  }
  return p.toString();
}

function assertSecurityHeaders(res, label) {
  const h = res.headers;
  assert.equal(h.get('content-security-policy'), CSP, `${label}: CSP`);
  assert.equal(h.get('referrer-policy'), 'same-origin', `${label}: Referrer-Policy`);
  assert.equal(h.get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
  assert.equal(h.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
  assert.equal(h.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), interest-cohort=()', `${label}: Permissions-Policy`);
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin', `${label}: COOP`);
  assert.equal(h.get('x-powered-by'), null, `${label}: X-Powered-By`);
  assert.equal(h.get('server'), null, `${label}: Server`);
}

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-e2e-'));
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD,
  });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

async function adminClient(base) {
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: form({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^sid=[^;]+;/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/admin/i);
  const sid = cookie.split(';')[0];
  const get = (p) => fetch(`${base}${p}`, { headers: { cookie: sid }, redirect: 'manual' });
  const page = await (await get('/admin')).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (p, data = {}) => fetch(`${base}${p}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: form({ _csrf: csrf, ...data }),
  });
  return { get, post, sid, csrf };
}

function publicPost(base, slug, data) {
  return fetch(`${base}/u/${slug}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(data),
  });
}

test('Ende-zu-Ende: bauen, öffnen, drei Teilnahmen, schließen, Auswertung und PDF', async (t) => {
  const app = await startApp(t);
  const base = app.url;

  // Kernseiten, Header, Fuß mit Version und Prüfstatus
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  for (const p of ['/', '/transparenz', '/admin/login']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, p);
    assertSecurityHeaders(res, p);
    assert.equal(res.headers.get('set-cookie'), null, `${p}: kein Cookie`);
    const body = await res.text();
    assert.match(body, new RegExp(`Version ${version.replace(/\./g, '\\.')}`), `${p}: Version im Fuß`);
    assert.match(body, /Code nicht geprüft: Prüfung abgeschaltet/, `${p}: Prüfstatus im Fuß`);
    assert.match(body, /href="\/transparenz"/, `${p}: Link zur Transparenzseite`);
  }
  const json = await (await fetch(`${base}/transparenz.json`)).json();
  assert.equal(json.version, version);
  assert.equal(json.state, 'unverified');

  const admin = await adminClient(base);

  // Umfrage mit allen fünf Fragetypen
  const created = await admin.post('/admin/surveys', { title: 'Teamumfrage <script>alert(1)</script>' });
  assert.equal(created.status, 303);
  const surveyPath = created.headers.get('location').split('?')[0];
  assert.match(surveyPath, /^\/admin\/surveys\/\d+$/);
  const meta = await admin.post(surveyPath, {
    title: 'Teamumfrage <script>alert(1)</script>', intro: 'Bitte ehrlich antworten.', thanks: 'Vielen Dank!',
    min_responses: '3', closes_at: '',
  });
  assert.equal(meta.status, 303);

  const questionForms = [
    { type: 'text', title: 'Ein Wort für unser Team?', required: '1', maxLength: '100' },
    { type: 'longtext', title: 'Was würdest du ändern? <b>fett</b>' },
    { type: 'scale', title: 'Wie zufrieden bist du?', required: '1', scaleMin: '1', scaleMax: '10', minLabel: 'gar nicht', maxLabel: 'sehr' },
    { type: 'single', title: 'Wie oft im Büro?', options: 'Täglich\nWöchentlich\nSelten' },
    { type: 'multi', title: 'Was nutzt du?', options: 'Kaffee\nTee\nWasser', maxChoices: '2' },
  ];
  for (const q of questionForms) {
    const res = await admin.post(`${surveyPath}/questions`, q);
    assert.equal(res.status, 303, q.type);
  }

  // Vor dem Öffnen: Teilnahmeseite liefert 404 (Entwurf), Ergebnisse gesperrt
  const editor = await (await admin.get(surveyPath)).text();
  assert.match(editor, /Teamumfrage &lt;script&gt;/);
  assert.doesNotMatch(editor, /<script>alert/);
  const draftSlug = editor.match(/\/u\/([A-Za-z0-9_-]{22})/);
  if (draftSlug) assert.equal((await fetch(`${base}/u/${draftSlug[1]}`)).status, 404);
  assert.equal((await admin.get(`${surveyPath}/results.pdf`)).status, 409);

  assert.equal((await admin.post(`${surveyPath}/open`)).status, 303);
  const overview = await (await admin.get(surveyPath)).text();
  const slug = overview.match(/\/u\/([A-Za-z0-9_-]{22})/)[1];
  assert.match(overview, /Ergebnisse gesperrt/);

  // Nach dem Öffnen eingefroren
  assert.equal((await admin.post(`${surveyPath}/questions`, { type: 'text', title: 'Nachzügler' })).status, 409);

  // Öffentliche Seite
  const pub = await fetch(`${base}/u/${slug}`, { headers: { cookie: admin.sid } });
  assert.equal(pub.status, 200);
  assertSecurityHeaders(pub, 'Teilnahme');
  assert.equal(pub.headers.get('set-cookie'), null);
  assert.equal(pub.headers.get('cache-control'), 'no-store');
  const pubHtml = await pub.text();
  assert.match(pubHtml, /Was würdest du ändern\? &lt;b&gt;fett&lt;\/b&gt;/);
  assert.doesNotMatch(pubHtml, /Abmelden/);
  assert.doesNotMatch(pubHtml, /name="_csrf"/);
  const qids = [...new Set([...pubHtml.matchAll(/name="(q\d+)"/g)].map((m) => m[1]))];
  assert.equal(qids.length, 5);
  const [qText, qLong, qScale, qSingle, qMulti] = qids;
  const optionIds = (q) => [...pubHtml.matchAll(new RegExp(`name="${q}" value="([0-9a-f]{6})"`, 'g'))].map((m) => m[1]);
  const single = optionIds(qSingle);
  const multi = optionIds(qMulti);
  assert.equal(single.length, 3);
  assert.equal(multi.length, 3);
  // Fragen nummeriert in fester Reihenfolge
  const order = ['Ein Wort', 'Was würdest du', 'Wie zufrieden', 'Wie oft', 'Was nutzt'].map((s) => pubHtml.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  // Atomarität: fehlende Pflichtfrage und zu viele Auswahlen → 422, nichts gespeichert
  const answersBefore = app.db.prepare('SELECT COUNT(*) AS n FROM answers').get().n;
  const bad = await publicPost(base, slug, { [qLong]: 'Bleibt im Formular', [qMulti]: multi });
  assert.equal(bad.status, 422);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.match(await bad.text(), /Bleibt im Formular/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM answers').get().n, answersBefore);
  assert.equal(app.db.prepare('SELECT response_count AS n FROM surveys WHERE slug = ?').get(slug).n, 0);

  // Drei Teilnahmen
  const submissions = [
    { [qText]: 'Hilfsbereit', [qLong]: 'Mehr Grün im Büro.\nUnd Obst.', [qScale]: '8', [qSingle]: single[0], [qMulti]: [multi[0], multi[1]] },
    { [qText]: 'Schnell', [qScale]: '6', [qSingle]: single[1], [qMulti]: [multi[2]] },
    { [qText]: 'Größer', [qLong]: 'Weniger Meetings', [qScale]: '10', [qSingle]: single[1] },
  ];
  for (const data of submissions) {
    const res = await publicPost(base, slug, data);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/u/${slug}/danke`);
    assert.equal(res.headers.get('set-cookie'), null);
    assertSecurityHeaders(res, 'Absenden');
  }
  const thanks = await fetch(`${base}/u/${slug}/danke`);
  assert.equal(thanks.status, 200);
  assert.equal(thanks.headers.get('set-cookie'), null);
  assert.match(await thanks.text(), /Vielen Dank!/);

  // Datenbank: nur getrennte Antworten mit Zufalls-ID, kein Zeitstempel, keine verbindende Spalte
  const cols = app.db.prepare('PRAGMA table_info(answers)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['id', 'question_id', 'value']);
  const rows = app.db.prepare('SELECT id, value FROM answers').all();
  // 3 + 2 + 3 + 3 + (2 + 1 Optionen + 2 Marker) = 16
  assert.equal(rows.length, 16);
  for (const r of rows) assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE value = ''").get().n, 2);
  assert.equal(app.db.prepare('SELECT response_count AS n FROM surveys WHERE slug = ?').get(slug).n, 3);
  assert.equal(app.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');

  // Solange offen: weder Inhalte noch die Zahl der Teilnahmen
  const openView = await (await admin.get(surveyPath)).text();
  assert.match(openView, /data-count-hidden/);
  assert.doesNotMatch(openView, /Hilfsbereit/);
  const lockedHtml = await admin.get(`${surveyPath}/results`);
  assert.equal(lockedHtml.status, 200);
  const lockedText = await lockedHtml.text();
  assert.match(lockedText, /Auswertung noch nicht verfügbar/);
  assert.doesNotMatch(lockedText, /Hilfsbereit/);
  assert.equal((await admin.get(`${surveyPath}/results.pdf`)).status, 409);

  // Schließen: nur mit Bestätigung, danach endgültig
  assert.equal((await admin.post(`${surveyPath}/close`)).status, 422);
  assert.equal((await admin.post(`${surveyPath}/close`, { confirm: 'ja' })).status, 303);
  assert.equal((await admin.post(`${surveyPath}/open`)).status, 409);
  assert.equal(app.db.prepare('SELECT status FROM surveys WHERE slug = ?').get(slug).status, 'closed');
  const closedPage = await fetch(`${base}/u/${slug}`);
  assert.match(await closedPage.text(), /Diese Umfrage ist abgeschlossen/);
  assert.equal((await publicPost(base, slug, submissions[0])).status, 409);
  assert.equal(app.db.prepare('SELECT response_count AS n FROM surveys WHERE slug = ?').get(slug).n, 3);

  // Auswertung
  const results = await admin.get(`${surveyPath}/results`);
  assert.equal(results.status, 200);
  assertSecurityHeaders(results, 'Auswertung');
  const r = await results.text();
  assert.match(r, /Teamumfrage &lt;script&gt;/);
  assert.doesNotMatch(r, /<script>alert/);
  assert.match(r, /3 von 3 haben geantwortet/);
  assert.match(r, /2 von 3 haben geantwortet/);
  for (const word of ['Hilfsbereit', 'Schnell', 'Größer', 'Täglich']) assert.ok(r.includes(word), word);
  // Langtext und Mehrfachauswahl haben nur 2 von 3 beantwortet (< Mindestzahl 3): Inhalte ausgeblendet
  assert.equal((r.match(/Zu wenige Antworten \(2\), zum Schutz der Anonymität ausgeblendet/g) || []).length, 2);
  for (const word of ['Weniger Meetings', 'Mehr Grün', 'Kaffee']) assert.ok(!r.includes(word), word);
  // Skala mit beiden Endbeschriftungen
  assert.match(r, /1 = gar nicht · 10 = sehr/);
  assert.match(r, /Durchschnitt<\/dt><dd>8,0<\/dd>/);
  assert.match(r, /Median<\/dt><dd>8<\/dd>/);
  assert.match(r, /href="[^"]*\/results\.pdf"/);

  // PDF
  const pdf = await admin.get(`${surveyPath}/results.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /attachment; filename="umfrage-teamumfrage-[a-z0-9-]*ergebnis\.pdf"/);
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');
  assert.ok(buf.length > 2000);

  // Ohne Sitzung kein Zugriff auf Auswertung
  const anon = await fetch(`${base}${surveyPath}/results.pdf`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location'), /^\/admin\/login/);

  // Fremder Origin wird abgelehnt
  const foreign = await fetch(`${base}${surveyPath}/duplicate`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: admin.sid, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    body: form({ _csrf: admin.csrf }),
  });
  assert.equal(foreign.status, 403);
});

test('Ende-zu-Ende: unter Mindestanzahl bleibt die Auswertung gesperrt, Schließzeit leeren', async (t) => {
  const app = await startApp(t);
  const base = app.url;
  const admin = await adminClient(base);

  const created = await admin.post('/admin/surveys', { title: 'Kleine Runde' });
  const surveyPath = created.headers.get('location').split('?')[0];
  // Schließzeit setzen und wieder leeren: leeres Feld schaltet automatisches Schließen ab
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(future).replace(' ', 'T');
  assert.equal((await admin.post(surveyPath, { title: 'Kleine Runde', min_responses: '5', closes_at: local })).status, 303);
  const id = Number(surveyPath.split('/').pop());
  assert.ok(app.db.prepare('SELECT closes_at FROM surveys WHERE id = ?').get(id).closes_at > 0);
  assert.equal((await admin.post(surveyPath, { title: 'Kleine Runde', min_responses: '5', closes_at: '' })).status, 303);
  assert.equal(app.db.prepare('SELECT closes_at FROM surveys WHERE id = ?').get(id).closes_at, null);

  // Öffnen ohne Fragen verboten
  assert.equal((await admin.post(`${surveyPath}/open`)).status, 409);
  assert.equal((await admin.post(`${surveyPath}/questions`, { type: 'scale', title: 'Wie geht’s?', required: '1' })).status, 303);
  assert.equal((await admin.post(`${surveyPath}/open`)).status, 303);

  const overview = await (await admin.get(surveyPath)).text();
  const slug = overview.match(/\/u\/([A-Za-z0-9_-]{22})/)[1];
  const pubHtml = await (await fetch(`${base}/u/${slug}`)).text();
  const q = pubHtml.match(/name="(q\d+)"/)[1];
  for (const v of ['3', '9']) assert.equal((await publicPost(base, slug, { [q]: v })).status, 303);
  // Außerhalb der Skala → 422
  assert.equal((await publicPost(base, slug, { [q]: '11' })).status, 422);

  // Schließzeit einer offenen Umfrage lässt sich leeren
  assert.equal((await admin.post(surveyPath, { closes_at: '' })).status, 303);
  assert.equal((await admin.post(`${surveyPath}/close`, { confirm: 'ja' })).status, 303);

  const locked = await admin.get(`${surveyPath}/results`);
  assert.equal(locked.status, 200);
  const text = await locked.text();
  assert.match(text, /Auswertung noch nicht verfügbar/);
  assert.match(text, /5/);
  assert.equal((await admin.get(`${surveyPath}/results.pdf`)).status, 409);
  assert.equal((await admin.get('/admin/surveys/999999/results')).status, 404);
});
