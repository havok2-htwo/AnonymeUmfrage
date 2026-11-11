# Wie anonym ist die Umfrage?

Diese Seite erklärt in einfachen Worten, was mit deinen Antworten passiert. Sie richtet sich an alle, die an
einer Umfrage teilnehmen. Die technischen Details stehen in [`SPEC.md`](SPEC.md), Abschnitt 3, und auf der
Seite `/transparenz` jeder Installation.

## Kurz gesagt

Du bekommst einen Link, füllst das Formular aus und schickst es ab. Es gibt kein Konto, keine Anmeldung,
kein Cookie und kein Tracking. Gespeichert werden nur deine Antworten selbst, und zwar so, dass sie in der
Datenbank weder dir noch einander zugeordnet sind. Das gilt auch gegenüber der Person, die die Umfrage
angelegt hat – solange sie die Umfrage ehrlich betreibt und niemand Kopien der Datenbank vergleicht. Was
die Technik nicht verhindern kann, steht unten unter „Ehrliche Grenzen“. Lies den Abschnitt, bevor du
etwas sehr Persönliches schreibst.

## Was gespeichert wird

- **Jede einzelne Antwort für sich.** Deine Antwort auf Frage 1 und deine Antwort auf Frage 2 landen als
  getrennte Einträge mit jeweils einer zufälligen Nummer in der Datenbank. In der Datenbank gibt es nichts,
  was sie miteinander verbindet: keine Teilnahme-Nummer, keinen Zeitstempel, keine Reihenfolge. (Eine
  Ausnahme steht unter „Ehrliche Grenzen“: Kopien der Datenbank.)
- **Eine Zahl:** wie viele Personen insgesamt teilgenommen haben. Sie wird erst nach dem Schließen
  angezeigt und bleibt auch dann erhalten, wenn die Antworten gelöscht werden.
- **Bei Mehrfachauswahl** wird jede angekreuzte Option als eigener Eintrag gespeichert. Die Kombination
  deiner Kreuze steht also nirgends. In sehr kleinen Gruppen lässt sie sich aber aus den Zahlen der
  Auswertung ableiten (siehe „Kleine Gruppen und eindeutige Antworten“ unter „Ehrliche Grenzen“).
- Leere freiwillige Antworten werden gar nicht gespeichert.

## Was nicht gespeichert wird

- keine IP-Adresse, kein Browser, kein Gerät, kein Betriebssystem
- kein Zeitpunkt des Absendens
- kein Cookie und keine Kennung; die Umfrageseite setzt und liest keine Cookies
- keine Protokolle über Seitenaufrufe (die Anwendung schreibt kein Access-Log)
- keine Daten an Dritte: keine Analyse-Dienste, keine externen Schriften oder Skripte

Dein Browser merkt sich nach dem Absenden nur lokal („auf diesem Gerät wurde schon teilgenommen“), damit
du nicht aus Versehen doppelt antwortest. Die Anwendung sendet diese Information nie. Wer an dein Gerät
kommt, kann sie aber sehen (siehe „Spuren auf deinem Gerät“).

## Wie die Auswertung aussieht

- Ergebnisse gibt es erst, wenn die Umfrage **geschlossen** ist und eine **Mindestzahl** an Teilnahmen
  erreicht wurde (in der Regel 3). Solange die Umfrage läuft, sieht auch der Adminbereich keine Inhalte und
  nicht einmal die Zahl der Teilnahmen. Eine laufend sichtbare Zahl würde verraten, wann jemand
  teilgenommen hat.
- Wird die Mindestzahl nicht erreicht, werden beim Schließen alle Antworten **gelöscht**. Sie könnten ohnehin
  nie ausgewertet werden.
- Ein komplett leeres Formular wird nicht angenommen und nicht gezählt. Sonst könnte man die Mindestzahl
  mit leeren Teilnahmen erreichen.
- Haben weniger Personen eine einzelne Frage beantwortet als die Mindestzahl, wird diese Frage in der
  Auswertung und im PDF **ausgeblendet** („Zu wenige Antworten, zum Schutz der Anonymität ausgeblendet“).
