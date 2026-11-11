'use strict';

// Adminbereich: eigenes Passwort ändern. Ist der Wechsel erzwungen (Standardzugang admin/admin),
// ist das die einzige erreichbare Seite, bis ein eigenes Passwort gesetzt ist.

const { html, when } = require('./html');
const { flash, field, formErrors } = require('./admin');

function passwordBody({ req, csrfField, notice = '', errors = {} }) {
  const forced = Boolean(req.admin && req.admin.must_change_password);
  return html`
    <div class="page-head">
      <div class="page-head-text">
        <h1 class="page-title">Passwort ändern</h1>
        <p class="muted mb-0">Angemeldet als ${req.admin.display_name} (${req.admin.username}).</p>
      </div>
    </div>
    ${flash(notice)}
    ${when(forced, () => html`<div class="alert alert-warn" role="status">
      <strong>Bitte zuerst ein eigenes Passwort festlegen.</strong>
      Mit dem Standardzugang ist der Adminbereich gesperrt, bis das Passwort geändert wurde.
    </div>`)}
    <section class="panel" aria-labelledby="passwort">
      <h2 class="panel-title" id="passwort">Neues Passwort</h2>
      <form method="post" action="/admin/passwort" class="form">
        ${csrfField(req)}
        ${formErrors(errors)}
        <input type="text" name="username" value="${req.admin.username}" autocomplete="username" hidden>
        ${field({ id: 'pw-current', name: 'current', label: 'Aktuelles Passwort', type: 'password', error: errors.current, required: true, attrs: html`autocomplete="current-password"` })}
        ${field({ id: 'pw-new', name: 'password', label: 'Neues Passwort', type: 'password', error: errors.password, required: true, hint: 'Mindestens 10 Zeichen. Andere Sitzungen dieses Kontos werden beendet.', attrs: html`minlength="10" autocomplete="new-password"` })}
        ${field({ id: 'pw-new2', name: 'password2', label: 'Neues Passwort wiederholen', type: 'password', error: errors.password2, required: true, attrs: html`minlength="10" autocomplete="new-password"` })}
        <div class="actions"><button type="submit" class="btn btn-primary">Passwort ändern</button></div>
      </form>
    </section>`;
}

module.exports = { passwordBody };
