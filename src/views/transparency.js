'use strict';

// Transparenzseite (SPEC §6 und §3): Version, Prüfstatus, Fingerabdruck, Dateiliste,
// Anonymitätsregeln in Klartext, offene Grenzen und Anleitung zum Selbstprüfen.

const { html, classes, formatDateTime, formatNumber } = require('./html');
const { layout } = require('./layout');
const { integrityLabel } = require('../integrity');

const FILE_STATUS = {
  identical: { text: 'identisch', badge: 'badge-success' },
  different: { text: 'abweichend', badge: 'badge-error' },
  missing: { text: 'fehlt lokal', badge: 'badge-error' },
  extra: { text: 'zusätzlich', badge: 'badge-error' },
  unchecked: { text: 'nicht geprüft', badge: 'badge-neutral' },
};

/** Git-Blob-Hash einer Datei im Container ohne Git (busybox: printf, wc, cat, sha1sum). */
const CONTAINER_HASH_COMMAND = `docker compose exec umfrage sh -c 'f=src/server.js; { printf "blob %d\\0" "$(wc -c < "$f")"; cat "$f"; } | sha1sum'`;

const FINGERPRINT_COMMAND = "git -c core.quotePath=false ls-tree -r --format='%(path) %(objectname)' HEAD | LC_ALL=C sort | sha256sum";

/** Anonymitätsregeln (SPEC §3) in Klartext. */
const RULES = [
  ['Keine Personendaten beim Absenden', 'Gespeichert werden nur die Antworten selbst. IP-Adresse, Browserkennung, Cookies, Herkunftsseite und Zeitpunkt werden weder gespeichert noch protokolliert. Der Server schreibt kein Zugriffsprotokoll, und Fehlermeldungen enthalten keine Anfragedaten.'],
  ['Jede Antwort steht für sich', 'Jede Antwort auf eine Frage ist ein eigener Datensatz mit einer zufälligen ID. Es gibt keine Spalte und keine Tabelle, die Antworten derselben Person verbindet, und keine Reihenfolge des Eintragens, über die sich Antworten wieder zusammensetzen lassen.'],
  ['Ausgabe immer gemischt', 'In Auswertung und PDF werden die Antworten jeder Frage zufällig gemischt. Aus der Reihenfolge lässt sich nicht ablesen, wer zuerst oder zuletzt geantwortet hat.'],
  ['Nur ein Zähler', 'Pro Umfrage wird nur gezählt, wie viele Teilnahmen es gab. Eine Teilnahmeliste gibt es nicht.'],
  ['Ergebnisse erst nach Abschluss', 'Solange eine Umfrage offen ist, sieht auch der Adminbereich keine Inhalte und nicht einmal die Zahl der Teilnahmen; eine laufend sichtbare Zahl würde verraten, wann jemand teilgenommen hat. Inhalte gibt es erst, wenn die Umfrage geschlossen ist und eine Mindestzahl an Teilnahmen erreicht wurde (Standard 3, mindestens 2). Wird die Mindestzahl nicht erreicht, werden die Antworten beim Schließen gelöscht. Eine Teilnahme ohne eine einzige Antwort wird abgelehnt und nicht gezählt. Haben eine einzelne Frage weniger Personen beantwortet als die Mindestzahl, wird diese Frage in Auswertung und PDF ausgeblendet.'],
  ['Schließen ist endgültig', 'Eine geschlossene Umfrage lässt sich nicht wieder öffnen. So kann niemand nach dem Ansehen der Ergebnisse auf eine einzelne neue Antwort warten und sie per Vergleich zuordnen.'],
  ['Fragen sind eingefroren', 'Nach dem Öffnen lassen sich Fragen, Antwortmöglichkeiten, Reihenfolge und Mindestzahl nicht mehr ändern.'],
  ['Keine Drittanbieter', 'Schriften, Bilder und Skripte kommen vom eigenen Server. Es gibt keine Analyse, kein CDN und keine eingebetteten Inhalte. Strenge Sicherheitsheader verhindern, dass der Browser fremde Quellen lädt oder die Herkunftsseite weitergibt.'],
  ['Keine Cookies für Teilnehmende', 'Cookies gibt es nur im Adminbereich für die Anmeldung. Die Umfrageseiten setzen und lesen keine Cookies.'],
  ['Hinweis „bereits teilgenommen“ nur im Browser', 'Nach dem Absenden merkt sich nur der eigene Browser, dass auf diesem Gerät teilgenommen wurde. Die Anwendung sendet diese Information nie; sie bleibt im Browser und lässt sich jederzeit übergehen.'],
  ['Absenden ganz oder gar nicht', 'Alle Antworten einer Teilnahme werden gemeinsam gespeichert. Bei einem Fehler wird nichts gespeichert.'],
  ['Leere Antworten werden nicht gespeichert', 'Übersprungene freiwillige Fragen hinterlassen keinen Datensatz. Die Auswertung zeigt pro Frage, wie viele geantwortet haben. Liegt diese Zahl unter der Mindestzahl, steht dort nur „Zu wenige Antworten, zum Schutz der Anonymität ausgeblendet“.'],
  ['Keine Spuren in der Datenbankdatei', 'Nach jeder Teilnahme wird die Datenbank neu geschrieben (VACUUM). Danach liegen die Datensätze nach ihrer zufälligen ID geordnet in der Datei, nicht in der Reihenfolge des Eintragens. Gelöschte Inhalte werden in der Datei überschrieben. Schlägt das Neuschreiben einmal fehl, wird es beim Schließen, beim Neustart und im Minutentakt nachgeholt. Was das für Kopien der Datei und gelöschte Hilfsdateien heißt, steht unten bei den Grenzen.'],
  ['Umfrage-Code zum Vergleichen', 'Jede Teilnahmeseite zeigt direkt unter dem Titel einen Code wie „7K3M-Q9TD-4WXA“, der aus dem Link berechnet wird. Alle Eingeladenen sehen denselben Code. Wer einen anderen sieht, hat einen eigenen Link bekommen, und dann ist die Umfrage für diese Person nicht anonym.'],
  ['Formular wird nach dem Absenden geleert', 'Damit „Zurück“ im Browser die eigenen Antworten nicht wieder zeigt, leert die Seite das Formular nach dem Absenden. Ohne JavaScript klappt das nicht in jedem Browser.'],
];

