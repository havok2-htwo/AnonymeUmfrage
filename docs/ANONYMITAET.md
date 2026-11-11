# Wie anonym ist die Umfrage?

Diese Seite erklärt in einfachen Worten, was mit deinen Antworten passiert. Sie richtet sich an alle, die an
einer Umfrage teilnehmen. Die technischen Details stehen in [`SPEC.md`](SPEC.md), Abschnitt 3, und auf der
Seite `/transparenz` jeder Installation.

## Kurz gesagt

Du bekommst einen Link, füllst das Formular aus und schickst es ab. Es gibt kein Konto, keine Anmeldung,
kein Cookie und kein Tracking. Gespeichert werden nur deine Antworten selbst, und zwar so, dass sie technisch weder dir noch
einander zugeordnet werden – auch nicht für die Person, die die Umfrage angelegt hat. Wo die Technik an
Grenzen stößt, steht unten unter „Ehrliche Grenzen“.

## Was gespeichert wird

- **Jede einzelne Antwort für sich.** Deine Antwort auf Frage 1 und deine Antwort auf Frage 2 landen als
  getrennte Einträge mit jeweils einer zufälligen Nummer in der Datenbank. Es gibt nichts, was sie
  miteinander verbindet: keine Teilnahme-Nummer, keinen Zeitstempel, keine Reihenfolge.
- **Eine Zahl:** wie viele Personen insgesamt teilgenommen haben.
- **Bei Mehrfachauswahl** wird jede angekreuzte Option als eigener Eintrag gespeichert, damit auch die
  Kombination deiner Kreuze nicht erkennbar ist.
- Leere freiwillige Antworten werden gar nicht gespeichert.

## Was nicht gespeichert wird

- keine IP-Adresse, kein Browser, kein Gerät, kein Betriebssystem
- kein Zeitpunkt des Absendens
- kein Cookie und keine Kennung; die Umfrageseite setzt und liest keine Cookies
- keine Protokolle über Seitenaufrufe (die Anwendung schreibt kein Access-Log)
- keine Daten an Dritte: keine Analyse-Dienste, keine externen Schriften oder Skripte

Dein Browser merkt sich nach dem Absenden nur lokal („auf diesem Gerät wurde schon teilgenommen“), damit
du nicht aus Versehen doppelt antwortest. Diese Information verlässt dein Gerät nie.

## Wie die Auswertung aussieht

- Ergebnisse gibt es erst, wenn die Umfrage **geschlossen** ist und eine **Mindestzahl** an Teilnahmen
  erreicht wurde (in der Regel 3). Solange die Umfrage läuft, sieht auch der Adminbereich nur die Anzahl.
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

## Woher weiß ich, dass das stimmt?

Der komplette Code ist öffentlich auf GitHub. Jede Seite der Umfrage zeigt unten die **Versionsnummer** und
ob der laufende Code **identisch** mit dieser Version auf GitHub ist. Auf der Seite `/transparenz` steht für
jede einzelne Datei ein Prüfwert (Hash), den jede und jeder mit `git` selbst nachrechnen kann. Wer
technisch fit ist oder jemanden kennt, kann also prüfen, dass genau der veröffentlichte Code läuft.

## Ehrliche Grenzen

Technik kann nicht alles verhindern. Das solltest du wissen:

- **Freitexte** können über Schreibstil, Inhalt oder Details Rückschlüsse erlauben. Wenn dir das wichtig
  ist, formuliere allgemein und nenne keine Einzelheiten, die nur du wissen kannst.
- **Kleine Gruppen:** Wenn nur sehr wenige Personen teilnehmen, lassen sich Antworten eher erraten, auch
  ohne Technik. Deshalb gibt es die Mindestzahl.
- **Der Webserver davor** (z. B. nginx) könnte IP-Adressen protokollieren. Die Anleitung zeigt, wie man das
  abschaltet; die Anwendung selbst kann das nicht überprüfen.
- **Die Prüfung „Code identisch“** macht der Server selbst. Sie schützt vor versehentlichen oder stillen
  Änderungen, ist aber kein Beweis gegen jemanden, der absichtlich manipuliert. Ganz sicher geht, wer die
  Installation von einer Vertrauensperson ansehen lässt.
- **Mehrfachteilnahme** wird nicht technisch verhindert, denn dafür bräuchte es Kennungen. Der Hinweis im
  Browser ist eine Erinnerung, keine Sperre.
- **Wer den Link hat – auch der Admin –** kann selbst mehrfach teilnehmen und so die Mindestzahl künstlich
  erreichen oder durch den Vergleich zweier Umfragen einzelne Antworten eingrenzen. Die Mindestzahl schützt
  nur, wenn die Teilnahmen echt sind.

## Fragen?

Wenn etwas unklar ist, frag bei der Person nach, die dir den Link geschickt hat, oder schau auf
`/transparenz` nach.