- Eine geschlossene Umfrage kann **nicht wieder geöffnet** werden. So kann niemand nach dem Ansehen auf
  eine einzelne neue Antwort warten und sie durch Vergleich zuordnen.
- Fragen können nach dem Öffnen nicht mehr geändert werden.
- Freitexte und Antworten werden in der Auswertung und im PDF bei jedem Abruf **neu gemischt**. Die
  Reihenfolge sagt also nichts darüber, wer wann geantwortet hat.
- Skalen werden als Durchschnitt, Median und Verteilung gezeigt, Auswahlfragen als Anzahl je Option.

## Der Umfrage-Code

Direkt unter dem Titel der Umfrageseite steht ein **Umfrage-Code**, zum Beispiel `7K3M-Q9TD-4WXA`. Alle, die
zur selben Umfrage eingeladen sind, sehen denselben Code. **Vergleicht ihn untereinander** – nicht nur mit
dem Code in der Einladung, denn der könnte ebenfalls persönlich sein. Sieht jemand einen anderen Code, hat
diese Person einen eigenen Link bekommen. Dann weiß, wer die Umfrage verwaltet, ob genau diese Person
teilgenommen hat, und kann ihre Antworten lesen. Der Code wird aus dem Link berechnet; die Person, die die
Umfrage anlegt, kann ihn nicht wählen. Ein Code, der im Einleitungstext steht, zählt nicht.

## Woher weiß ich, dass das stimmt?

Der komplette Code ist öffentlich auf GitHub. Jede Seite der Umfrage zeigt unten die **Versionsnummer** und
ob der laufende Code laut eigener Prüfung **identisch** mit dieser Version auf GitHub ist. Die Seite
`/transparenz` zeigt für jede Datei einen Prüfwert (Hash), der sich mit `git` nachrechnen lässt.

Wichtig: Diese Angaben macht der Server über sich selbst. Wer nur die Seite mit GitHub vergleicht, prüft
also nur, was der Server behauptet. Ob wirklich genau der veröffentlichte Code läuft, kann nur jemand
nachsehen, der Zugriff auf den Server hat. Am besten lässt man die Installation von einer Vertrauensperson
ansehen.

## Ehrliche Grenzen

Technik kann nicht alles verhindern. Das solltest du wissen:

- **Wer den Server betreibt, dem musst du vertrauen.** Wer den Server kontrolliert, kann die Anwendung
  absichtlich verändern und dann alles mitlesen, auch IP-Adressen. Die Prüfung „Code identisch“ hilft gegen
  Versehen, nicht gegen Absicht. Gut ist, wenn Betrieb und Umfrage bei verschiedenen Personen liegen oder
  eine Vertrauensperson die Installation ansieht.
- **Zusätzliche Teilnahmen durch die Person, die die Umfrage verwaltet.** Wer die Umfrage verwaltet, kann selbst mehrfach über den Link
  teilnehmen. Wer so oft teilnimmt, dass zusammen mit **einer** echten Teilnahme die Mindestzahl erreicht
  ist, und dann schließt, kann die eigenen Antworten von der Auswertung abziehen und **alle Antworten
  dieser einen Person** lesen. Die Software kann eigene und echte Teilnahmen nicht unterscheiden, ohne
  Kennungen zu speichern. Dass der Adminbereich die Zahl der Teilnahmen bis zum Schließen nicht zeigt, macht
  diesen Angriff schwerer, aber nicht unmöglich.
- **Eigener Link pro Person.** Bekommt jede Person einen eigenen Link (eine eigene, gleich aussehende
  Umfrage), ist die Umfrage für sie nicht anonym. Daran erkennst du es: Der **Umfrage-Code** ist bei euch
  verschieden. Am sichersten wird der Link über einen Weg verteilt, den alle sehen, zum Beispiel per
  Gruppenmail, im Teamchat oder per Aushang. Der Code hilft nicht, wenn zwei fast gleiche Umfragen an fast
  dieselbe Gruppe gehen, zum Beispiel einmal an alle und einmal an alle außer dir: Der Vergleich der beiden
  Auswertungen zeigt dann deine Antworten. Wirst du kurz nacheinander zu zwei fast gleichen Umfragen
  eingeladen, frag nach.