const STORED = [
  'die Antworten selbst, jede als eigener Datensatz mit zufälliger ID und ohne Zeitstempel',
  'pro Umfrage die Zahl der Teilnahmen (angezeigt erst nach dem Schließen)',
  'Titel, Einleitung und Fragen der Umfrage',
  'Verwaltungsdaten der Umfrage: wer sie angelegt hat, wann sie geöffnet und geschlossen wurde',
  'Admin-Konten (Name, Passwort als scrypt-Hash) und deren Sitzungen (nur als Hash)',
];

const NOT_STORED = [
  'IP-Adresse, Browser, Betriebssystem oder Gerät',
  'Zeitpunkt einer Teilnahme',
  'Cookies, Sitzungen oder Kennungen von Teilnehmenden',
  'eine Zuordnung, welche Antworten zur selben Teilnahme gehören',
  'Zugriffsprotokolle des Servers',
];

const LIMITS = [
  'Wer den Server betreibt, dem muss man vertrauen. Wer ihn kontrolliert, kann die Anwendung absichtlich verändern und dann alles mitlesen, auch IP-Adressen. Gut ist, wenn Betrieb und Umfrage bei verschiedenen Personen liegen oder eine Vertrauensperson die Installation ansieht.',
  'Wer die Umfrage verwaltet, kann selbst mehrfach über den Link teilnehmen. Wer so oft teilnimmt, dass zusammen mit einer echten Teilnahme die Mindestzahl erreicht ist, und dann schließt, kann die eigenen Antworten abziehen und alle Antworten dieser einen Person lesen. Die Software kann eigene und echte Teilnahmen ohne Kennungen nicht unterscheiden. Dass die Zahl der Teilnahmen bis zum Schließen verborgen bleibt, macht das nur schwerer.',
  'Bekommt jede Person einen eigenen Link (eine eigene, gleich aussehende Umfrage), ist die Umfrage nicht anonym. Erkennbar ist das am Umfrage-Code, wenn Teilnehmende ihn vergleichen. Nicht erkennbar ist dagegen: Zwei fast gleiche Umfragen an leicht verschiedene Gruppen (etwa einmal an alle, einmal an alle außer einer Person) lassen sich vergleichen und grenzen einzelne Antworten ein.',
  'Wer die Datenbankdatei zu zwei Zeitpunkten in die Hände bekommt (Datensicherungen, Snapshots), sieht durch Vergleich, welche Antworten dazwischen dazukamen – bei nur einer Teilnahme in dieser Zeit also alle Antworten dieser Person. Wer die Datei lesen kann, sieht Antworten auch schon vor dem Schließen. Gelöschte Hilfsdateien der Datenbank (Rollback-Journal) lassen sich forensisch unter Umständen wiederherstellen.',
  'Wird die Auswertung in einer sehr kleinen Gruppe geteilt oder ist die Mindestzahl auf 2 gesetzt, kann jede teilnehmende Person durch Abziehen der eigenen Antworten auf die der anderen schließen.',
  'Freitexte können über Schreibstil oder Inhalt Rückschlüsse auf die Person erlauben. Das kann keine Technik verhindern. Schreibhilfen von Browser, Erweiterungen oder Tastatur können eingegebenen Text an ihre Anbieter senden.',
  'Die Mindestzahl gilt pro Frage, nicht pro Option. Ein Zählwert von 1 bei einer Option, die nur auf eine Person passt, zeigt deren Teilnahme; haben alle dasselbe geantwortet, kennt man die Antwort jeder Person, von der man weiß, dass sie teilgenommen hat. Wird eine Auswertung in einer sehr kleinen Gruppe geteilt, können Teilnehmende durch Abziehen der eigenen Antworten auf die anderen schließen.',
  'Der Browserverlauf zeigt, dass und wann die Danke-Seite aufgerufen wurde; dazu kommt der lokale Hinweis „bereits teilgenommen“. Auf geteilten Geräten hilft ein privates Fenster.',
  'Ein Firmen-Proxy, der verschlüsselte Verbindungen aufbricht, kann Antworten lesen. Wer die Datenmenge je Verbindung protokolliert, kann die Länge langer Freitexte ablesen. Wer den Server dauernd abfragt, kann an Antwortzeiten erkennen, wann jemand teilnimmt (nicht was).',
  'Ein vorgeschalteter Webserver (z. B. nginx) könnte IP-Adressen protokollieren. Die Installationsanleitung zeigt, wie man das abschaltet. Die Anwendung selbst kann das nicht prüfen.',
  'Die Integritätsprüfung führt der Server selbst durch, und sie umfasst nur die Dateien des Repositorys (nicht node_modules, die Node-Laufzeit, das Container-Image oder Startparameter). Sie schützt vor versehentlichen Abweichungen, ist aber kein Beweis gegen einen Betreiber, der absichtlich manipuliert. Auch diese Seite ist eine Selbstauskunft; eine echte Prüfung braucht Zugriff auf den Server oder eine Vertrauensperson.',
  'Mehrfachteilnahme wird nicht technisch verhindert, denn das ginge nur mit Kennungen. Der Hinweis „bereits teilgenommen“ ist eine Erinnerung, keine Sperre.',
];

