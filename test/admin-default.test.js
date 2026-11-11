'use strict';

// Auslieferungszustand: ohne ADMIN_USER/ADMIN_PASSWORD gibt es admin/admin, und bis zum Passwortwechsel
// ist im Adminbereich nur die Passwortseite erreichbar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');
const auth = require('../src/auth');
const { openDatabase } = require('../src/db');

async function startApp(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-default-'));
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, INTEGRITY_CHECK: 'off', ...extra });
  const app = await createApp({ config });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

function cookieOf(res) {
  const c = res.headers.get('set-cookie');
  return c ? c.split(';')[0] : '';
}

test('Standardzugang admin/admin muss beim ersten Login geändert werden', async (t) => {
  const app = await startApp(t);
  const base = app.url;
  const admins = auth.listAdmins(app.db);
  assert.equal(admins.length, 1);
  assert.equal(admins[0].username, 'admin');
  assert.equal(admins[0].display_name, 'Admin');
  assert.equal(admins[0].must_change_password, 1);

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/admin/passwort');
  let sid = cookieOf(login);
  assert.ok(sid);

  // Alles andere im Adminbereich leitet auf die Passwortseite um.
  for (const p of ['/admin', '/admin/admins', '/admin/surveys/1']) {
    const r = await fetch(`${base}${p}`, { headers: { cookie: sid }, redirect: 'manual' });
    assert.equal(r.status, 303, p);
    assert.equal(r.headers.get('location'), '/admin/passwort', p);
  }
  const page = await fetch(`${base}/admin/passwort`, { headers: { cookie: sid } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Bitte zuerst ein eigenes Passwort festlegen/);
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];

  // POST an andere Admin-Routen ist gesperrt.
  const blocked = await fetch(`${base}/admin/surveys`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, title: 'Test' }),
  });
  assert.equal(blocked.status, 303);
  assert.equal(blocked.headers.get('location'), '/admin/passwort');

  const post = (fields) => fetch(`${base}/admin/passwort`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });
  // „admin“ als neues Passwort und zu kurze Passwörter werden abgelehnt.
  assert.equal((await post({ current: 'admin', password: 'admin', password2: 'admin' })).status, 422);
  assert.equal((await post({ current: 'admin', password: 'kurz', password2: 'kurz' })).status, 422);
  assert.equal((await post({ current: 'falsch', password: 'ein-gutes-passwort', password2: 'ein-gutes-passwort' })).status, 422);

  const ok = await post({ current: 'admin', password: 'ein-gutes-passwort', password2: 'ein-gutes-passwort' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/admin?hinweis=passwort');
  sid = cookieOf(ok);
  assert.equal(auth.getAdminByUsername(app.db, 'admin').must_change_password, 0);

  const dash = await fetch(`${base}/admin`, { headers: { cookie: sid }, redirect: 'manual' });
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /href="\/admin\/passwort"/);

  // admin/admin funktioniert nicht mehr.
  const old = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin' }),
  });
  assert.equal(old.status, 401);
});

test('Mit ADMIN_USER/ADMIN_PASSWORD gibt es keinen Standardzugang', async (t) => {
  const app = await startApp(t, { ADMIN_USER: 'chefin', ADMIN_PASSWORD: 'geheim-genug-123' });
  const admins = auth.listAdmins(app.db);
  assert.deepEqual(admins.map((a) => [a.username, a.must_change_password]), [['chefin', 0]]);
});

test('Standardzugang wird nicht angelegt, wenn schon ein Admin existiert; Umbenennen behält das Passwort', async () => {
  const db = openDatabase(':memory:');
  const id = await auth.createAdmin(db, { username: 'mathias', displayName: 'Mathias', password: 'geheim-genug-123' });
  assert.equal(await auth.createDefaultAdmin(db), false);
  auth.renameAdmin(db, id, { username: 'admin', displayName: 'Admin' });
  const a = auth.getAdminById(db, id);
  assert.equal(a.username, 'admin');
  assert.equal(a.display_name, 'Admin');
  assert.equal((await auth.verifyLogin(db, 'admin', 'geheim-genug-123')).ok, true);
  assert.equal(auth.validatePassword('admin'), 'Das Passwort muss mindestens 10 Zeichen lang sein.');
  assert.equal(auth.validatePassword('  ADMIN  '.padEnd(12)), 'Das Standardpasswort ist nicht erlaubt.');
  db.close();
});

test('Migration: Schema 1 bekommt die Spalte must_change_password', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umfrage-mig-'));
  const file = path.join(dir, 'umfrage.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO admins (username, display_name, password_hash, created_at) VALUES ('x', 'X', 'h', '2026-01-01');`);
  old.close();
  const db = openDatabase(file);
  assert.equal(db.prepare('SELECT must_change_password AS m FROM admins').get().m, 0);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Login: Origin „null“ gilt nur mit Sec-Fetch-Site same-origin (Browser mit strenger Referrer-Policy)', async (t) => {
  const app = await startApp(t);
  const login = (headers) => fetch(`${app.url}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ username: 'admin', password: 'admin' }),
  });
  assert.equal((await login({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await login({ origin: 'null' })).status, 403);
  assert.equal((await login({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await login({ origin: app.url })).status, 303);
});
