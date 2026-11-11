'use strict';

// Registriert alle Routen und baut das gemeinsame ctx-Objekt.
//
// Jeder Handler wird als handler(req, res, ctx) aufgerufen. Auf req stehen bereit:
//   req.path    Pfad ohne Query (z. B. '/u/abc')
//   req.query   Query-Parameter (Objekt ohne Prototyp, wiederholte Schlüssel → Array)
//   req.params  Pfadparameter aus dem Muster (z. B. { slug: 'abc' })
//   req.body    nach readForm() bzw. in requireAdmin-POST-Handlern: Formularfelder
//   req.admin / req.session   nur in requireAdmin-Handlern: { id, username, display_name } / { csrf, … }
//
// ctx = {
//   db,            DatabaseSync (node:sqlite), Schema siehe src/db.js
//   dbx,           { transaction(fn), vacuum(), nowIso(), nowSec() } – an ctx.db gebundene Helfer
//   config,        Konfiguration (src/config.js), eingefroren
//   version,       z. B. '0.1.0'
//   integrity,     Modul src/integrity.js (getIntegrityStatus())
//   auth,          Modul src/auth.js
//   requireAdmin,  Wrapper für Adminrouten (src/routes/admin-auth.js)
//   csrfField,     csrfField(req) → verstecktes _csrf-Feld (SafeHtml)
//   render,        render(res, { status?, ...layoutOptionen }) → sendet komplette HTML-Seite
//   page,          page({ title, body, req, … }) → HTML-String (src/views/layout.js layout)
//   message,       message(res, status, { title, message, kind, actions, req }) → Meldungsseite senden
//   baseUrl,       baseUrl(req) → 'https://umfrage.example' (für angezeigte, kopierbare Links)
//   readForm,      readForm(req, { limit }) → Formularfelder (urlencoded)
//   HttpError,     throw new ctx.HttpError(404) bzw. (403, 'Meldung')
//   send, sendHtml, sendJson, redirect   Antworthelfer (src/http/respond.js)
// }

const auth = require('../auth');
const db = require('../db');
const integrity = require('../integrity');
const { version } = require('../version');
const { layout } = require('../views/layout');
const { messagePage } = require('../views/errors');
const { homePage } = require('../views/home');
const { readForm } = require('../http/body');
const respond = require('../http/respond');
const adminAuth = require('./admin-auth');

function createContext({ database, config }) {
  return {
    db: database,
    dbx: {
      transaction: (fn) => db.transaction(database, fn),
      vacuum: () => db.vacuum(database),
      nowIso: db.nowIso,
      nowSec: db.nowSec,
    },
    config,
    version,
    integrity,
    auth,
    requireAdmin: adminAuth.requireAdmin,
    csrfField: adminAuth.csrfField,
    render(res, { status = 200, ...opts }) {
      respond.sendHtml(res, status, layout(opts));
    },
    page: layout,
    message(res, status, opts) {
      respond.sendHtml(res, status, messagePage(opts));
    },
    baseUrl: (req) => respond.baseUrl(req, config),
    readForm,
    HttpError: respond.HttpError,
    send: respond.send,
    sendHtml: respond.sendHtml,
    sendJson: respond.sendJson,
    redirect: respond.redirect,
  };
}

function registerRoutes(router, ctx) {
  // Kernrouten (Grundgerüst)
  router.get('/', (req, res) => respond.sendHtml(res, 200, homePage()));
  router.get('/healthz', (req, res) => respond.sendText(res, 200, 'ok'));
  adminAuth.register(router, ctx);

  // Fachmodule
  require('./public').register(router, ctx);
  require('./transparency').register(router, ctx);
  require('./admin').register(router, ctx);
  require('./results').register(router, ctx);
}

module.exports = { createContext, registerRoutes };