function link(href, text, cls = '') {
  if (!href) return html`<span class="${cls}">${text}</span>`;
  return html`<a class="${cls}" href="${href}" rel="noopener noreferrer">${text}</a>`;
}

function statusAlert(status, label) {
  const kind = { success: 'alert-success', error: 'alert-error', warn: 'alert-warn' }[label.tone];
  let detail;
  if (status.state === 'identical') {
    detail = html`Jede Datei des Repositorys hat in dieser Installation denselben Git-Hash wie im
      veröffentlichten Tag ${status.tag}, und es gibt keine zusätzlichen Dateien. Nicht geprüft werden
      node_modules, die Node-Laufzeit, das Container-Image und Startparameter.`;
  } else if (status.state === 'different') {
    detail = html`${status.reason}. Die betroffenen Dateien stehen unten. Das kann eine lokale Anpassung sein,
      eine nicht veröffentlichte Version oder eine Manipulation.`;
  } else if (status.checking) {
    detail = html`Der Abgleich mit GitHub läuft gerade. Bitte die Seite gleich neu laden.`;
  } else {
    detail = html`Der Code wurde nicht mit GitHub verglichen. Die lokalen Hashes unten lassen sich trotzdem
      selbst prüfen.`;
  }
  return html`
    <div class="${classes('alert', kind, 'integrity-alert')}" role="status">
      <strong class="alert-title">${label.text}</strong>
      <span>${detail}</span>
    </div>`;
}

