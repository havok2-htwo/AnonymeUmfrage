// Theme-Schalter: wird im <head> geladen und setzt data-theme vor dem ersten Rendern.
// Gespeichert wird nur 'light' oder 'dark' im localStorage dieses Browsers (Schlüssel 'theme').
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  function readTheme() {
    try {
      var value = window.localStorage.getItem('theme');
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) {
      return null;
    }
  }

  function writeTheme(value) {
    try {
      window.localStorage.setItem('theme', value);
    } catch (e) {
      // Speicher nicht verfügbar (privater Modus o. Ä.): Auswahl gilt nur für diese Seite.
    }
  }

  function apply(value) {
    root.setAttribute('data-theme', value === 'light' ? 'light' : 'dark');
  }

  apply(readTheme() || 'dark');

  function bind() {
    var button = document.getElementById('theme-toggle');
    if (!button) return;
    var update = function () {
      var light = root.getAttribute('data-theme') === 'light';
      // Kein aria-pressed: Die Beschriftung sagt, was ein Klick bewirkt (der statische Text im HTML
      // bleibt die Fassung ohne JavaScript).
      var text = light ? 'Dunkelmodus einschalten' : 'Hellmodus einschalten';
      button.setAttribute('aria-label', text);
      button.setAttribute('title', text);
    };
    update();
    button.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      apply(next);
      writeTheme(next);
      update();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
