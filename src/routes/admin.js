'use strict';

// Adminbereich (SPEC §7 „Admin“): Umfrageliste, Editor, Statuswechsel, Vorschau, Adminverwaltung.
// Anmeldung/Abmeldung, requireAdmin und csrfField liegen in ./admin-auth.js und werden hier
// zur Bequemlichkeit weitergereicht. Auswertung und PDF: ./results.js.
//
// Alle POST-Routen laufen über requireAdmin (Sitzung, Origin, _csrf). Fachregeln (nur im Entwurf
// bearbeitbar, Schließen endgültig …) prüft src/surveys.js selbst, nicht nur die Oberfläche.

const { requireAdmin, csrfField, checkOrigin } = require('./admin-auth');
const surveys = require('../surveys');
const auth = require('../auth');
const { asString } = require('../http/body');
const { setCookie } = require('../http/cookies');
const { noticeFromQuery, dashboardBody } = require('../views/admin');
const { editorBody, overviewBody } = require('../views/admin-survey');
const { adminsBody } = require('../views/admin-admins');
const { surveyFormPage } = require('../views/survey');

function parseId(value, ctx) {
  const s = String(value || '');
  if (!/^\d{1,12}$/.test(s)) throw new ctx.HttpError(404);
  return Number(s);
}

function loadSurvey(ctx, req) {
  const survey = surveys.getSurvey(ctx.db, parseId(req.params.id, ctx));
  if (!survey) throw new ctx.HttpError(404);
  return survey;
}

function surveyLink(ctx, req, survey) {
  return `${ctx.baseUrl(req).replace(/\/+$/, '')}/u/${survey.slug}`;
}

/** Editor (Entwurf) bzw. Übersicht (offen/geschlossen) senden. */
function renderSurvey(ctx, req, res, survey, { status = 200, state = {}, notice = '' } = {}) {
  const fresh = surveys.getSurvey(ctx.db, survey.id) || survey;
  const questions = surveys.getQuestions(ctx.db, fresh.id);
  const common = { req, csrfField, survey: fresh, questions, notice, state: { ...state, vacuumPending: surveys.isVacuumPending(ctx.db) } };
  const body = fresh.status === 'draft'
    ? editorBody(common)
    : overviewBody({ ...common, link: surveyLink(ctx, req, fresh), results: surveys.resultsAvailable(fresh) });
  ctx.render(res, { status, title: fresh.title, body, req, active: 'surveys', scripts: ['/js/admin.js'] });
}

/**
 * Führt eine Fachaktion aus. SurveyError → Seite mit Fehlermeldung (409) bzw. 404,
 * ValidationError → onInvalid(err). Andere Fehler gehen an die zentrale Fehlerbehandlung.
 */
function runAction(ctx, req, res, survey, fn, onInvalid) {
  try {
    fn();
    return true;
  } catch (err) {
    if (err instanceof surveys.ValidationError && onInvalid) {
      onInvalid(err);
      return false;
    }
    if (err instanceof surveys.SurveyError) {
      if (err.status === 404) throw new ctx.HttpError(404);
      renderSurvey(ctx, req, res, survey, { status: err.status === 400 ? 400 : 409, state: { actionError: err.userMessage } });
      return false;
    }
    throw err;
  }
}

function renderAdmins(ctx, req, res, { status = 200, state = {}, notice = '' } = {}) {
  ctx.render(res, {
    status,
    title: 'Admins',
    req,
    active: 'admins',
    scripts: ['/js/admin.js'],
    body: adminsBody({ req, csrfField, admins: ctx.auth.listAdmins(ctx.db), notice, state }),
  });
}

function renderDashboard(ctx, req, res, { status = 200, createError = '', createValue = '' } = {}) {
  ctx.render(res, {
    status,
    title: 'Umfragen',
    req,
    active: 'surveys',
    scripts: ['/js/admin.js'],
    body: dashboardBody({
      req, csrfField, surveys: surveys.listSurveys(ctx.db), notice: noticeFromQuery(req), createError, createValue,
    }),
  });
}

/**
 * @param {ReturnType<import('../http/router').createRouter>} router
 * @param {object} ctx  siehe src/routes/index.js
 */