function statsBlock(summary, checked) {
  if (!checked) {
    return html`
      <div class="stats">
        <div class="stat"><span class="stat-value">${formatNumber(summary.total)}</span><span class="stat-label">Dateien lokal</span></div>
      </div>`;
  }
  const items = [
    [summary.identical, 'identisch'],
    [summary.different, 'abweichend'],
    [summary.missing, 'fehlen lokal'],
    [summary.extra, 'zusätzlich'],
  ];
  return html`
    <div class="stats">
      ${items.map(([n, text]) => html`<div class="stat"><span class="stat-value">${formatNumber(n)}</span><span class="stat-label">${text}</span></div>`)}
    </div>`;
}

function fileTable(files, { showRemote }) {
  return html`
    <div class="table-wrap">
      <table class="table table-compact file-table">
        <thead>
          <tr>
            <th scope="col">Datei</th>
            <th scope="col">Git-Hash lokal</th>
            ${showRemote ? html`<th scope="col">Git-Hash auf GitHub</th>` : ''}
            <th scope="col">Ergebnis</th>
          </tr>
        </thead>
        <tbody>
          ${files.map((f) => {
            const st = FILE_STATUS[f.status] || FILE_STATUS.unchecked;
            return html`
          <tr>
            <td class="mono break">${f.path}</td>
            <td class="mono hash">${f.status === 'extra' ? '–' : (f.localHash || '–')}</td>
            ${showRemote ? html`<td class="mono hash">${f.remoteHash || '–'}</td>` : ''}
            <td><span class="${classes('badge', st.badge)}">${st.text}</span></td>
          </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
}

function deviations(status) {
  const list = status.files.filter((f) => f.status !== 'identical' && f.status !== 'unchecked');
  if (status.state !== 'different' || list.length === 0) return '';
  return html`
    <section class="section">
      <h2 class="section-title">Abweichende Dateien</h2>
      ${fileTable(list, { showRemote: true })}
    </section>`;
}

/**
 * @param {object} o
 * @param {object} o.status   getIntegrityStatus()
 * @param {string} o.baseUrl  Basisadresse dieser Installation (für den JSON-Link)
 * @param {object} [o.req]
 */
