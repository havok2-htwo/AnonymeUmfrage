# Anonyme Umfrage

Ein kleines, selbst gehostetes Umfragetool für Mitarbeiterbefragungen. Eine Administratorin oder ein
Administrator legt im Adminbereich eine Umfrage an (beliebig viele Fragen in fester Reihenfolge; Freitext,
langer Freitext, Skala, Einfach- und Mehrfachauswahl), teilt einen Link, und alle können ohne Konto, ohne
Cookie und ohne Tracking anonym antworten. Nach dem Schließen gibt es eine Auswertung im Browser und als PDF.

Der Code ist öffentlich, damit alle selbst nachprüfen können, wie die Anonymität umgesetzt ist. Jede Seite
zeigt die Versionsnummer und ob der laufende Code mit dem veröffentlichten Git-Tag auf GitHub übereinstimmt.

- Verbindlicher Bauplan: [`docs/SPEC.md`](docs/SPEC.md)
- Erklärung für Teilnehmende: [`docs/ANONYMITAET.md`](docs/ANONYMITAET.md)
- Auf jeder Installation: Seite `/transparenz` (und `/transparenz.json`)

## Das Anonymitätsversprechen in Kürze

- Beim Absenden werden **keine** IP-Adresse, kein Browser, kein Cookie, kein Zeitpunkt und keine Kennung
  gespeichert oder protokolliert. Die Anwendung schreibt kein Access-Log.
- Jede einzelne Antwort ist eine eigene Datenbankzeile mit zufälliger ID. Es gibt nichts, was die Antworten
  einer Person auf verschiedene Fragen miteinander verbindet; nach jeder Teilnahme wird die Datenbankdatei
  neu geschrieben (`VACUUM`), damit auch die Speicherreihenfolge nichts verrät.
- Freitexte und Antworten werden in Auswertung und PDF bei jedem Abruf neu gemischt.
- Ergebnisse gibt es erst, wenn die Umfrage geschlossen ist und eine Mindestzahl an Teilnahmen erreicht ist
  (Standard 3). Schließen ist endgültig; Fragen sind nach dem Öffnen eingefroren.
- Keine Drittanbieter: keine CDN, keine externen Schriften, keine Analyse. Strenge Sicherheitsheader (CSP).

Die ehrlich benannten Grenzen (Schreibstil in Freitexten, Webserver-Logs davor, Prüfung durch den Server
selbst, keine Sperre gegen Mehrfachteilnahme) stehen in [`docs/ANONYMITAET.md`](docs/ANONYMITAET.md) und auf
`/transparenz`.

## Voraussetzungen

- Docker mit Compose **oder** Node.js ab 22.13 (empfohlen: 24)
- Ein Reverse-Proxy mit HTTPS davor (z. B. nginx), siehe unten

Einzige Laufzeitabhängigkeit ist `pdfkit`. Datenbank ist das eingebaute `node:sqlite`.

## Start mit Docker

Immer aus einem sauberen Checkout eines Release-Tags bauen. Das Image enthält genau die Dateien des
Repositorys; nur dann kann der Abgleich „Code identisch“ ergeben.

```sh
git clone https://github.com/havok2-htwo/AnonymeUmfrage && cd AnonymeUmfrage
git checkout v0.1.0

# Erster Admin (wird nur angelegt, wenn noch keiner existiert)
cat > .env <<'ENDE'
PUBLIC_URL=https://umfrage.example.org
ADMIN_USER=admin
ADMIN_PASSWORD=ein-langes-geheimes-passwort
ENDE

docker compose up -d --build
docker compose logs umfrage      # zeigt Version und Prüfstatus
```

Die Anwendung lauscht dann auf `127.0.0.1:3000`. Daten liegen im Docker-Volume `umfrage-daten` (`/data`).
Nach dem ersten Start `ADMIN_PASSWORD` aus der `.env` entfernen. Die `.env` gehört nicht ins Image
(`.dockerignore`) und nicht ins Repository (`.gitignore`).

## Start ohne Docker

```sh
git clone https://github.com/havok2-htwo/AnonymeUmfrage && cd AnonymeUmfrage
git checkout v0.1.0
npm ci --omit=dev

HOST=127.0.0.1 PUBLIC_URL=https://umfrage.example.org DATA_DIR=/var/lib/umfrage node src/server.js
```

