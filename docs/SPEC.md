# Anonyme Umfrage – Spezifikation

Diese Datei ist der verbindliche Bauplan. Sie ist öffentlich, damit alle nachvollziehen können, wie
die Anonymität technisch umgesetzt ist.

## 1. Ziel

Ein selbst gehostetes, webbasiertes Umfragetool:

- Eine Administratorin oder ein Administrator (namentlich angemeldet) legt Umfragen an: Titel, Einleitung,
  beliebig viele Fragen in fester Reihenfolge, verschiedene Fragetypen.
- Die Umfrage wird über einen geheimen Link geteilt. Wer den Link hat, kann anonym antworten – ohne Konto,
  ohne Cookie, ohne Tracking.
- Nach Abschluss der Umfrage gibt es im Adminbereich eine Auswertung und einen PDF-Export.
- Jede Seite zeigt die Versionsnummer. Beim Start prüft der Server, ob sein Code mit dem Git-Tag `v<Version>`
  auf GitHub identisch ist, und zeigt das Ergebnis an.

## 2. Technik

- Node.js ≥ 22.13 (Docker: `node:24-alpine`). CommonJS, keine Build-Stufe, kein Framework.
- HTTP: `node:http` mit eigenem, kleinem Router (`src/http/`).
- Datenbank: `node:sqlite` (`DatabaseSync`), Datei unter `DATA_DIR` (Standard `./data`, Docker `/data`).
- PDF: `pdfkit` (einzige Laufzeitabhängigkeit). Schrift Montserrat aus `assets/fonts/*.ttf`.
- HTML wird serverseitig gerendert (`src/views/`) mit einer Escape-Hilfsfunktion (`html` Tagged Template,
  `src/views/html.js`). Jede Ausgabe von Nutzerdaten wird escaped.
- Die Umfrageseite für Teilnehmende funktioniert **ohne JavaScript** (normales `<form method="post">`).
  JavaScript gibt es nur für Theme-Schalter, Komfortfunktionen und den Fragen-Editor im Adminbereich.
  Kein Inline-Script, kein Inline-Style-Attribut, das die CSP verletzt (CSP `style-src 'self'`).
- Tests: `node --test` (`test/`).
- Alle Dateien UTF-8, Zeilenende LF (`.gitattributes`: `* text=auto eol=lf`, Binärdateien `binary`).

### Verzeichnisse

```
src/
  server.js            Einstieg: Konfiguration laden, DB öffnen, Integritätsprüfung starten, HTTP starten
  config.js            Umgebungsvariablen (siehe 9.)
  db.js                Schema, Migration, Zugriffsfunktionen
  version.js           liest Version aus package.json
  integrity.js         Code-Fingerabdruck und GitHub-Abgleich
  auth.js              Passwort-Hashing (scrypt), Sitzungen, Login-Bremse
  surveys.js           Fachlogik Umfragen, Fragen, Antworten, Statuswechsel
  results.js           Auswertung (Statistik, Mischen)
  pdf.js               PDF-Export
  cli.js               Kommandozeile (Admin anlegen, Passwort setzen)
  http/                Router, Body-Parser, Sicherheitsheader, statische Dateien
  views/               HTML-Vorlagen (layout, survey, admin, transparency, errors)
public/
  css/app.css          Design-Tokens und Komponenten (SONS Intranet CI)
  js/theme.js          Theme-Schalter (localStorage)
  js/admin.js          Fragen-Editor, Kopieren-Knopf
  js/survey.js         optional: Fortschritt, Hinweis „bereits teilgenommen“
  fonts/               Montserrat woff2
  img/SonsLogo.webp
assets/fonts/          Montserrat ttf für PDF + OFL.txt
test/
docs/
```

## 3. Anonymität – die harten Regeln

Diese Regeln sind der Kern des Projekts. Jede Abweichung ist ein Fehler.

1. **Keine Personendaten bei Antworten.** Beim Absenden werden weder IP-Adresse, User-Agent, Cookies,
   Referrer, Zeitstempel noch irgendeine Kennung gespeichert oder geloggt. Der Server schreibt kein Access-Log.
   Fehlermeldungen beim Absenden enthalten keine Anfragedaten.
2. **Antworten werden pro Frage getrennt gespeichert.** Es gibt keine Tabelle „Teilnahme“ mit allen Antworten
   einer Person. Jede einzelne Antwort ist eine eigene Zeile in `answers` mit einer zufälligen ID
   (`crypto.randomUUID()`), in einer `WITHOUT ROWID`-Tabelle mit dieser ID als Primärschlüssel. Dadurch gibt es
   keine Einfügereihenfolge, über die sich die Antworten einer Person zu verschiedenen Fragen wieder
   zusammensetzen lassen. Es existiert keine Spalte, die Antworten derselben Person verbindet.