function transparencyPage({ status, baseUrl = '', req = null }) {
  const label = integrityLabel(status);
  const checked = status.state === 'identical' || status.state === 'different';
  const repoUrl = status.repoUrl || 'https://github.com/havok2-htwo/AnonymeUmfrage';
  const repoDir = repoUrl.split('/').pop();
  const verifyCommands = [
    `git clone ${repoUrl} && cd ${repoDir}`,
    `git checkout ${status.tag}`,
    'git ls-tree -r HEAD      # Hashes mit der Tabelle vergleichen',
  ].join('\n');

  const body = html`
    <div class="page-head">
      <div class="page-head-text">
        <p class="eyebrow">Version ${status.version}</p>
        <h1 class="page-title">Transparenz</h1>
        <p class="lead">Hier steht, was diese Anwendung speichert und was nicht, welche Grenzen es gibt, was der
          Server über seinen eigenen Code meldet und wie sich das prüfen lässt.</p>
      </div>
    </div>

    <section class="section transparency-status" aria-labelledby="pruefstatus">
      <h2 class="section-title" id="pruefstatus">Prüfstatus</h2>
      ${statusAlert(status, label)}
      <div class="panel">
        <dl class="meta-list">
          <dt>Version</dt>
          <dd>${status.version}</dd>
          <dt>Git-Tag</dt>
          <dd>${link(status.tagUrl, status.tag, 'mono')}</dd>
          <dt>Commit des Tags</dt>
          <dd>${status.commit ? link(status.commitUrl, status.commit, 'mono break') : html`<span class="muted">nicht bekannt</span>`}</dd>
          <dt>Repository</dt>
          <dd>${link(status.repoUrl, status.repo || '–', 'break')}</dd>
          <dt>Ergebnis</dt>
          <dd><span class="${classes('badge', label.badge)}">${label.text}</span></dd>
          <dt>Geprüft am</dt>
          <dd>${status.checkedAt ? formatDateTime(status.checkedAt) : html`<span class="muted">noch nicht</span>`}</dd>
          <dt>Gesamt-Fingerabdruck</dt>
          <dd>${status.fingerprint ? html`<span class="mono break">${status.fingerprint}</span>` : html`<span class="muted">nicht berechnet</span>`}</dd>
          ${status.remoteFingerprint ? html`
          <dt>Fingerabdruck des Tags</dt>
          <dd><span class="mono break">${status.remoteFingerprint}</span></dd>` : ''}
        </dl>
      </div>
      ${statsBlock(status.summary, checked)}
      <p class="muted small">Der lokale Fingerabdruck wird beim Start des Servers berechnet, der Abgleich mit GitHub
        läuft beim Start und danach alle 6 Stunden. Die Daten gibt es auch maschinenlesbar unter
        <a href="/transparenz.json">/transparenz.json</a>.</p>
    </section>

    ${deviations(status)}

    <section class="section" aria-labelledby="dateien">
      <h2 class="section-title" id="dateien">Alle Dateien</h2>
      <details class="disclosure">
        <summary>Dateiliste mit Git-Hashes anzeigen (${formatNumber(status.files.length)} Dateien)</summary>
        <div class="disclosure-body">
          ${status.files.length ? fileTable(status.files, { showRemote: checked }) : html`<p class="muted">Keine Dateien ermittelt.</p>`}
        </div>
      </details>
    </section>

    <section class="section" aria-labelledby="selbst-pruefen">
      <h2 class="section-title" id="selbst-pruefen">Selbst prüfen</h2>
      <div class="stack">
        <p>Die Anzeige oben und die Dateiliste erstellt der Server über sich selbst. Die Schritte 1 und 2
          gleichen diese Selbstauskunft mit GitHub ab; ein manipulierter Server könnte dabei einfach die
          richtigen Hashes melden. Die eigentliche Prüfung ist Schritt 3 und braucht Zugriff auf den Server.
          Git berechnet für jede Datei einen Hash aus ihrem Inhalt
          (<span class="mono">sha1("blob " + Länge + "\\0" + Inhalt)</span>). Derselbe Inhalt ergibt immer
          denselben Hash, jede Änderung einen anderen.</p>
        <h3>1. Veröffentlichten Code holen</h3>
        <pre><code>${verifyCommands}</code></pre>
        <p>Die Ausgabe von <code>git ls-tree</code> enthält für jede Datei den Hash. Er muss mit der Spalte
          „Git-Hash lokal“ in der Dateiliste übereinstimmen. Den Code selbst kann jede und jeder auf GitHub lesen.</p>
        <h3>2. Gesamt-Fingerabdruck nachrechnen</h3>
        <p>Im ausgecheckten Tag (Linux, macOS oder Git Bash unter Windows):</p>
        <pre><code>${FINGERPRINT_COMMAND}</code></pre>
        <p>Das Ergebnis muss dem Gesamt-Fingerabdruck oben entsprechen. Er ist der sha256-Hash über die byteweise
          sortierten Zeilen <span class="mono">pfad hash</span>.</p>
        <h3>3. Einzelne Dateien der Installation prüfen</h3>
        <p>Wer Zugriff auf den Server hat, berechnet den Hash einer Datei direkt im Anwendungsordner. Wichtig
          ist <code>--no-filters</code>: Ohne diese Option normalisiert Git die Zeilenenden vor dem Hashen und
          könnte so eine abweichende Datei als gleich melden.</p>
        <pre><code>git hash-object --no-filters src/server.js</code></pre>
        <p>Im Container ist kein Git installiert. Dort geht es mit Bordmitteln:</p>
        <pre><code>${CONTAINER_HASH_COMMAND}</code></pre>
        <p>Die Daten dieser Seite gibt es maschinenlesbar, zum Beispiel für ein eigenes Prüfskript:</p>
        <pre><code>curl -s ${baseUrl}/transparenz.json</code></pre>
        <p class="muted small">Alle Dateien werden mit Zeilenende LF gespeichert (<code>.gitattributes</code>).
          Dadurch stimmen die Hashes auch unter Windows.</p>
      </div>
    </section>

    <section class="section" aria-labelledby="regeln">
      <h2 class="section-title" id="regeln">So bleibt die Umfrage anonym</h2>
      <ol class="rule-list">
        ${RULES.map(([title, text]) => html`<li><strong>${title}.</strong> ${text}</li>`)}
      </ol>
    </section>

    <section class="section" aria-labelledby="daten">
      <h2 class="section-title" id="daten">Was gespeichert wird</h2>
      <div class="grid grid-2">
        <article class="panel">
          <h3 class="panel-title">Gespeichert</h3>
          <ul>${STORED.map((s) => html`<li>${s}</li>`)}</ul>
        </article>
        <article class="panel">
          <h3 class="panel-title">Nicht gespeichert</h3>
          <ul>${NOT_STORED.map((s) => html`<li>${s}</li>`)}</ul>
        </article>
      </div>
    </section>

    <section class="section" aria-labelledby="grenzen">
      <h2 class="section-title" id="grenzen">Grenzen, offen benannt</h2>
      <div class="panel panel-muted">
        <ul>${LIMITS.map((s) => html`<li>${s}</li>`)}</ul>
      </div>
    </section>

    <section class="section" aria-labelledby="abhaengigkeiten">
      <h2 class="section-title" id="abhaengigkeiten">Abhängigkeiten</h2>
      <p>Die einzige Laufzeitabhängigkeit ist <code>pdfkit</code> für den PDF-Export. Der Ordner
        <code>node_modules</code> im Anwendungsordner ist nicht Teil des Abgleichs. Ein <code>node_modules</code>-Ordner
        an anderer Stelle (z. B. in <code>src/</code>) würde von Node zuerst geladen und erscheint deshalb als
        zusätzliche Datei. Abgesichert wird er über
        <code>package-lock.json</code>: Diese Datei legt jede Abhängigkeit mit Version und Prüfsumme fest und ist
        Teil des Abgleichs. <code>npm ci</code> installiert genau diese Versionen und bricht ab, wenn eine
        Prüfsumme nicht stimmt. Das geschieht nur beim Bauen; der laufende Server prüft
        <code>node_modules</code> nicht.</p>
    </section>`;

  return layout({ title: 'Transparenz', body, req, bodyClass: 'page-transparency' });
}

