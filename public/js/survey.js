// Komfort für Teilnehmende. Die Seite funktioniert vollständig ohne dieses Skript.
//
// - Hinweis „bereits teilgenommen“ (SPEC §3 Regel 10): Nach dem Absenden merkt sich nur dieser Browser
//   unter localStorage 'umfrage:done:<slug>' den Wert '1'. Dieser Wert wird nie gesendet.
// - Fortschritt „x von n Fragen beantwortet“ und Zeichenzähler für lange Texte.
// - Doppeltes Absenden verhindern.
// - Freiwillige Skalen und Einfachauswahl lassen sich wieder abwählen („Auswahl entfernen“), damit
//   eine Frage auch nach einem versehentlichen Klick unbeantwortet bleiben kann.
// - Nach dem Absenden das Formular leeren. Sonst zeigt „Zurück“ im Browser die eigenen Antworten wieder
//   an: Chrome und Edge legen die Seite trotz Cache-Control: no-store in den Back-Forward-Cache, und ohne
//   ihn stellt die Formular-Wiederherstellung die Werte wieder her. Geleert wird beim Verlassen nach dem
//   Absenden (pagehide), bei Rückkehr aus dem Cache (pageshow) und bei Zurück/Vor, wenn auf diesem Gerät
//   schon teilgenommen wurde und in diesem Tab kein neuer Durchgang („Trotzdem erneut ausfüllen“) läuft.
//   Halb ausgefüllte Formulare ohne Absenden bleiben unangetastet; dafür nimmt das Skript das
//   autocomplete="off" des Servers weg, solange auf dem Gerät noch nicht teilgenommen wurde.
(function () {
  'use strict';

  var submitted = false;

  function emit(el, type) {
    var ev;
    try {
      ev = new Event(type, { bubbles: true });
    } catch (e) {
      ev = document.createEvent('Event');
      ev.initEvent(type, true, false);
    }
    el.dispatchEvent(ev);
  }

  /** Alle Eingaben leeren, auch die Vorbelegung aus dem HTML (z. B. nach einer 422-Neuanzeige). */
  function clearForm(form) {
    var els = form.querySelectorAll('input, textarea');
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      if (el.type === 'radio' || el.type === 'checkbox') {
        el.checked = false;
        el.defaultChecked = false;
        emit(el, 'change');
      } else if (el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button') {
        el.value = '';
        el.defaultValue = '';
        emit(el, 'input');
      }
    }
  }

  function isBackForward() {
    try {
      var nav = window.performance && window.performance.getEntriesByType
        ? window.performance.getEntriesByType('navigation')[0] : null;
      if (nav && nav.type) return nav.type === 'back_forward';
      return Boolean(window.performance && window.performance.navigation && window.performance.navigation.type === 2);
    } catch (e) {
      return false;
    }
  }

  function key(slug) {
    return 'umfrage:done:' + slug;
  }

  function readDone(slug) {
    try {
      return window.localStorage.getItem(key(slug)) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeDone(slug) {
    try {
      window.localStorage.setItem(key(slug), '1');
    } catch (e) {
      // Speicher nicht verfügbar: dann eben ohne Hinweis.
    }
  }

  function isAnswered(fieldset) {
    var inputs = fieldset.querySelectorAll('input, textarea');
    for (var i = 0; i < inputs.length; i += 1) {
      var el = inputs[i];
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.checked) return true;
      } else if (String(el.value || '').trim() !== '') {
        return true;
      }
    }
    return false;
  }

  function initProgress(form) {
    var output = document.querySelector('[data-progress]');
    var questions = form.querySelectorAll('[data-question]');
    if (!output || questions.length === 0) return;
    var update = function () {
      var done = 0;
      for (var i = 0; i < questions.length; i += 1) if (isAnswered(questions[i])) done += 1;
      output.textContent = done + ' von ' + questions.length + ' Fragen beantwortet';
    };
    output.hidden = form.hidden;
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
  }

  function initCounters(form) {
    var counters = form.querySelectorAll('[data-count-for]');
    Array.prototype.forEach.call(counters, function (counter) {
      var field = document.getElementById(counter.getAttribute('data-count-for'));
      if (!field) return;
      var max = Number(field.getAttribute('data-count')) || 0;
      var update = function () {
        counter.textContent = field.value.length + ' / ' + max;
      };
      counter.hidden = false;
      field.addEventListener('input', update);
      update();
    });
  }

  function initClearButtons(form) {
    var groups = form.querySelectorAll('fieldset[data-question][data-required="0"]');
    Array.prototype.forEach.call(groups, function (fieldset) {
      var radios = fieldset.querySelectorAll('input[type="radio"]');
      if (radios.length === 0) return;
      var body = fieldset.querySelector('.question-body') || fieldset;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm choice-clear';
      button.textContent = 'Auswahl entfernen';
      var sync = function () {
        var any = false;
        for (var i = 0; i < radios.length; i += 1) if (radios[i].checked) any = true;
        button.hidden = !any;
      };
      button.addEventListener('click', function () {
        var focusTarget = radios[0];
        for (var i = 0; i < radios.length; i += 1) radios[i].checked = false;
        sync();
        var ev;
        try {
          ev = new Event('change', { bubbles: true });
        } catch (e) {
          ev = document.createEvent('Event');
          ev.initEvent('change', true, false);
        }
        focusTarget.dispatchEvent(ev);
        focusTarget.focus();
      });
      fieldset.addEventListener('change', sync);
      body.appendChild(button);
      sync();
    });
  }

  function initSubmit(form) {
    var button = form.querySelector('[data-submit]');
    var label = button ? button.textContent : '';
    form.addEventListener('submit', function () {
      submitted = true;
      if (!button) return;
      // Erst nach dem Absenden sperren, damit der Wert des Knopfes nicht fehlt.
      window.setTimeout(function () {
        button.disabled = true;
        button.textContent = 'Wird gesendet …';
      }, 0);
    });
    return function resetButton() {
      if (!button) return;
      button.disabled = false;
      button.textContent = label;
    };
  }

  function doneSlug() {
    var hint = document.getElementById('bereits-teilgenommen');
    return hint ? hint.getAttribute('data-done-slug') : '';
  }

  // „Trotzdem erneut ausfüllen“ gilt für diesen Tab (sessionStorage), damit ein zweiter, noch nicht
  // abgeschickter Durchgang beim Zurück nicht verloren geht. Wird beim Absenden entfernt.
  function retakeKey(slug) {
    return 'umfrage:retake:' + slug;
  }

  function readRetake(slug) {
    try {
      return window.sessionStorage.getItem(retakeKey(slug)) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeRetake(slug, on) {
    try {
      if (on) window.sessionStorage.setItem(retakeKey(slug), '1');
      else window.sessionStorage.removeItem(retakeKey(slug));
    } catch (e) {
      // ohne sessionStorage: dann eben ohne
    }
  }

  /** Muss das Formular geleert werden? Nach dem Absenden oder bei abgeschlossener Teilnahme ohne neuen Durchgang. */
  function shouldClear(slug) {
    return submitted || Boolean(slug && readDone(slug) && !readRetake(slug));
  }

  /** Anzeigen (Fortschritt, Zähler, „Auswahl entfernen“) nach einer Wiederherstellung durch den Browser neu berechnen. */
  function refresh(form) {
    var els = form.querySelectorAll('input, textarea');
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      emit(el, el.type === 'radio' || el.type === 'checkbox' ? 'change' : 'input');
    }
  }

  function showForm(form) {
    var hint = document.getElementById('bereits-teilgenommen');
    if (hint) hint.hidden = true;
    form.hidden = false;
    var progress = document.querySelector('[data-progress]');
    if (progress) progress.hidden = false;
  }

  function initDoneHint(form) {
    var hint = document.getElementById('bereits-teilgenommen');
    if (!hint) return;
    var slug = hint.getAttribute('data-done-slug');
    var retake = hint.querySelector('[data-retake]');
    if (retake && !retake.getAttribute('data-bound')) {
      retake.setAttribute('data-bound', '1');
      retake.addEventListener('click', function () {
        if (slug) writeRetake(slug, true);
        form.removeAttribute('autocomplete');
        showForm(form);
        var first = form.querySelector('input, textarea');
        if (first) first.focus();
      });
    }
    // Bei Validierungsfehlern (Fehlerliste vorhanden) den Hinweis nicht über das Formular legen.
    if (!slug || !readDone(slug) || document.getElementById('fehler')) return;
    if (readRetake(slug)) {
      showForm(form);
      return;
    }
    hint.hidden = false;
    form.hidden = true;
  }

  /** Abgeschickte Antworten nicht im Tab stehen lassen (siehe Kopfkommentar). */
  function initClearAfterSubmit(form, resetButton) {
    var slug = doneSlug();
    // autocomplete="off" kommt vom Server (Schutz ohne JavaScript). Solange hier noch nicht teilgenommen
    // wurde oder ein neuer Durchgang läuft, darf der Browser halb ausgefüllte Antworten beim Zurück
    // wiederherstellen; nach dem Absenden leert pagehide das Formular ohnehin.
    if (slug && (!readDone(slug) || readRetake(slug))) form.removeAttribute('autocomplete');
    form.addEventListener('submit', function () {
      if (slug) writeRetake(slug, false);
    });
    window.addEventListener('pagehide', function () {
      if (submitted) clearForm(form);
    });
    window.addEventListener('pageshow', function (event) {
      if (!event.persisted) return;
      if (shouldClear(slug)) clearForm(form);
      submitted = false;
      resetButton();
      initDoneHint(form);
      var progress = document.querySelector('[data-progress]');
      if (progress) progress.hidden = form.hidden;
      refresh(form);
    });
    var backForward = isBackForward();
    if (backForward && shouldClear(slug)) clearForm(form);
    // Die Formular-Wiederherstellung des Browsers läuft je nach Browser erst nach dem Parsen.
    window.addEventListener('load', function () {
      var after = function () {
        if (backForward && shouldClear(slug)) clearForm(form);
        else refresh(form);
      };
      after();
      window.setTimeout(after, 0);
    });
  }

  function init() {
    var done = document.getElementById('teilnahme-fertig');
    if (done) {
      var slug = done.getAttribute('data-done-slug');
      if (slug) writeDone(slug);
      return;
    }
    var form = document.getElementById('umfrage');
    if (!form) return;
    initDoneHint(form);
    initProgress(form);
    initCounters(form);
    initClearButtons(form);
    initClearAfterSubmit(form, initSubmit(form));
    var errors = document.getElementById('fehler');
    if (errors) errors.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
