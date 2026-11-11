'use strict';

// Fehler- und Meldungsseiten.

const { html } = require('./html');
const { layout } = require('./layout');

/**
 * Allgemeine Meldungsseite.
 * @param {object} o
 * @param {string} o.title
 * @param {string|object} [o.message]  Text oder SafeHtml
 * @param {'info'|'success'|'warn'|'error'} [o.kind]
 * @param {Array<{href:string, label:string, primary?:boolean}>} [o.actions]
 * @param {object} [o.req]
 */
function messagePage({ title, message = '', kind = 'info', actions = [], req = null }) {
  const body = html`
    <section class="panel message-panel ${`message-${kind}`}">
      <h1 class="page-title">${title}</h1>
      ${message ? html`<p class="lead">${message}</p>` : ''}
      ${actions.length ? html`<div class="actions">${actions.map((a) => html`<a class="btn ${a.primary ? 'btn-primary' : 'btn-secondary'}" href="${a.href}">${a.label}</a>`)}</div>` : ''}
    </section>`;
  return layout({ title, body, req, width: 'narrow' });
}

function notFoundPage(req = null) {
  return messagePage({
    title: 'Seite nicht gefunden',
    message: 'Diese Adresse gibt es nicht. Bitte den Link prüfen.',
    actions: [{ href: '/', label: 'Zur Startseite' }],
    req,
  });
}

function methodNotAllowedPage(req = null) {
  return messagePage({
    title: 'Aktion nicht möglich',
    message: 'Diese Adresse unterstützt diese Anfrage nicht.',
    kind: 'warn',
    actions: [{ href: '/', label: 'Zur Startseite' }],
    req,
  });
}

/** Seite für HttpError mit eigener Meldung (z. B. 403, 413, 415). */
function errorPage(status, message, req = null) {
  const titles = {
    400: 'Ungültige Anfrage',
    403: 'Nicht erlaubt',
    404: 'Seite nicht gefunden',
    405: 'Aktion nicht möglich',
    413: 'Daten zu groß',
    415: 'Format nicht unterstützt',
    429: 'Zu viele Anfragen',
  };
  return messagePage({
    title: titles[status] || 'Fehler',
    message: message || 'Die Anfrage konnte nicht verarbeitet werden.',
    kind: 'error',
    actions: [{ href: '/', label: 'Zur Startseite' }],
    req,
  });
}

function serverErrorPage(req = null) {
  return messagePage({
    title: 'Ein Fehler ist aufgetreten',
    message: 'Etwas ist schiefgelaufen. Es wurde nichts gespeichert. Bitte später erneut versuchen.',
    kind: 'error',
    actions: [{ href: '/', label: 'Zur Startseite' }],
    req,
  });
}

module.exports = { messagePage, notFoundPage, methodNotAllowedPage, errorPage, serverErrorPage };
