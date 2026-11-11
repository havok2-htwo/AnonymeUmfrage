'use strict';

// Anmeldung, Abmeldung, Sitzungsprüfung und CSRF-Schutz für den Adminbereich (SPEC §7, §10).
//
// Exporte zur Wiederverwendung in anderen Routenmodulen:
//   requireAdmin(handler, { bodyLimit })  Wrapper: verlangt Sitzung; bei POST zusätzlich Origin + _csrf.
//                                         Setzt req.session, req.admin und (bei POST) req.body.
//   csrfField(req)                         <input type="hidden" name="_csrf" …> für Formulare
//   checkOrigin(req, config)               true, wenn Origin/Sec-Fetch-Site unbedenklich sind

const auth = require('../auth');
const { html } = require('../views/html');
const { loginPage } = require('../views/admin-login');
const { readForm, asString } = require('../http/body');
const { parseCookies, setCookie, clearCookie } = require('../http/cookies');
const { HttpError, sendHtml, redirect } = require('../http/respond');

const COOKIE_PATH = '/admin';
const FORCED_CHANGE_ALLOWED = new Set(['/admin/passwort', '/admin/logout']);

/** Nur interne Admin-Ziele zulassen (kein offener Redirect). */
function safeNext(value) {
  const v = asString(value);
  if (!v.startsWith('/admin') || v.startsWith('//') || v.includes('\\') || /[\r\n]/.test(v)) return '';
  if (v.startsWith('/admin/login') || v.startsWith('/admin/logout')) return '';
  return v.slice(0, 500);
}

/** Prüft Origin (falls vorhanden) und Sec-Fetch-Site gegen die eigene Adresse. */
function checkOrigin(req, config) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  // „null“ schicken Browser z. B. bei strenger Referrer-Policy. Dann zählt nur, ob der Browser selbst
  // die Anfrage als same-origin ausweist (Sec-Fetch-Site lässt sich von Webseiten nicht fälschen).
  if (origin === 'null') return site === 'same-origin';
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (config.publicUrl) {
    try {
      if (new URL(config.publicUrl).host.toLowerCase() === host) return true;
    } catch { /* ungültige PUBLIC_URL: weiter mit Host-Header */ }
  }
  return host === String(req.headers.host || '').toLowerCase();
}

function loadSession(req, ctx) {
  if (req.session !== undefined) return req.session;
  const token = parseCookies(req)[auth.SESSION_COOKIE];
  const session = token ? auth.getSession(ctx.db, token) : null;
  req.session = session;
  req.admin = session ? session.admin : null;
  req.sessionToken = session ? token : null;
  return session;
}

function csrfField(req) {
  const token = req && req.session ? req.session.csrf : '';
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

/**
 * Schützt einen Handler: Sitzung nötig; bei POST Origin- und CSRF-Prüfung und Formular in req.body.
 * @param {(req, res, ctx) => any} handler
 * @param {{bodyLimit?: number}} [opts]
 */
function requireAdmin(handler, opts = {}) {
  return async function adminGuard(req, res, ctx) {
    res.setHeader('Cache-Control', 'no-store');
    const session = loadSession(req, ctx);
    if (!session) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const next = safeNext(req.url);
        redirect(res, next && next !== '/admin' ? `/admin/login?next=${encodeURIComponent(next)}` : '/admin/login');
        return;
      }
      redirect(res, '/admin/login');
      return;
    }
    // Standardzugang: bis ein eigenes Passwort gesetzt ist, nur Passwortwechsel und Abmelden.
    if (session.admin.must_change_password && !FORCED_CHANGE_ALLOWED.has(req.path)) {
      redirect(res, '/admin/passwort');
      return;
    }
    if (req.method === 'POST') {
      if (!checkOrigin(req, ctx.config)) {
        throw new HttpError(403, 'Die Anfrage kam nicht von dieser Seite. Bitte die Seite neu laden.');
      }
      const body = await readForm(req, { limit: opts.bodyLimit });
      if (!auth.safeEqual(asString(body._csrf), session.csrf)) {
        throw new HttpError(403, 'Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden und erneut versuchen.');
      }
    }
    return handler(req, res, ctx);
  };
}

function register(router, ctx) {
  router.get('/admin/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (loadSession(req, ctx)) {
      redirect(res, '/admin');
      return;
    }
    const notice = req.query.abgemeldet !== undefined ? 'Erfolgreich abgemeldet.' : '';
    sendHtml(res, 200, loginPage({ next: safeNext(req.query.next), notice }));
  });

  router.post('/admin/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!checkOrigin(req, ctx.config)) {
      throw new HttpError(403, 'Die Anfrage kam nicht von dieser Seite. Bitte die Seite neu laden.');
    }
    const body = await readForm(req, { limit: 16 * 1024 });
    const username = asString(body.username).trim().slice(0, 64);
    const password = asString(body.password);
    const next = safeNext(body.next);
    const result = await auth.verifyLogin(ctx.db, username, password);
    if (!result.ok) {
      sendHtml(res, result.locked ? 429 : 401, loginPage({ error: result.error, username, next }));
      return;
    }
    const session = auth.createSession(ctx.db, result.admin.id, ctx.config.sessionHours);
    setCookie(res, auth.SESSION_COOKIE, session.token, {
      path: COOKIE_PATH,
      httpOnly: true,
      sameSite: 'Strict',
      secure: ctx.config.cookieSecure,
      maxAge: ctx.config.sessionHours * 3600,
    });
    redirect(res, result.admin.must_change_password ? '/admin/passwort' : (next || '/admin'));
  });

  router.post('/admin/logout', requireAdmin(async (req, res) => {
    auth.destroySession(ctx.db, req.sessionToken);
    clearCookie(res, auth.SESSION_COOKIE, { path: COOKIE_PATH, secure: ctx.config.cookieSecure });
    redirect(res, '/admin/login?abgemeldet');
  }));
}

module.exports = { register, requireAdmin, csrfField, checkOrigin, loadSession, safeNext };