/** Maschinenlesbare Fassung (GET /transparenz.json). Enthält keine Geheimnisse. */
function transparencyJson(status) {
  const label = integrityLabel(status);
  return {
    name: 'anonyme-umfrage',
    version: status.version,
    tag: status.tag,
    state: status.state,
    reason: status.reason,
    label: label.text,
    checking: status.checking,
    repo: status.repo,
    repoUrl: status.repoUrl,
    tagUrl: status.tagUrl,
    commit: status.commit,
    commitUrl: status.commitUrl,
    checkedAt: status.checkedAt,
    localComputedAt: status.localComputedAt,
    fingerprint: status.fingerprint,
    remoteFingerprint: status.remoteFingerprint,
    fingerprintAlgorithm: 'sha256 über die byteweise sortierten Zeilen "pfad githash\\n"',
    hashAlgorithm: 'Git-Blob-Hash: sha1("blob " + Bytelänge + "\\0" + Inhalt)',
    verifyCommand: FINGERPRINT_COMMAND,
    summary: status.summary,
    files: status.files.map((f) => ({
      // Zusätzliche Dateien gibt es auf GitHub nicht; ihr Hash taugt nicht zum Prüfen und könnte Inhalte
      // verraten. Veröffentlicht wird nur der Pfad.
      path: f.path, localHash: f.status === 'extra' ? null : f.localHash, remoteHash: f.remoteHash, status: f.status,
    })),
  };
}

module.exports = { transparencyPage, transparencyJson, FINGERPRINT_COMMAND, CONTAINER_HASH_COMMAND };