Ohne `HOST=127.0.0.1` ist die Anwendung ohne HTTPS direkt im Netz erreichbar. Dann gehen Link und
Antworten unverschlüsselt durchs Netz, und der vorgeschaltete Webserver ohne Access-Log (siehe unten) lässt
sich umgehen.

Ohne `DATA_DIR` liegt die Datenbank unter `./data/umfrage.db`. Für den Dauerbetrieb einen Dienst
(z. B. systemd) einrichten, der `node src/server.js` als eigener Benutzer startet.

## Admin anlegen

**Auslieferungszustand:** Gibt es beim Start noch keinen Admin (und sind `ADMIN_USER`/`ADMIN_PASSWORD` nicht
gesetzt), legt der Server den Zugang **admin / admin** an. Bei der ersten Anmeldung muss das Passwort geändert
werden; bis dahin ist im Adminbereich nur die Seite „Passwort“ erreichbar. Deshalb direkt nach der Installation
anmelden und das Passwort ändern.

Später lässt sich das eigene Passwort jederzeit im Adminbereich unter „Passwort“ ändern.

Alternativ beim ersten Start über `ADMIN_USER` und `ADMIN_PASSWORD` (siehe oben) oder jederzeit per
Kommandozeile. Das Passwort wird ohne Echo abgefragt (oder aus `ADMIN_PASSWORD` gelesen), mindestens
10 Zeichen:

```sh
node src/cli.js create-admin <benutzername> [anzeigename]
node src/cli.js set-password <benutzername>
node src/cli.js rename-admin <alt> <neu> [anzeigename]

# im Container
docker compose exec umfrage node src/cli.js create-admin <benutzername>
```

Weitere Admins lassen sich danach im Adminbereich unter „Admins“ anlegen und löschen.

## Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Port |
| `HOST` | `0.0.0.0` | Adresse |
| `DATA_DIR` | `./data` | Ordner für `umfrage.db` (Docker: `/data`) |
| `PUBLIC_URL` | leer | Basis für angezeigte Links, z. B. `https://umfrage.example.org` |
| `COOKIE_SECURE` | `auto` | `true`/`false`/`auto` (auto: secure, wenn `PUBLIC_URL` mit https beginnt) |
| `TRUST_PROXY` | `false` | `X-Forwarded-Proto` beim Bauen von Links beachten (nie für IP-Adressen) |
| `REPO` | `havok2-htwo/AnonymeUmfrage` | GitHub-Repository für den Abgleich |
| `INTEGRITY_CHECK` | `on` | `off` schaltet den GitHub-Abgleich ab |
| `ADMIN_USER`, `ADMIN_PASSWORD` | leer | legt beim Start einen Admin an, falls noch keiner existiert (sonst admin/admin mit Pflicht zum Passwortwechsel) |
| `SESSION_HOURS` | `12` | Dauer einer Admin-Sitzung |

## nginx davor (mit HTTPS, ohne Access-Log)

Die Anwendung selbst speichert keine IP-Adressen. Ein vorgeschalteter Webserver tut das aber
standardmäßig. Für diese Anwendung muss das Access-Log deshalb abgeschaltet werden:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name umfrage.example.org;

    ssl_certificate     /etc/letsencrypt/live/umfrage.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/umfrage.example.org/privkey.pem;

    # Wichtig für die Anonymität: keine Zugriffsprotokolle mit IP-Adressen
    access_log off;
    # Fehlerlog nur für echte Fehler; es kann Client-Adressen enthalten
    error_log /var/log/nginx/umfrage-error.log crit;

    client_max_body_size 300k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Bewusst kein X-Forwarded-For / X-Real-IP: die Anwendung braucht keine IP-Adressen
    }
}

server {
    listen 80;
    server_name umfrage.example.org;
    access_log off;
    return 301 https://$host$request_uri;
}
```

HTTPS ist Pflicht: Ohne Verschlüsselung könnten Antworten unterwegs mitgelesen werden, und das
Admin-Sitzungscookie wäre nicht geschützt. Mit `PUBLIC_URL=https://…` wird das Cookie automatisch als
`Secure` gesetzt.

## Bedienung in Kürze

