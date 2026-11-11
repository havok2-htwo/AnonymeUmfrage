'use strict';

// Seitenrahmen: <head>, Topbar (Logo, App-Name, Theme-Schalter, Admin-Navigation), Inhalt, Fuß mit
// Version und Prüfstatus. Alle Seiten werden hierüber gerendert.

const { html, raw, classes } = require('./html');
const { version } = require('../version');
const integrity = require('../integrity');

/** Pfad zu einer Datei in public/ mit Versionsparameter (langes Caching). */
function asset(p) {
  return `${p}?v=${encodeURIComponent(version)}`;
}

// Text und Badge-Klasse des Prüfstatus kommen aus einer Quelle (src/integrity.js), damit Fuß,
// Transparenzseite, Auswertung und PDF immer dasselbe anzeigen.
const { integrityLabel } = integrity;

const THEME_ICON = raw('<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2v16a8 8 0 0 1 0-16Z"/></svg>');

const ADMIN_NAV = [
  { key: 'surveys', href: '/admin', label: 'Umfragen' },
  { key: 'admins', href: '/admin/admins', label: 'Admins' },
  { key: 'passwort', href: '/admin/passwort', label: 'Passwort' },
];

function adminNav(req, active) {
  if (!req || !req.admin || !req.session) return '';
  return html`
    <nav class="topnav" aria-label="Adminbereich">
      ${ADMIN_NAV.map((item) => html`<a href="${item.href}" class="${classes('topnav-link', { 'is-active': item.key === active })}"${item.key === active ? raw(' aria-current="page"') : ''}>${item.label}</a>`)}
      <span class="topnav-user" title="Angemeldet">${req.admin.display_name}</span>
      <form method="post" action="/admin/logout" class="topnav-logout">
        <input type="hidden" name="_csrf" value="${req.session.csrf}">
        <button type="submit" class="btn btn-ghost btn-sm">Abmelden</button>
      </form>
    </nav>`;
}

function footer() {
  const label = integrityLabel();
  return html`
    <footer class="site-footer">
      <div class="container site-footer-inner">
        <span class="site-footer-version">Version ${version}</span>
        <a class="${classes('badge', label.badge, 'integrity-badge')}" href="/transparenz">${label.text}</a>
        <a class="site-footer-link" href="/transparenz">Transparenz</a>
      </div>
    </footer>`;
}

/**
 * Komplette HTML-Seite als String.
 * @param {object} o
 * @param {string} o.title        Seitentitel (ohne App-Namen)
 * @param {*}      o.body         Inhalt (SafeHtml)
 * @param {object} [o.req]        Anfrage; mit req.admin + req.session wird die Admin-Navigation gezeigt
 * @param {string} [o.active]     aktiver Navigationspunkt: 'surveys' | 'admins'
 * @param {'narrow'|'default'|'wide'} [o.width]  Inhaltsbreite
 * @param {string[]} [o.scripts]  zusätzliche Skripte aus public/, z. B. ['/js/admin.js'] (defer)
 * @param {string} [o.bodyClass]  zusätzliche Klasse für <body>
 * @param {boolean} [o.noindex]   robots noindex (Standard true)
 */
function layout({
  title, body, req = null, active = '', width = 'default', scripts = [], bodyClass = '', noindex = true,
}) {
  const isAdmin = Boolean(req && req.admin);
  const fullTitle = title ? `${title} · Umfrage` : 'Umfrage';
  const page = html`<!doctype html>
<html lang="de" data-theme="dark" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${noindex ? raw('<meta name="robots" content="noindex, nofollow">\n') : ''}<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="dark light">
<title>${fullTitle}</title>
<link rel="icon" href="${asset('/img/favicon.svg')}" type="image/svg+xml">
<link rel="preload" href="/fonts/Montserrat-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${asset('/css/app.css')}">
<script src="${asset('/js/theme.js')}"></script>
${scripts.map((s) => html`<script src="${asset(s)}" defer></script>\n`)}</head>
<body class="${classes(bodyClass, isAdmin && 'is-admin')}">
<a class="skip-link" href="#inhalt">Zum Inhalt springen</a>
<header class="topbar">
  <a class="brand" href="${isAdmin ? '/admin' : '/'}">
    <img class="brand-logo" src="/img/SonsLogo.webp" alt="SONS" width="88" height="52">
    <span class="brand-line" aria-hidden="true"></span>
    <span class="brand-title">Umfrage</span>
  </a>
  <div class="topbar-actions">
    ${adminNav(req, active)}
    <button type="button" class="btn-icon theme-toggle" id="theme-toggle" aria-label="Hell- oder Dunkelmodus umschalten" title="Hell/Dunkel">${THEME_ICON}</button>
  </div>
</header>
<main id="inhalt" class="${classes('container', { 'container-narrow': width === 'narrow', 'container-wide': width === 'wide' })}">
${body}
</main>
${footer()}
</body>
</html>
`;
  return page.toString();
}

module.exports = { layout, asset, integrityLabel };
