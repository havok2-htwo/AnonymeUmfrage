'use strict';

// Anmeldeseite für den Adminbereich.

const { html } = require('./html');
const { layout } = require('./layout');

/**
 * @param {object} o
 * @param {string} [o.error]     Fehlermeldung (bereits nutzerfreundlich)
 * @param {string} [o.username]  vorbelegter Benutzername
 * @param {string} [o.next]      Ziel nach der Anmeldung (nur /admin…)
 * @param {string} [o.notice]    Hinweis, z. B. nach dem Abmelden
 */
function loginPage({ error = '', username = '', next = '', notice = '' } = {}) {
  const body = html`
    <section class="panel login-panel">
      <h1 class="page-title">Anmelden</h1>
      <p class="muted">Der Adminbereich ist nur für die Verwaltung der Umfragen. Teilnehmende brauchen keine Anmeldung.</p>
      ${notice ? html`<div class="alert alert-success" role="status">${notice}</div>` : ''}
      ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
      <form method="post" action="/admin/login" class="form stack">
        ${next ? html`<input type="hidden" name="next" value="${next}">` : ''}
        <div class="field">
          <label class="label" for="login-username">Benutzername</label>
          <input class="input" id="login-username" name="username" type="text" value="${username}"
            autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
        </div>
        <div class="field">
          <label class="label" for="login-password">Passwort</label>
          <input class="input" id="login-password" name="password" type="password"
            autocomplete="current-password" maxlength="1024" required>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn-primary">Anmelden</button>
        </div>
      </form>
    </section>`;
  return layout({ title: 'Anmelden', body, width: 'narrow' });
}

module.exports = { loginPage };