1. Unter `/admin` anmelden, „Neue Umfrage“ anlegen.
2. Titel, Einleitung, Danketext und Mindestzahl der Teilnahmen festlegen, Fragen hinzufügen und sortieren.
   Die Vorschau zeigt das Formular so, wie Teilnehmende es sehen.
3. „Öffnen“: Ab jetzt sind die Fragen eingefroren. Den angezeigten Link teilen.
4. Während die Umfrage läuft, sieht der Adminbereich nur die Zahl der Teilnahmen.
5. „Schließen“ (endgültig, optional automatisch zu einem Zeitpunkt). Danach gibt es die Auswertung und den
   PDF-Export. Wer weitermachen will, dupliziert die Umfrage.

## Release-Ablauf

Die Version in `package.json` und der Git-Tag `v<version>` gehören zusammen. Der Server vergleicht seinen
Code mit genau diesem Tag auf GitHub.

```sh
npm version 0.2.0 --no-git-tag-version   # Version in package.json und package-lock.json erhöhen
npm test
git commit -am "Version 0.2.0"
git tag v0.2.0
npm run release:check                    # sauberes Arbeitsverzeichnis, Tag passt zu Version und HEAD
git push && git push origin v0.2.0
npm run release:check -- --remote        # Tag liegt auch auf GitHub
```

Danach auf dem Server den neuen Tag auschecken und neu bauen (`git fetch --tags && git checkout v0.2.0 &&
docker compose up -d --build`). Die GitHub-Action prüft bei jedem Tag, dass er zur Version in
`package.json` passt, und gibt den Gesamt-Fingerabdruck aus.

## Selbst prüfen

Der Fuß jeder Seite zeigt „Version x.y.z“ und den Prüfstatus:

- **Code identisch mit GitHub-Version vX.Y.Z** – jede Datei stimmt mit dem Tag überein, keine zusätzlichen.
- **Code weicht von GitHub-Version vX.Y.Z ab** – `/transparenz` listet abweichende, fehlende und
  zusätzliche Dateien.
- **Code nicht geprüft: <Grund>** – z. B. GitHub nicht erreichbar oder Tag noch nicht veröffentlicht.

Die Prüfung macht der Server selbst. Wer ihr nicht trauen will, vergleicht unabhängig:

```sh
git clone https://github.com/havok2-htwo/AnonymeUmfrage && cd AnonymeUmfrage
git checkout v0.1.0
git ls-tree -r HEAD        # Hash jeder Datei, mit der Tabelle auf /transparenz vergleichen

# Gesamt-Fingerabdruck wie auf /transparenz
git -c core.quotePath=false ls-tree -r --format='%(path) %(objectname)' HEAD | LC_ALL=C sort | sha256sum

# Daten der laufenden Installation
curl -s https://umfrage.example.org/transparenz.json
```

Einzelne Dateien der laufenden Installation lassen sich direkt nachrechnen. Wichtig ist `--no-filters`:
Ohne diese Option normalisiert Git die Zeilenenden (`.gitattributes`) vor dem Hashen und meldet eine
abweichende Datei womöglich als gleich.

```sh
# auf dem Server im Anwendungsordner
git hash-object --no-filters src/server.js

# im Container (dort gibt es kein Git, nur busybox)
docker compose exec umfrage sh -c 'f=src/server.js; { printf "blob %d\0" "$(wc -c < "$f")"; cat "$f"; } | sha1sum'
```

Die Hashes sind Git-Blob-Hashes (`sha1("blob " + Länge + "\0" + Inhalt)`), genau wie bei Git und GitHub.
Am verlässlichsten ist es, wenn eine Vertrauensperson die Installation auf dem Server direkt ansieht
(zum Beispiel `git status` und `git describe --tags` im Anwendungsordner).

## Entwicklung

```sh
npm ci
npm test                    # node --test, inklusive HTTP-Ende-zu-Ende-Test
INTEGRITY_CHECK=off ADMIN_USER=admin ADMIN_PASSWORD=entwicklung-123 npm start
```

Alle Dateien sind UTF-8 mit LF-Zeilenenden (`.gitattributes`). Abweichende Zeilenenden ergeben andere
Hashes und damit den Status „weicht ab“.

## Lizenz

MIT, siehe [`LICENSE`](LICENSE). Schrift Montserrat unter der SIL Open Font License
([`assets/fonts/OFL.txt`](assets/fonts/OFL.txt)).