3. **Ausgabe immer gemischt.** Freitexte und Einzelantworten werden in Auswertung und PDF pro Frage zufällig
   gemischt (Fisher-Yates mit `crypto.randomInt`). Sortierung nach ID ist zwar schon zufällig, wird aber
   zusätzlich gemischt.
4. **Zähler statt Teilnahmeliste.** Pro Umfrage gibt es nur `response_count` (eine Zahl).
5. **Ergebnisse erst nach Abschluss.** Solange eine Umfrage offen ist, zeigt der Adminbereich keine Inhalte
   und auch nicht die Zahl der Teilnahmen (weder in der Übersicht noch in der Liste noch beim Löschen); eine
   laufend sichtbare Zahl verriete den Zeitpunkt jeder Teilnahme und wäre der Auslöser, um eine einzelne
   Teilnahme mit eigenen Teilnahmen zu isolieren. Auswertung und PDF gibt es erst, wenn die Umfrage
   geschlossen ist **und** mindestens `min_responses` Teilnahmen vorliegen (Standard 3, minimal 2, pro
   Umfrage einstellbar, nur im Entwurf änderbar). Ist `min_responses` keine ganze Zahl ab 2, bleibt die
   Auswertung gesperrt. Eine Teilnahme ohne eine einzige Antwort wird abgelehnt (`422`, „Bitte mindestens
   eine Frage beantworten.“) und nicht gezählt; sonst ließe sich die Mindestzahl mit leeren Teilnahmen
   erreichen und die übrigen Antworten wären einer Person zuzuordnen. Wird eine Umfrage mit weniger als
   `min_responses` Teilnahmen geschlossen (von Hand oder automatisch), werden ihre Antworten in derselben
   Aktion gelöscht; `response_count` bleibt erhalten. Der Start holt das für ältere Datenbanken nach.
6. **Schließen ist endgültig.** Eine geschlossene Umfrage kann nicht wieder geöffnet werden. Sonst könnte man
   nach dem Ansehen wieder öffnen, eine einzelne neue Antwort abwarten und sie durch Vergleich zuordnen. Wer
   weitermachen will, dupliziert die Umfrage.
7. **Fragen sind nach dem Öffnen eingefroren.** Struktur (Fragen, Typen, Optionen, Reihenfolge,
   Mindestanzahl) kann nur im Entwurf geändert werden.
8. **Keine Drittanbieter.** Keine CDN, keine Webfonts von Google, keine Analyse. Alles kommt vom eigenen
   Server. Sicherheitsheader:
   - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
     font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
   - `Referrer-Policy: same-origin` (fremde Seiten erfahren nichts; die eigene Seite braucht die Herkunft für die Prüfung von Formularen), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
     `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`,
     `Cross-Origin-Opener-Policy: same-origin`. Kein `X-Powered-By`, kein `Server`-Header mit Version.
   - Öffentliche Umfrageseiten: `Cache-Control: no-store`.
9. **Keine Cookies für Teilnehmende.** Cookies gibt es ausschließlich unter `/admin` (Sitzungscookie, Pfad
   `/admin`). Die öffentliche Seite setzt und liest keine Cookies.
10. **Hinweis „bereits teilgenommen“ nur lokal.** Nach dem Absenden merkt sich der Browser per `localStorage`
    (`umfrage:done:<slug>`), dass auf diesem Gerät teilgenommen wurde, und zeigt beim nächsten Aufruf einen
    Hinweis mit der Möglichkeit, trotzdem erneut zu antworten (geteilte Geräte). Die Anwendung sendet diese
    Information nie; sie bleibt im Browser. Ohne JavaScript gibt es den Hinweis nicht.
11. **Absenden ist atomar.** Alle Antworten einer Teilnahme und die Erhöhung des Zählers passieren in einer
    Transaktion. Bei einem Validierungsfehler wird nichts gespeichert, das Formular wird mit den eingegebenen
    Werten und Fehlermeldungen erneut angezeigt.
12. **Leere optionale Antworten** werden nicht gespeichert (sonst verrät die Zahl leerer Zeilen nichts, aber sie
    bringen auch nichts). Die Auswertung zeigt pro Frage „n von N Teilnahmen haben geantwortet“. Ist
    `0 < n < min_responses`, werden die Inhalte dieser Frage in Auswertung und PDF nicht gezeigt, nur
    „Zu wenige Antworten (n), zum Schutz der Anonymität ausgeblendet.“

