'use strict';

// Auswertung und PDF (SPEC §7 „Auswertung“, „PDF“):
//   GET /admin/surveys/:id/results       HTML-Auswertung
//   GET /admin/surveys/:id/results.pdf   PDF-Download
// Beide nur für angemeldete Admins und nur, wenn die Umfrage geschlossen ist und mindestens
// min_responses Teilnahmen vorliegen (SPEC §3 Regel 5). Sonst: Erklärung (HTML) bzw. 409 (PDF).

const surveys = require('../surveys');
const { buildResults } = require('../results');
const { renderResultsPdf, contentDisposition } = require('../pdf');
const { resultsBody } = require('../views/results');

/** Lädt Umfrage, Fragen und Antworten; wirft 404, wenn es die Umfrage nicht gibt. */
function loadSurvey(ctx, idParam) {
  if (!/^[1-9]\d{0,15}$/.test(String(idParam || ''))) throw new ctx.HttpError(404);
  const survey = surveys.getSurvey(ctx.db, Number(idParam));
  if (!survey) throw new ctx.HttpError(404);
  return survey;
}

function collect(ctx, survey) {
  const questions = surveys.getQuestions(ctx.db, survey.id);
  const answers = new Map();
  for (const q of questions) answers.set(q.id, surveys.getAnswersByQuestion(ctx.db, q.id));
  return buildResults(survey, questions, answers);
}

function notAvailable(ctx, res, req, survey, reason, status) {
  ctx.message(res, status, {
    title: 'Auswertung noch nicht verfügbar',
    message: reason || 'Die Auswertung ist erst verfügbar, wenn die Umfrage geschlossen ist und genug Teilnahmen vorliegen.',
    kind: 'warn',
    actions: [{ href: `/admin/surveys/${survey.id}`, label: 'Zur Umfrage', primary: true }],
    req,
  });
}

/**
 * @param {ReturnType<import('../http/router').createRouter>} router
 * @param {object} ctx  siehe src/routes/index.js
 */
function register(router, ctx) {
  const { requireAdmin } = ctx;

  router.get('/admin/surveys/:id/results', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req.params.id);
    const avail = surveys.resultsAvailable(survey);
    if (!avail.ok) {
      notAvailable(ctx, res, req, survey, avail.reason, 200);
      return;
    }
    const results = collect(ctx, survey);
    ctx.render(res, {
      title: `Auswertung: ${survey.title}`,
      req,
      active: 'surveys',
      bodyClass: 'page-results',
      body: resultsBody(results, { version: ctx.version, integrityStatus: ctx.integrity.getIntegrityStatus() }),
    });
  }));

  router.get('/admin/surveys/:id/results.pdf', requireAdmin(async (req, res) => {
    const survey = loadSurvey(ctx, req.params.id);
    const avail = surveys.resultsAvailable(survey);
    if (!avail.ok) {
      notAvailable(ctx, res, req, survey, avail.reason, 409);
      return;
    }
    const results = collect(ctx, survey);
    const pdf = await renderResultsPdf(results, { version: ctx.version });
    ctx.send(res, 200, pdf, 'application/pdf', {
      'Content-Disposition': contentDisposition(survey.title),
      'Cache-Control': 'no-store',
    });
  }));
}

module.exports = { register };
