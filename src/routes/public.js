'use strict';

// Öffentliche Umfrageseiten (SPEC §7 „Öffentlich“): GET/POST /u/:slug, GET /u/:slug/danke.
//
// Anonymität (SPEC §3): Hier werden keine Cookies gesetzt oder gelesen, keine Header ausgewertet,
// nichts geloggt. Antworten speichert surveys.submitResponse() (eine Transaktion, danach VACUUM).
// Alle Antworten haben Cache-Control: no-store (Standard von respond.send).

const surveys = require('../surveys');
const { surveyFormPage, closedPage, thanksPage } = require('../views/survey');

const BODY_LIMIT = 256 * 1024;

/** Umfrage zum Slug; Entwurf oder unbekannt → 404 (keine Bestätigung, dass es den Link gibt). */
function findPublicSurvey(ctx, slug) {
  const survey = surveys.getSurveyBySlug(ctx.db, slug);
  if (!survey || survey.status === 'draft') throw new ctx.HttpError(404);
  return survey;
}

/**
 * @param {ReturnType<import('../http/router').createRouter>} router
 * @param {object} ctx  siehe src/routes/index.js
 */
function register(router, ctx) {
  router.get('/u/:slug', async (req, res) => {
    const survey = findPublicSurvey(ctx, req.params.slug);
    if (survey.status === 'closed') {
      ctx.sendHtml(res, 200, closedPage(survey));
      return;
    }
    const questions = surveys.getQuestions(ctx.db, survey.id);
    ctx.sendHtml(res, 200, surveyFormPage({ survey, questions }));
  });

  router.post('/u/:slug', async (req, res) => {
    const survey = findPublicSurvey(ctx, req.params.slug);
    const form = await ctx.readForm(req, { limit: BODY_LIMIT });
    if (survey.status !== 'open') {
      ctx.sendHtml(res, 409, closedPage(survey));
      return;
    }
    let result;
    try {
      result = surveys.submitResponse(ctx.db, survey.id, form);
    } catch (err) {
      if (err instanceof surveys.SurveyError) {
        ctx.sendHtml(res, 409, closedPage(surveys.getSurvey(ctx.db, survey.id) || survey));
        return;
      }
      throw err;
    }
    if (!result.ok) {
      const questions = surveys.getQuestions(ctx.db, survey.id);
      ctx.sendHtml(res, 422, surveyFormPage({ survey, questions, errors: result.errors, values: result.values }));
      return;
    }
    ctx.redirect(res, `/u/${survey.slug}/danke`);
  });

  router.get('/u/:slug/danke', async (req, res) => {
    const survey = findPublicSurvey(ctx, req.params.slug);
    ctx.sendHtml(res, 200, thanksPage(survey));
  });
}

module.exports = { register };
