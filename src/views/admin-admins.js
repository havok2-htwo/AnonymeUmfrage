'use strict';

// Adminbereich: Admins verwalten (anlegen, andere löschen) und eigenes Passwort ändern (SPEC §7).

const { html, when, formatDate } = require('./html');
const { flash, field, formErrors } = require('./admin');

function adminsBody({ req, csrfField, admins, notice, state = {} }) {
  const create = state.create || { errors: {}, values: {} };
  const me = req.admin.id;
  const rows = admins.map((a) => html`
    <tr>
      <td>${a.username}</td>
      <td>${a.display_name}</td>
      <td class="nowrap">${formatDate(a.created_at)}</td>
      <td class="actions-cell">
        ${a.id === me
    ? html`<span class="badge badge-plain badge-neutral">Ihr Konto</span>`
    : html`<form method="post" action="/admin/admins/${a.id}/delete" data-confirm="${`Admin „${a.username}“ wirklich löschen?`}">
            ${csrfField(req)}
            <button type="submit" class="btn btn-ghost btn-sm">Löschen</button>
          </form>`}
      </td>
    </tr>`);

  return html`
    <div class="page-head">
      <div class="page-head-text">
        <h1 class="page-title">Admins</h1>
        <p class="muted mb-0">Admins sind namentlich angemeldet und verwalten Umfragen. Teilnehmende brauchen kein Konto.</p>
      </div>
    </div>
    ${flash(notice)}
    ${when(state.error, () => html`<div class="alert alert-error" role="alert">${state.error}</div>`)}

    <section class="section" aria-labelledby="admins-liste">
      <h2 class="section-title" id="admins-liste">Alle Admins</h2>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th scope="col">Benutzername</th><th scope="col">Anzeigename</th><th scope="col">Angelegt am</th><th scope="col" class="actions-cell"><span class="visually-hidden">Aktionen</span></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>

    <div class="grid grid-2 section">
      <section class="panel" aria-labelledby="admin-neu">
        <h2 class="panel-title" id="admin-neu">Admin anlegen</h2>
        <form method="post" action="/admin/admins" class="form" autocomplete="off">
          ${csrfField(req)}
          ${formErrors(create.errors)}
          ${field({ id: 'neu-username', name: 'username', label: 'Benutzername', value: create.values.username || '', error: create.errors.username, required: true, attrs: html`maxlength="64" autocomplete="off"` })}
          ${field({ id: 'neu-display', name: 'display_name', label: 'Anzeigename', value: create.values.display_name || '', error: create.errors.display_name, hint: 'Leer = Benutzername.', attrs: html`maxlength="100"` })}
          ${field({ id: 'neu-password', name: 'password', label: 'Passwort', type: 'password', error: create.errors.password, required: true, hint: 'Mindestens 10 Zeichen.', attrs: html`minlength="10" autocomplete="new-password"` })}
          ${field({ id: 'neu-password2', name: 'password2', label: 'Passwort wiederholen', type: 'password', error: create.errors.password2, required: true, attrs: html`minlength="10" autocomplete="new-password"` })}
          <div class="actions"><button type="submit" class="btn btn-primary">Admin anlegen</button></div>
        </form>
      </section>

      <section class="panel" aria-labelledby="passwort">
        <h2 class="panel-title" id="passwort">Eigenes Passwort</h2>
        <p>Das eigene Passwort lässt sich jederzeit ändern. Andere Sitzungen dieses Kontos werden dabei beendet.</p>
        <div class="actions"><a class="btn btn-secondary" href="/admin/passwort">Passwort ändern</a></div>
      </section>
    </div>`;
}

module.exports = { adminsBody };
