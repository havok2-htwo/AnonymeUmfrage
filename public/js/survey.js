// Komfort für Teilnehmende. Die Seite funktioniert vollständig ohne dieses Skript.
//
// - Hinweis „bereits teilgenommen“ (SPEC §3 Regel 10): Nach dem Absenden merkt sich nur dieser Browser
//   unter localStorage 'umfrage:done:<slug>' den Wert '1'. Dieser Wert wird nie gesendet.
// - Fortschritt „x von n Fragen beantwortet“ und Zeichenzähler für lange Texte.
// - Doppeltes Absenden verhindern.
// - Freiwillige Skalen und Einfachauswahl lassen sich wieder abwählen („Auswahl entfernen“), damit
//   eine Frage auch nach einem versehentlichen Klick unbeantwortet bleiben kann.
(function () {
  'use strict';

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
    form.addEventListener('submit', function () {
      if (!button) return;
      // Erst nach dem Absenden sperren, damit der Wert des Knopfes nicht fehlt.
      window.setTimeout(function () {
        button.disabled = true;
        button.textContent = 'Wird gesendet …';
      }, 0);
    });
  }

  function initDoneHint(form) {
    var hint = document.getElementById('bereits-teilgenommen');
    if (!hint) return;
    var slug = hint.getAttribute('data-done-slug');
    // Bei Validierungsfehlern (Fehlerliste vorhanden) den Hinweis nicht über das Formular legen.
    if (!slug || !readDone(slug) || document.getElementById('fehler')) return;
    hint.hidden = false;
    form.hidden = true;
    var retake = hint.querySelector('[data-retake]');
    if (retake) {
      retake.addEventListener('click', function () {
        hint.hidden = true;
        form.hidden = false;
        var progress = document.querySelector('[data-progress]');
        if (progress) progress.hidden = false;
        var first = form.querySelector('input, textarea');
        if (first) first.focus();
      });
    }
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
    initSubmit(form);
    var errors = document.getElementById('fehler');
    if (errors) errors.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
