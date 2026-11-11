'use strict';

// Tests für das Grundgerüst: Escaping, Router, Body-Parser, Schema, Auth, HTTP-Header, Login.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { html, raw, widthClass } = require('../src/views/html');
const { createRouter } = require('../src/http/router');
const { parseUrlEncoded } = require('../src/http/body');
const { openDatabase, transaction } = require('../src/db');
const auth = require('../src/auth');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

test('html escaped Nutzerdaten, raw nicht', () => {
  const evil = '<script>alert("x")</script>';
  assert.equal(String(html`<p>${evil}</p>`), '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  assert.equal(String(html`<p>${raw('<b>ok</b>')}</p>`), '<p><b>ok</b></p>');
  assert.equal(String(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0');
  assert.equal(widthClass(37.4), 'w-37');
  assert.equal(widthClass(140), 'w-100');
});

test('Router: Parameter, 404 und 405', async () => {
  const router = createRouter();
  let seen = null;
  router.get('/u/:slug', (req) => { seen = req.params.slug; });
  router.post('/a/:id/b', () => {});
  const req = { method: 'GET', path: '/u/abc%20d' };
  assert.deepEqual(await router.handle(req, {}, {}), { matched: true });
  assert.equal(seen, 'abc d');
  assert.deepEqual((await router.handle({ method: 'POST', path: '/u/x' }, {}, {})).allowed.sort(), ['GET', 'HEAD']);
  assert.deepEqual(await router.handle({ method: 'GET', path: '/nix' }, {}, {}), { matched: false, allowed: [] });
  assert.equal((await router.handle({ method: 'HEAD', path: '/u/x' }, {}, {})).matched, true);
});

test('Body-Parser: wiederholte Schlüssel werden zum Array', () => {
  const body = parseUrlEncoded('q1=a&q2=x&q2=y&text=%C3%A4%C3%B6%C3%BC+%C3%9F');
  assert.equal(body.q1, 'a');
  assert.deepEqual(body.q2, ['x', 'y']);
  assert.equal(body.text, 'äöü ß');
});

test('Schema: answers ist WITHOUT ROWID ohne verbindende Spalte', () => {
  const db = openDatabase(':memory:');
  const cols = db.prepare('PRAGMA table_info(answers)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['id', 'question_id', 'value']);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'answers'").get().sql;
  assert.match(sql, /WITHOUT ROWID/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(require('../src/db').SCHEMA_VERSION));
  assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
  assert.throws(() => transaction(db, (d) => {
    d.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run();
    throw new Error('abbrechen');
  }), /abbrechen/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'x'").get().n, 0);
  db.close();
});

test('Auth: Hash, Login, Bremse, Sitzung', async () => {
  const db = openDatabase(':memory:');
  await assert.rejects(auth.createAdmin(db, { username: 'admin', password: 'kurz' }), /mindestens 10/);
  const id = await auth.createAdmin(db, { username: 'admin', displayName: 'Jörg Müller', password: 'geheim-genug-123' });
  await assert.rejects(auth.createAdmin(db, { username: 'ADMIN', password: 'geheim-genug-123' }), /vergeben/);

  const throttle = auth.createThrottle();
  const ok = await auth.verifyLogin(db, 'Admin', 'geheim-genug-123', throttle);
  assert.equal(ok.ok, true);
  assert.equal(ok.admin.id, id);
  const unknown = await auth.verifyLogin(db, 'niemand', 'geheim-genug-123', throttle);
  const wrong = await auth.verifyLogin(db, 'admin', 'falsch-falsch', throttle);
  assert.equal(unknown.error, wrong.error);
  for (let i = 0; i < 4; i += 1) await auth.verifyLogin(db, 'admin', 'falsch-falsch', throttle);
  const locked = await auth.verifyLogin(db, 'admin', 'geheim-genug-123', throttle);
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);

  const s = auth.createSession(db, id, 1);
  const found = auth.getSession(db, s.token);
  assert.equal(found.admin.id, id);
  assert.equal(found.csrf, s.csrf);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(s.token).n, 0);
  auth.destroySession(db, s.token);
  assert.equal(auth.getSession(db, s.token), null);
  db.close();
});

test('HTTP: Startseite, Header, keine Cookies, Login mit CSRF', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-test-'));
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'geheim-genug-123',
  });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const home = await fetch(`${app.url}/`);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('set-cookie'), null);
  assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-powered-by'), null);
  const text = await home.text();
  assert.match(text, /Version \d+\.\d+\.\d+/);
  assert.doesNotMatch(text, /style="/);

  assert.equal((await fetch(`${app.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${app.url}/gibtsnicht`)).status, 404);
  assert.equal((await fetch(`${app.url}/admin/login`, { method: 'PUT' })).status, 405);
  const css = await fetch(`${app.url}/css/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const font = await fetch(`${app.url}/fonts/Montserrat-Regular.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(`${app.url}/../package.json`)).status, 404);

  const adminRedirect = await fetch(`${app.url}/admin`, { redirect: 'manual' });
  assert.equal(adminRedirect.status, 303);
  assert.equal(adminRedirect.headers.get('location'), '/admin/login');

  const bad = await fetch(`${app.url}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=falsch-falsch',
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  const login = await fetch(`${app.url}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: app.url },
    body: 'username=admin&password=geheim-genug-123',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/admin/);
  const sid = cookie.split(';')[0];

  const page = await fetch(`${app.url}/admin`, { headers: { cookie: sid } });
  assert.equal(page.status, 200);
  const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];

  const noCsrf = await fetch(`${app.url}/admin/logout`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(noCsrf.status, 403);
  const foreign = await fetch(`${app.url}/admin/logout`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    body: `_csrf=${encodeURIComponent(csrf)}`,
  });
  assert.equal(foreign.status, 403);
  const logout = await fetch(`${app.url}/admin/logout`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
    body: `_csrf=${encodeURIComponent(csrf)}`,
  });
  assert.equal(logout.status, 303);
  const after = await fetch(`${app.url}/admin`, { headers: { cookie: sid }, redirect: 'manual' });
  assert.equal(after.status, 303);
});

