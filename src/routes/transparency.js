'use strict';

// Transparenzseite (SPEC §6): GET /transparenz, GET /transparenz.json.
// Öffentlich, ohne Cookies. Daten kommen aus dem Speicher der Integritätsprüfung.

const { transparencyPage, transparencyJson } = require('../views/transparency');

/**
 * @param {ReturnType<import('../http/router').createRouter>} router
 * @param {object} ctx  siehe src/routes/index.js
 */
function register(router, ctx) {
  router.get('/transparenz', (req, res) => {
    const status = ctx.integrity.getIntegrityStatus();
    ctx.sendHtml(res, 200, transparencyPage({ status, baseUrl: ctx.baseUrl(req) }));
  });

  router.get('/transparenz.json', (req, res) => {
    const status = ctx.integrity.getIntegrityStatus();
    ctx.sendJson(res, 200, transparencyJson(status));
  });
}

module.exports = { register };