13. **Keine Spuren in der Datenbankdatei.** SQLite legt Datensätze innerhalb einer Seite in Einfügereihenfolge ab;
    wer die Datei roh ausliest, könnte daraus Antworten derselben Teilnahme wieder zusammensetzen. Deshalb:
    `PRAGMA journal_mode = DELETE`, `PRAGMA secure_delete = ON`, und nach jeder Teilnahme `VACUUM`. `VACUUM`
    schreibt die Datenbank neu, Datensätze liegen danach nach ihrer zufälligen ID geordnet. Die Garantie gilt
    für eine einzelne Kopie der Datenbankdatei. Außerhalb liegen: (a) jeder Vergleich zweier Kopien, die
    während der Laufzeit einer Umfrage entstehen (Datensicherungen, Snapshots) – die Differenz enthält genau
    die Antwortzeilen der Teilnahmen dazwischen; (b) das Rollback-Journal: SQLite löscht es nach jeder
    Transaktion, überschreibt es aber nicht. Beim `VACUUM` enthält es die ganze Datei vor der Neuordnung,
    beim Löschen einer Umfrage deren Antworten; auf Blockebene lässt es sich unter Umständen wiederherstellen
    (die temporäre Datenbank des `VACUUM` bleibt dank `PRAGMA temp_store = MEMORY` im Arbeitsspeicher);
    (c) Kopien zwischen Einfügen und `VACUUM`. Das Fenster sind bei üblicher Größe Millisekunden, es wächst
    mit der Größe der Datenbank. Steht ein `VACUUM` aus, macht schon eine einzelne Kopie die Teilnahmen
    seit dem letzten erfolgreichen `VACUUM` verknüpfbar. Die README nennt die Betriebsregeln dazu
    („Datensicherung und Zugriff auf den Server“). Schlägt `VACUUM` fehl (z. B. `SQLITE_BUSY`,
    `SQLITE_FULL`), wird nur der Fehlercode auf stderr gemeldet (`[warnung] VACUUM fehlgeschlagen (…)`, keine
    Daten) und das `VACUUM` vorgemerkt. Nachgeholt wird bei der nächsten Teilnahme, beim Schließen (von Hand
    und automatisch), beim Start und im Minutentakt; die Übersicht einer geschlossenen Umfrage zeigt
    „Datenbank-Neuordnung ausstehend“ (ohne Bezug zu einer Teilnahme; bei offenen Umfragen gar nicht, weil das
    Erscheinen des Hinweises sonst den Zeitpunkt einer Teilnahme verriete).
14. **Umfrage-Code.** Die Teilnahmeseite (auch in der Vorschau), die Seite „Diese Umfrage ist abgeschlossen“ und
    die Admin-Übersicht zeigen einen Code aus 12 Zeichen (Crockford-Base32, 60 Bit aus
    `sha256("anonyme-umfrage:code:" + slug)`, Format `XXXX-XXXX-XXXX`) direkt unter dem Titel, vor dem
    Einleitungstext, mit der Aufforderung, ihn untereinander zu vergleichen. Bekommt jede Person einen eigenen
    Link, sehen alle verschiedene Codes. Der Code verrät den Slug nicht und lässt sich nicht wählen; 60 Bit,
    damit sich auch durch massenhaftes Anlegen kein Paar von Umfragen mit gleichem Code finden lässt.
15. **Formular nach dem Absenden leeren.** `public/js/survey.js` leert das Formular nach dem Absenden
    (`pagehide`), bei Rückkehr aus dem Back-Forward-Cache (`pageshow`) und bei Zurück/Vor, wenn auf dem Gerät
    schon teilgenommen wurde und im Tab kein neuer Durchgang („Trotzdem erneut ausfüllen“, `sessionStorage`
    `umfrage:retake:<slug>`) läuft. Der Server liefert das Formular mit `autocomplete="off"` (Schutz ohne
    JavaScript); das Skript entfernt das Attribut, solange auf dem Gerät noch nicht teilgenommen wurde oder ein
    neuer Durchgang läuft, damit halb ausgefüllte Antworten beim Zurück erhalten bleiben. Chrome und Edge legen
    die Seite trotz `Cache-Control: no-store` in den Back-Forward-Cache; ohne das Leeren zeigt „Zurück“ die
    eigenen Antworten. Ohne JavaScript bleibt das bei aktivem Back-Forward-Cache möglich.

Grenzen, die offen benannt werden (Transparenzseite und `docs/ANONYMITAET.md`):

