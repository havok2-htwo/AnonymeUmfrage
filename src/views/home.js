'use strict';

// Startseite (SPEC §7): was das Tool ist, Link zur Transparenzseite und zum Adminbereich.
// Bewusst keine Liste von Umfragen.

const { html } = require('./html');
const { layout } = require('./layout');

function homePage() {
  const body = html`
    <section class="hero">
      <p class="eyebrow">Anonyme Umfrage</p>
      <h1 class="display">Ehrliche Antworten, ohne Namen.</h1>
      <p class="lead">Dieses Werkzeug sammelt Antworten auf Umfragen ohne Konto, ohne Cookie und ohne Tracking.
        Wer teilnehmen soll, bekommt einen Link. Antworten werden pro Frage getrennt und ungeordnet gespeichert,
        damit sich nicht nachvollziehen lässt, wer was geantwortet hat.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/transparenz">So funktioniert die Anonymität</a>
        <a class="btn btn-secondary" href="/admin">Zum Adminbereich</a>
      </div>
    </section>
    <section class="grid grid-3 home-facts">
      <article class="panel">
        <h2 class="panel-title">Keine Personendaten</h2>
        <p class="muted">Beim Absenden werden weder IP-Adresse noch Browserdaten oder Zeitpunkt gespeichert.</p>
      </article>
      <article class="panel">
        <h2 class="panel-title">Ergebnisse erst am Ende</h2>
        <p class="muted">Auswertungen gibt es erst nach dem Schließen der Umfrage und ab einer Mindestzahl an Teilnahmen.</p>
      </article>
      <article class="panel">
        <h2 class="panel-title">Offener Code</h2>
        <p class="muted">Der Server vergleicht seinen Code mit der veröffentlichten Version auf GitHub und zeigt das Ergebnis an.</p>
      </article>
    </section>`;
  return layout({ title: '', body });
}

module.exports = { homePage };