- **Kopien der Datenbank.** Deine Antworten liegen auf dem Server in einer Datei. Wer diese Datei zu zwei
  verschiedenen Zeitpunkten in die Hände bekommt – zum Beispiel über Datensicherungen oder Snapshots des
  Servers –, kann durch Vergleich sehen, welche Antworten in der Zeit dazwischen dazugekommen sind. Hat in
  dieser Zeit nur eine Person teilgenommen, gehören diese Antworten zusammen, und man weiß ungefähr, wann
  sie abgeschickt wurden. Wer die Datei lesen kann, sieht die Antworten außerdem schon, bevor die Umfrage
  geschlossen ist. Gelöschte Hilfsdateien der Datenbank lassen sich mit forensischen Mitteln unter Umständen
  wiederherstellen. Das betrifft nur Personen mit Zugriff auf den Server oder seine Sicherungen, nicht den
  normalen Adminbereich. Frag im Zweifel nach, wer das ist und wie gesichert wird.
- **Freitexte** können über Schreibstil, Inhalt oder Details Rückschlüsse erlauben. Wenn dir das wichtig
  ist, formuliere allgemein und nenne keine Einzelheiten, die nur du wissen kannst. Schreibhilfen deines
  Browsers, Erweiterungen oder deiner Tastatur können eingegebenen Text an deren Anbieter senden; das kann
  die Umfrage nicht verhindern.
- **Kleine Gruppen und eindeutige Antworten:** Die Mindestzahl gilt pro Frage, nicht pro Option. Die
  Auswertung zeigt bei jeder Frage, wie viele Personen jede Option gewählt haben, auch wenn es nur eine ist.
  Passt eine Option nur auf eine bestimmte Person (zum Beispiel „Geschäftsführung“), zeigt die Zahl 1, dass
  diese Person teilgenommen hat. Haben alle dasselbe geantwortet, kennt man die Antwort jeder Person, von der
  man weiß, dass sie teilgenommen hat. Wird die Auswertung in einer sehr kleinen Gruppe geteilt, können
  Teilnehmende durch Abziehen der eigenen Antworten auf die der anderen schließen.
- **Spuren auf deinem Gerät:** Dein Browserverlauf (und ein synchronisiertes Browserkonto) zeigt, dass und
  wann du die Danke-Seite aufgerufen hast. Dazu kommt der lokale Hinweis „schon teilgenommen“. Nach dem
  Absenden leert die Seite das Formular, damit „Zurück“ deine Antworten nicht wieder zeigt; ohne JavaScript
  klappt das nicht in jedem Browser. Auf Dienstgeräten oder geteilten Geräten nutze ein privates Fenster
  und schließe es danach.
- **Das Netzwerk zwischen dir und dem Server:** Ein Firmen-Proxy, der verschlüsselte Verbindungen aufbricht,
  kann deine Antworten lesen. Wer nur die Menge der übertragenen Daten protokolliert, kann daraus die Länge
  langer Freitexte ablesen. Wer den Server dauernd abfragt, kann an den Antwortzeiten erkennen, wann jemand
  teilnimmt (nicht was).
- **Der Webserver davor** (z. B. nginx) könnte IP-Adressen protokollieren. Die Anleitung zeigt, wie man das
  abschaltet; die Anwendung selbst kann das nicht überprüfen.
- **Mehrfachteilnahme** wird nicht technisch verhindert, denn dafür bräuchte es Kennungen. Der Hinweis im
  Browser ist eine Erinnerung, keine Sperre.

## Fragen?

Wenn etwas unklar ist, frag bei der Person nach, die dir den Link geschickt hat, oder schau auf
`/transparenz` nach.