- Wer den Server betreibt, dem muss man vertrauen: Wer ihn kontrolliert, kann die Anwendung absichtlich
  verändern und alles mitlesen.
- Wer den Link hat – auch wer die Umfrage verwaltet – kann selbst mehrfach teilnehmen. Mit so vielen eigenen Teilnahmen, dass
  zusammen mit einer echten die Mindestzahl erreicht ist, und sofortigem Schließen ergeben Auswertung minus
  eigene Antworten alle Antworten dieser einen Person, verknüpft über alle Fragen. Ohne Kennungen ist das
  nicht zu verhindern; die verborgene Zahl (Regel 5) nimmt nur den Auslöser.
- Ein eigener Link (eine eigene Umfrage) pro Person hebt die Anonymität auf. Erkennbar ist das am
  Umfrage-Code (Regel 14), wenn Teilnehmende ihn vergleichen. Zwei fast gleiche Umfragen an leicht
  verschiedene Gruppen lassen sich vergleichen und grenzen einzelne Antworten ein; das erkennt der Code nicht.
- Kopien der Datenbankdatei zu zwei Zeitpunkten und forensisch wiederhergestellte Journale (Regel 13).
- Freitexte können über Schreibstil oder Inhalt Rückschlüsse erlauben. Das kann keine Technik verhindern.
  Schreibhilfen von Browser, Erweiterungen oder Tastatur können Text an Dritte senden.
- Die Mindestzahl gilt pro Frage, nicht pro Option: Zählwerte von 1 oder einheitliche Antworten können in
  kleinen Gruppen Teilnahme oder Antworten einzelner verraten; wird eine Auswertung in einer sehr kleinen
  Gruppe geteilt, können Teilnehmende durch Abziehen der eigenen Antworten auf die anderen schließen.
- Spuren auf dem Gerät: Browserverlauf mit `/u/<slug>/danke`, der lokale Hinweis aus 10.
- Netzwerk: TLS-aufbrechende Proxys lesen mit; die Größe des Absende-Requests verrät die Länge von
  Freitexten; Antwortzeiten verraten, wann jemand teilnimmt.
- Ein vorgeschalteter Webserver (z. B. nginx) könnte IP-Adressen protokollieren. Die Installationsanleitung
  zeigt, wie man das für diese Anwendung abschaltet. Die Anwendung selbst kann das nicht prüfen.
- Die Integritätsprüfung wird vom Server selbst durchgeführt und deckt nur die Dateien des Repositorys ab
  (nicht `node_modules`, Node-Laufzeit, Container-Image, Startparameter). Sie schützt vor versehentlichen
  Abweichungen, ist aber kein Beweis gegen einen Betreiber, der absichtlich manipuliert. Auch `/transparenz`
  ist eine Selbstauskunft; eine echte Prüfung braucht Zugriff auf den Server (siehe 6.) oder eine
  Vertrauensperson.
- Mehrfachteilnahme wird nicht technisch verhindert (das ginge nur mit Kennungen). Der Hinweis in 10. ist eine
  Erinnerung, keine Sperre.

## 4. Datenmodell (SQLite)

```sql
PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- schema_version

CREATE TABLE admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- scrypt$N$r$p$salt_b64$hash_b64
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256 des Tokens, Token nur im Cookie
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL           -- Unix-Sekunden
);

CREATE TABLE surveys (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,            -- 22 Zeichen base64url aus 16 Zufallsbytes
  title TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  thanks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','open','closed')),
  min_responses INTEGER NOT NULL DEFAULT 3 CHECK (min_responses >= 2),
  closes_at INTEGER,                    -- optional, Unix-Sekunden, automatisches Schließen
  response_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,            -- 1, 2, 3 …
  type TEXT NOT NULL CHECK (type IN ('text','longtext','scale','single','multi')),
  title TEXT NOT NULL,
  help TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}'     -- JSON, siehe 5.
);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,                  -- randomUUID
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  value TEXT NOT NULL                   -- text: Text; scale: Zahl als Text; single: Option-ID; multi: eine Zeile pro gewählter Option
) WITHOUT ROWID;
CREATE INDEX answers_question ON answers(question_id);
```

Zeitstempel bei Umfragen (`opened_at`, `closed_at`) sind Verwaltungsdaten und haben keinen Bezug zu Antworten.
`answers` hat bewusst keinen Zeitstempel. Bei `multi` wird pro gewählter Option eine eigene Zeile gespeichert;
dass zwei Zeilen zur selben Person gehören, ist damit ebenfalls nicht mehr erkennbar. Für „n haben
geantwortet“ bei `multi` wird deshalb zusätzlich pro Teilnahme mit mindestens einer Auswahl eine Zeile mit
`value = ''` gespeichert (Marker), die in der Optionszählung ignoriert wird.