function register(router, ctx) {
  // Minuten-Takt für automatisches Schließen; zusätzlich prüft getSurvey() bei jedem Zugriff.
  surveys.startAutoClose(ctx.db);

  // --- Umfragen -------------------------------------------------------------------------------

  router.get('/admin', requireAdmin(async (req, res) => {
    renderDashboard(ctx, req, res);
  }));

  router.post('/admin/surveys', requireAdmin(async (req, res) => {
    let id;
    try {
      id = surveys.createSurvey(ctx.db, { title: req.body.title, adminId: req.admin.id });
    } catch (err) {
      if (err instanceof surveys.ValidationError) {
        renderDashboard(ctx, req, res, { status: 422, createError: err.errors.title, createValue: asString(req.body.title) });
        return;
      }
      throw err;
    }
    ctx.redirect(res, `/admin/surveys/${id}?hinweis=angelegt`);
  }));

  router.get('/admin/surveys/:id', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    renderSurvey(ctx, req, res, survey, { notice: noticeFromQuery(req) });
  }));

  // Stammdaten (Entwurf) bzw. nur Schließzeitpunkt (offen).
  router.post('/admin/surveys/:id', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    if (survey.status === 'open') {
      const ok = runAction(ctx, req, res, survey, () => surveys.updateClosesAt(ctx.db, survey.id, req.body), (err) => {
        renderSurvey(ctx, req, res, survey, { status: 422, state: { closesError: err.errors.closes_at, closesValue: err.values.closes_at } });
      });
      if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=gespeichert`);
      return;
    }
    const ok = runAction(ctx, req, res, survey, () => surveys.updateSurveyMeta(ctx.db, survey.id, req.body), (err) => {
      renderSurvey(ctx, req, res, survey, { status: 422, state: { meta: { errors: err.errors, values: err.values } } });
    });
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=gespeichert#stammdaten`);
  }));

  router.post('/admin/surveys/:id/questions', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    let qid;
    const ok = runAction(ctx, req, res, survey, () => { qid = surveys.addQuestion(ctx.db, survey.id, req.body); }, (err) => {
      renderSurvey(ctx, req, res, survey, { status: 422, state: { question: { key: 'neu', errors: err.errors, values: err.values } } });
    });
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=frage-neu#frage-${qid}`);
  }));

  router.post('/admin/surveys/:id/questions/:qid', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    const qid = parseId(req.params.qid, ctx);
    const ok = runAction(ctx, req, res, survey, () => surveys.updateQuestion(ctx.db, survey.id, qid, req.body), (err) => {
      renderSurvey(ctx, req, res, survey, { status: 422, state: { question: { key: qid, errors: err.errors, values: err.values } } });
    });
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=frage-gespeichert#frage-${qid}`);
  }));

  router.post('/admin/surveys/:id/questions/:qid/delete', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    const qid = parseId(req.params.qid, ctx);
    const ok = runAction(ctx, req, res, survey, () => surveys.deleteQuestion(ctx.db, survey.id, qid));
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=frage-geloescht#fragen`);
  }));

  router.post('/admin/surveys/:id/questions/:qid/move', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    const qid = parseId(req.params.qid, ctx);
    const direction = asString(req.body.direction);
    const ok = runAction(ctx, req, res, survey, () => surveys.moveQuestion(ctx.db, survey.id, qid, direction));
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=frage-verschoben#frage-${qid}`);
  }));

  router.post('/admin/surveys/:id/open', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    const ok = runAction(ctx, req, res, survey, () => surveys.openSurvey(ctx.db, survey.id));
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=geoeffnet`);
  }));

  router.post('/admin/surveys/:id/close', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    if (asString(req.body.confirm) !== 'ja') {
      renderSurvey(ctx, req, res, survey, { status: 422, state: { closeError: 'Bitte bestätigen, dass das Schließen endgültig ist.' } });
      return;
    }
    const ok = runAction(ctx, req, res, survey, () => surveys.closeSurvey(ctx.db, survey.id));
    if (ok) ctx.redirect(res, `/admin/surveys/${survey.id}?hinweis=geschlossen`);
  }));

  router.post('/admin/surveys/:id/duplicate', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    const newId = surveys.duplicateSurvey(ctx.db, survey.id, req.admin.id);
    ctx.redirect(res, `/admin/surveys/${newId}?hinweis=dupliziert`);
  }));

  router.post('/admin/surveys/:id/delete', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    if (!surveys.isDeleteConfirmation(survey, req.body.confirm)) {
      renderSurvey(ctx, req, res, survey, {
        status: 422,
        state: { deleteError: 'Die Eingabe stimmt nicht. Bitte den Titel der Umfrage oder „löschen“ eintippen.' },
      });
      return;
    }
    surveys.deleteSurvey(ctx.db, survey.id);
    ctx.redirect(res, '/admin?hinweis=geloescht');
  }));

  router.get('/admin/surveys/:id/preview', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req);
    const questions = surveys.getQuestions(ctx.db, survey.id);
    ctx.sendHtml(res, 200, surveyFormPage({ survey, questions, preview: true, req }));
  }));

  // --- Admins ---------------------------------------------------------------------------------

  router.get('/admin/admins', requireAdmin(async (req, res) => {
    renderAdmins(ctx, req, res, { notice: noticeFromQuery(req) });
  }));

  router.post('/admin/admins', requireAdmin(async (req, res) => {
    const values = { username: asString(req.body.username).trim(), display_name: asString(req.body.display_name).trim() };
    const password = asString(req.body.password);
    const errors = {};
    if (password !== asString(req.body.password2)) errors.password2 = 'Die beiden Passwörter stimmen nicht überein.';
    if (!errors.password2) {
      try {
        await ctx.auth.createAdmin(ctx.db, { username: values.username, displayName: values.display_name, password });
      } catch (err) {
        if (!(err instanceof ctx.auth.AuthError)) throw err;
        errors.general = err.userMessage;
      }
    }
    if (Object.keys(errors).length) {
      renderAdmins(ctx, req, res, { status: 422, state: { create: { errors, values } } });
      return;
    }
    ctx.redirect(res, '/admin/admins?hinweis=admin-neu');
  }));

  router.post('/admin/admins/password', requireAdmin(async (req, res) => {
    const current = asString(req.body.current);
    const password = asString(req.body.password);
    const errors = {};
    const check = await ctx.auth.verifyLogin(ctx.db, req.admin.username, current);
    if (!check.ok) errors.current = check.locked ? check.error : 'Das aktuelle Passwort ist falsch.';
    else if (password !== asString(req.body.password2)) errors.password2 = 'Die beiden neuen Passwörter stimmen nicht überein.';
    else {
      const pwErr = ctx.auth.validatePassword(password);
      if (pwErr) errors.password = pwErr;
    }
    if (Object.keys(errors).length) {
      renderAdmins(ctx, req, res, { status: 422, state: { password: { errors } } });
      return;
    }
    // setPassword beendet alle Sitzungen dieses Admins; für dieses Gerät gleich eine neue anlegen.
    await ctx.auth.setPassword(ctx.db, req.admin.id, password);
    const session = ctx.auth.createSession(ctx.db, req.admin.id, ctx.config.sessionHours);
    setCookie(res, ctx.auth.SESSION_COOKIE, session.token, {
      path: '/admin',
      httpOnly: true,
      sameSite: 'Strict',
      secure: ctx.config.cookieSecure,
      maxAge: ctx.config.sessionHours * 3600,
    });
    ctx.redirect(res, '/admin/admins?hinweis=passwort');
  }));

  router.post('/admin/admins/:aid/delete', requireAdmin(async (req, res) => {
    const id = parseId(req.params.aid, ctx);
    if (id === req.admin.id) {
      renderAdmins(ctx, req, res, { status: 409, state: { error: 'Das eigene Konto kann nicht gelöscht werden.' } });
      return;
    }
    if (!ctx.auth.getAdminById(ctx.db, id)) throw new ctx.HttpError(404);
    ctx.auth.deleteAdmin(ctx.db, id);
    ctx.redirect(res, '/admin/admins?hinweis=admin-geloescht');
  }));
}

module.exports = { register, requireAdmin, csrfField, checkOrigin };