test('Login-Bremse: parallele Fehlversuche umgehen die Grenze nicht', async () => {
  const db = openDatabase(':memory:');
  await auth.createAdmin(db, { username: 'admin', password: 'geheim-genug-123' });
  const throttle = auth.createThrottle();
  const burst = () => Promise.all(Array.from({ length: 20 }, () => auth.verifyLogin(db, 'admin', 'falsch-falsch', throttle)));
  // Mehrere Wellen paralleler Versuche: insgesamt werden höchstens 5 Passwörter wirklich geprüft.
  const results = [...await burst(), ...await burst(), ...await burst()];
  const tested = results.filter((r) => !r.locked);
  assert.ok(tested.length <= 5, `höchstens 5 Passwörter geprüft, tatsächlich ${tested.length}`);
  assert.equal(tested.length, 5);
  // Danach ist der Name gesperrt, auch mit richtigem Passwort.
  assert.equal((await auth.verifyLogin(db, 'admin', 'geheim-genug-123', throttle)).locked, true);
  // Eine eigene Bremse (z. B. nach Neustart) ist davon nicht betroffen.
  const other = auth.createThrottle();
  assert.equal((await auth.verifyLogin(db, 'admin', 'geheim-genug-123', other)).ok, true);
  db.close();
});

test('HTTP: 20 parallele falsche Logins ergeben höchstens 5 Antworten ohne 429', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-test-'));
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off' });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const statuses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${app.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: app.url },
    body: 'username=parallel&password=falsch-falsch',
  }).then(async (r) => {
    await r.text();
    return r.status;
  })));
  const tried = statuses.filter((s) => s !== 429);
  assert.ok(tried.length <= 5, `Status: ${statuses.join(',')}`);
  assert.ok(tried.every((s) => s === 401));
});