## 5. Fragetypen

| Typ | Darstellung | `config` | Validierung |
| --- | --- | --- | --- |
| `text` | einzeiliges Feld | `{ "maxLength": 500 }` | Länge ≤ maxLength (Standard 500) |
| `longtext` | mehrzeiliges Feld | `{ "maxLength": 5000 }` | Länge ≤ maxLength (Standard 5000) |
| `scale` | Reihe quadratischer Auswahlfelder (Radio) | `{ "min": 1, "max": 10, "minLabel": "", "maxLabel": "" }` | ganze Zahl in [min, max]; min ∈ [0,1], max ∈ [2,10], Standard 1–10 |
| `single` | Radio-Liste | `{ "options": [{ "id": "a1b2", "label": "…" }] }` | genau eine gültige Option-ID |
| `multi` | Checkbox-Liste | wie single, plus `"maxChoices": 0` (0 = beliebig) | nur gültige, eindeutige IDs, Anzahl ≤ maxChoices |

Option-IDs sind kurze Zufallswerte, damit Umbenennen im Entwurf möglich ist. Mindestens zwei Optionen, höchstens 30.
Freitexte werden getrimmt; Steuerzeichen außer Zeilenumbruch und Tab werden entfernt.

Die Reihenfolge der Fragen ist fest (1, 2, 3 …). Die Reihenfolge der Antwortoptionen wird für Teilnehmende
**nicht** gemischt (Skalen und Listen sollen stabil sein).

## 6. Version und Integritätsprüfung

- Die Version steht in `package.json` (`version`). Jede Seite zeigt im Fuß „Version x.y.z“, den Prüfstatus
  und einen Link zur Transparenzseite `/transparenz`.
- Ein Release ist der Git-Tag `v<version>` auf GitHub. `npm run release:check` (Skript `scripts/release-check.js`)
  prüft lokal, dass das Arbeitsverzeichnis sauber ist und Tag und Version zusammenpassen.
- **Fingerabdruck:** Beim Start berechnet der Server für jede Datei des Anwendungsverzeichnisses (rekursiv,
  ausgenommen nur auf oberster Ebene `node_modules/`, `.git/`, `data/` sowie `DATA_DIR`, falls innerhalb, und
  überall Umgebungsdateien `.env`/`.env.*`) den Git-Blob-Hash. Ein verschachteltes `node_modules` (z. B.
  `src/node_modules`) würde Node zuerst laden und zählt deshalb als zusätzliche Datei. Der Hash:
  `sha1("blob " + byteLength + "\0" + inhalt)`. Das ist genau der Hash, den Git und GitHub für die Datei
  verwenden.
- **Abgleich:** Der Server lädt `GET https://api.github.com/repos/<REPO>/git/trees/v<version>?recursive=1`
  (Standard-REPO `havok2-htwo/AnonymeUmfrage`, Timeout 10 s, Header `User-Agent: anonyme-umfrage`) und
  `GET https://api.github.com/repos/<REPO>/commits/v<version>` (Commit-Hash). Ergebnis:
  - `identical`: jede Datei des Tags ist lokal mit gleichem Hash vorhanden und es gibt lokal keine zusätzlichen
    Dateien.
  - `different`: Liste der abweichenden, fehlenden und zusätzlichen Dateien.
  - `unverified`: GitHub nicht erreichbar, Tag nicht vorhanden, Antwort abgeschnitten (`truncated`) oder
    Prüfung abgeschaltet (`INTEGRITY_CHECK=off`). Mit Grund.
- Der Abgleich läuft beim Start und danach alle 6 Stunden, das Ergebnis wird im Speicher gehalten. Der lokale
  Fingerabdruck wird nur beim Start berechnet (Code ändert sich zur Laufzeit nicht). Ein Gesamt-Fingerabdruck
  (sha256 über die sortierte Liste `pfad hash`) wird ebenfalls angezeigt.
- **Statusanzeige** (im Fuß jeder Seite, ausführlich auf `/transparenz`):
  - identical: Success-Farbe, „Code identisch mit GitHub-Version v1.0.0“
  - different: Strawberry, „Code weicht von GitHub-Version v1.0.0 ab“
  - unverified: Lemon, „Code nicht geprüft: <Grund>“
- `/transparenz` zeigt: Version, Commit-Hash des Tags (mit Link), Prüfzeitpunkt, Gesamt-Fingerabdruck, Tabelle
  aller Dateien mit Hash und Ergebnis, die Anonymitätsregeln aus 3. in Klartext und eine Anleitung zum
  Selbstprüfen:
  ```
  git clone https://github.com/havok2-htwo/AnonymeUmfrage && cd AnonymeUmfrage
  git checkout v1.0.0
  git ls-tree -r HEAD      # Hashes mit der Tabelle vergleichen
  ```
- Für zusätzliche Dateien (`extra`) werden nur Pfad und Status veröffentlicht, kein Hash (auf GitHub gibt es
  nichts zum Vergleichen, und der Hash könnte Inhalte verraten).
- Einzelne Dateien prüfen: `git hash-object --no-filters <datei>` (ohne `--no-filters` normalisiert Git die
  Zeilenenden). Im Container ohne Git:
  `sh -c 'f=src/server.js; { printf "blob %d\0" "$(wc -c < "$f")"; cat "$f"; } | sha1sum'`.
- `GET /transparenz.json` liefert dieselben Daten maschinenlesbar.
- Abhängigkeiten in `node_modules` werden über `package-lock.json` (Teil des Abgleichs) und `npm ci` mit
  Integritätsprüfung abgesichert. Das steht auf der Transparenzseite.

## 7. Oberflächen

### Öffentlich

- `GET /` – kurze Startseite: was das Tool ist, Link zur Transparenzseite, Link zum Adminbereich. Keine Liste
  von Umfragen.
- `GET /u/:slug` – Umfrage ausfüllen. Status `draft` → 404 (keine Bestätigung, dass es den Link gibt).
  `closed` → Seite „Diese Umfrage ist abgeschlossen“ (mit Umfrage-Code). Oben Titel, Umfrage-Code (§3 Regel 14),
  Einleitung, Anonymitätshinweis (kurz, mit Link zur Transparenzseite), dann alle Fragen nummeriert,
  Pflichtfragen markiert.
- `POST /u/:slug` – Antworten absenden. Formularfelder `q<questionId>` (bei multi mehrfach). Erfolgreich →
  `303` auf `/u/:slug/danke`. Validierungsfehler → `422` mit Formular und Fehlern.
  Kein CSRF-Token (keine Sitzung vorhanden, nichts zu schützen außer Spam). Body-Limit 256 KB.
- `GET /u/:slug/danke` – Dankeseite mit `thanks`-Text; setzt per JS den localStorage-Hinweis; Hinweis, auf
  geteilten Geräten den Tab zu schließen und dass Verlauf und Hinweis trotzdem bleiben.
- `GET /transparenz`, `GET /transparenz.json`.

### Admin (`/admin`)

- `GET/POST /admin/login`, `POST /admin/logout`.
- `GET /admin` – Liste der Umfragen (Titel, Status, Teilnahmen – bei offenen Umfragen „–“, siehe §3 Regel 5 –,
  erstellt von, Aktionen).
- `POST /admin/surveys` – neue Umfrage (Entwurf) → Editor.
- `GET /admin/surveys/:id` – Editor (Entwurf) bzw. Übersicht (offen/geschlossen) mit Link zum Kopieren und
  Umfrage-Code; Teilnahmen bei offenen Umfragen „–“.
- `POST /admin/surveys/:id` – Stammdaten speichern (Entwurf).
- `POST /admin/surveys/:id/questions` – Frage hinzufügen; `POST /admin/surveys/:id/questions/:qid` –
  bearbeiten; `.../delete`; `.../move` (`direction=up|down`).
- `POST /admin/surveys/:id/open` – öffnen (mindestens eine Frage nötig).
- `POST /admin/surveys/:id/close` – schließen (mit Bestätigung, Hinweis „endgültig“ und dass unter
  `min_responses` alle Antworten gelöscht werden).
- `POST /admin/surveys/:id/duplicate` – Kopie als Entwurf (neue Slug, keine Antworten).
- `POST /admin/surveys/:id/delete` – löschen (mit Bestätigung durch Eintippen des Titels oder „löschen“).
- `GET /admin/surveys/:id/preview` – Vorschau des Formulars (ohne Absenden).
- `GET /admin/surveys/:id/results` – Auswertung (nur closed und ≥ min_responses, sonst Erklärung).
- `GET /admin/surveys/:id/results.pdf` – PDF-Download, gleiche Bedingungen.
- `GET /admin/admins` – Admins verwalten (anlegen, löschen außer sich selbst), eigenes Passwort ändern.

Alle Admin-POSTs prüfen das CSRF-Token (verstecktes Feld `_csrf`, an die Sitzung gebunden) und den
`Origin`-Header, falls vorhanden. Der Editor funktioniert mit normalen Formularen; `admin.js` verbessert nur
(z. B. Optionen hinzufügen/entfernen, Typ-abhängige Felder ein-/ausblenden, Link kopieren).

### Auswertung

- Kopf: Titel, Zeitraum (geöffnet – geschlossen, nur Datum), Teilnahmen N, Version und Prüfstatus.
- Pro Frage (in Reihenfolge, nummeriert): Titel, „n von N haben geantwortet“. Bei `0 < n < min_responses`
  nur der Hinweis „Zu wenige Antworten (n), zum Schutz der Anonymität ausgeblendet.“ (§3 Regel 12).
  - scale: Durchschnitt (1 Nachkommastelle), Median, Verteilung als Balken je Wert (Anzahl und Prozent).
  - single/multi: Balken je Option mit Anzahl und Prozent (bezogen auf n), in Optionsreihenfolge.
  - text/longtext: alle Antworten gemischt, als Liste.
- Im HTML als CSS-Balken (Breite per Klassen in 5-%-Schritten oder `<meter>`/`<progress>`, wegen CSP kein
  Inline-Style), im PDF gezeichnet.

### PDF

- A4, Montserrat, Ränder 50 pt. Deckblatt-Kopf mit Logo-freiem Titelbereich (Logo nur, falls PNG/JPG verfügbar;
  webp kann pdfkit nicht – dann ohne Logo), Titel (900), Einleitungstext, Kennzahlen.
- Pro Frage Abschnitt wie oben, Balkendiagramme mit Mango, Text in Petrol auf Weiß (Druck).
- Freitexte gemischt, jede Antwort als Absatz mit dünner linker Linie. Seitenumbrüche sauber
  (Überschrift nie allein am Seitenende; ein Skalenblock samt Legende „1 = … · 10 = …“ bleibt zusammen).
- Fußzeile jeder Seite: „<Titel> · Seite x von y · Version 1.0.0 · Code identisch mit GitHub“ (bzw. Status).
- Dateiname `umfrage-<slug-des-titels>-ergebnis.pdf`.

## 8. Gestaltung (SONS Intranet CI)

Verbindlich, siehe Intranet-CI-Leitfaden. Kurzfassung:

- Montserrat (400 Fließtext, 600/700 Bedienelemente, 900 große Titel), lokal eingebunden.
- Dark Mode Standard, Light Mode per Schalter, Auswahl in `localStorage` (`theme`), vor dem ersten Rendern
  gesetzt (kleines externes Script im `<head>`, kein Flackern).
- Tokens als CSS-Variablen an einer Stelle (`:root` und `[data-theme="light"]`).
  Dark: Hintergrund `#0D2734`, tief `#06131B`, Verlauf `linear-gradient(180deg,#0D2734 0%,#06131B 100%)`,
  Text `#FFFFFF`, gedämpft `#8DA4B5`, Rahmen `#244150`, Panel `rgba(255,255,255,.04)`.
  Light: `#FFFFFF`, warm `#FFF7EB`, Verlauf `linear-gradient(180deg,#FFFFFF 0%,#FFF7EB 100%)`, Text `#0D2734`,
  gedämpft `#53646F`, Rahmen `#D7DDE3`, Panel `rgba(13,39,52,.045)`.
  Marke: Mango `#F79F3E` (primär, Fokus, Auswahl), Dragonfruit `#F257AC`, Verlauf Dragonfruit→Mango sparsam für
  primäre Aktionen, Lemon `#F9DC4A` Warnung, Strawberry `#F42C44` Fehler, Plum `#7340A9`, Success `#00D084`,
  Deep Petrol `#0D3E56` für Hover/aktive Flächen.
- Eckenradius überall 0. Keine Pillen, keine runden Knöpfe. Steuerhöhe 40 px.
- Keine Versalien (`text-transform: uppercase` verboten), korrekte Umlaute und ß.
- Topbar-Layout (kleines Werkzeug), responsiv, sichtbarer Tastaturfokus (Mango-Outline).
- Druckansicht (`@media print`) für die Auswertung: weiß, ohne Navigation.

## 9. Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` | SQLite-Datei `umfrage.db` |
| `PUBLIC_URL` | leer | Basis für angezeigte Links (sonst aus Host-Header) |
| `COOKIE_SECURE` | `auto` | `true`/`false`/`auto` (auto: secure, wenn `PUBLIC_URL` mit https beginnt) |
| `TRUST_PROXY` | `false` | nur für `X-Forwarded-Proto` beim Bauen von Links, nie für IPs |
| `REPO` | `havok2-htwo/AnonymeUmfrage` | GitHub-Repo für den Abgleich |
| `INTEGRITY_CHECK` | `on` | `off` schaltet den GitHub-Abgleich ab |
| `ADMIN_USER`, `ADMIN_PASSWORD` | leer | legt beim Start einen Admin an, falls noch keiner existiert (sonst admin/admin mit Pflicht zum Passwortwechsel) |
| `SESSION_HOURS` | `12` | |

## 10. Sicherheit Admin

- Passwörter: `crypto.scrypt`, N=2^15, r=8, p=1, 16 Byte Salt, 64 Byte Hash, Vergleich mit `timingSafeEqual`.
  Mindestlänge 10 Zeichen.
- Sitzung: 32 Zufallsbytes, Cookie `sid` (`HttpOnly; SameSite=Strict; Path=/admin; Secure` je nach Konfig).
  In der DB nur der sha256-Hash. Abgelaufene Sitzungen werden beim Start und stündlich gelöscht.
- Login-Bremse im Speicher: pro Benutzername nach 5 Fehlversuchen 15 Minuten Sperre; global höchstens 30
  Fehlversuche pro Minute. Keine IP-Speicherung. Ein Versuch wird vor der (asynchronen) Passwortprüfung
  reserviert und zählt bis zum Ergebnis mit, damit parallele Anfragen die Grenzen nicht umgehen. Laufen schon
  4 Prüfungen gleichzeitig, wird sofort mit `429` abgelehnt (ohne scrypt).
- Gleiche Fehlermeldung für unbekannten Benutzer und falsches Passwort.
- Auslieferungszustand: Gibt es keinen Admin und sind `ADMIN_USER`/`ADMIN_PASSWORD` nicht gesetzt, legt der
  Server `admin`/`admin` mit `must_change_password = 1` an (Schema 2). Solange das Flag gesetzt ist, leitet jede
  Admin-Route außer `/admin/passwort` und `/admin/logout` auf `/admin/passwort` um. „admin“ ist als neues
  Passwort verboten, das neue Passwort muss sich vom alten unterscheiden.
- Eigenes Passwort ändern: `GET/POST /admin/passwort` (Navigation „Passwort“).

## 11. Tests (Mindestumfang)

- Git-Blob-Hash stimmt mit `git hash-object` überein (bekannte Werte, z. B. leere Datei `e69de29b…`).
- Antworten werden ohne Verbindung gespeichert (Schema hat keine verbindende Spalte; `answers` ist WITHOUT ROWID).
- Validierung aller Fragetypen, Pflichtfragen, Atomarität bei Fehlern.
- Statuswechsel: Öffnen ohne Fragen verboten, Schließen endgültig, Bearbeiten nach Öffnen verboten.
- Ergebnisse gesperrt solange offen bzw. unter Mindestanzahl.
- HTTP-Ende-zu-Ende: Server auf freiem Port, Admin anlegen, einloggen, Umfrage bauen, öffnen, drei Teilnahmen,
  schließen, Auswertung und PDF (beginnt mit `%PDF`) abrufen. Prüfen, dass die öffentliche Seite keine
  `Set-Cookie`-Header sendet und die Sicherheitsheader stimmen.
- Escaping: Fragetitel mit `<script>` wird escaped ausgegeben.

## 12. Betrieb

- `Dockerfile` (node:24-alpine, `npm ci --omit=dev`, Nutzer `node`, `VOLUME /data`, `HEALTHCHECK` auf
  `/healthz`), `docker-compose.yml`, `.dockerignore` (nur `node_modules`, `.git`, `data`, `.env`, `.env.*`).
  Wichtig: Das Image enthält genau die Dateien des Repos, sonst schlägt der Abgleich fehl.
- `README.md`: Zweck, Anonymitätsversprechen kurz, Start mit Docker und ohne Docker (mit `HOST=127.0.0.1`
  hinter dem HTTPS-Proxy), Admin anlegen,
  nginx-Beispiel mit `access_log off;` und Hinweis auf HTTPS, Release-Ablauf (Version erhöhen, committen,
  `git tag vX.Y.Z`, pushen), Selbstprüfung.
- `GET /healthz` → `200 ok`.
- GitHub Actions `.github/workflows/ci.yml`: `npm ci`, `npm test`, und bei Tags: Tag == `v` + package.json-Version.
