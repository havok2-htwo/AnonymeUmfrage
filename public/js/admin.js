// Verbesserungen im Adminbereich. Alles funktioniert auch ohne dieses Skript mit normalen Formularen.
//
// - Link kopieren (Knopf erscheint nur mit JavaScript; ohne JS bleibt das schreibgeschützte Feld).
// - Fragenformular: typabhängige Felder ein-/ausblenden.
// - Optionen als Liste mit „hinzufügen/entfernen/verschieben“; geschrieben wird weiterhin in das
//   Textfeld „eine Option pro Zeile“, das der Server auswertet.
// - Rückfragen vor dem Löschen (data-confirm) und Löschknopf erst bei passender Eingabe aktiv.
(function () {
  'use strict';

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  // --- Link kopieren --------------------------------------------------------------------------
  function initCopy() {
    each(document.querySelectorAll('[data-copy]'), function (button) {
      var input = document.getElementById(button.getAttribute('data-copy'));
      if (!input) return;
      var label = button.textContent;
      button.hidden = false;
      var done = function (ok) {
        button.textContent = ok ? 'Kopiert' : 'Bitte markieren und kopieren';
        button.classList.toggle('is-copied', ok);
        window.setTimeout(function () {
          button.textContent = label;
          button.classList.remove('is-copied');
        }, 2000);
      };
      var fallback = function () {
        input.focus();
        input.select();
        var ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (e) {
          ok = false;
        }
        done(ok);
      };
      button.addEventListener('click', function () {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(input.value).then(function () { done(true); }, fallback);
        } else {
          fallback();
        }
      });
      input.addEventListener('focus', function () { input.select(); });
    });
  }

  // --- Typabhängige Felder ----------------------------------------------------------------------
  function initTypeFields(form) {
    var select = form.querySelector('select[name="type"]');
    if (!select) return;
    var groups = form.querySelectorAll('[data-types]');
    var update = function () {
      var type = select.value;
      each(groups, function (group) {
        var types = group.getAttribute('data-types').split(' ');
        group.hidden = types.indexOf(type) === -1;
      });
    };
    select.addEventListener('change', update);
    update();
  }

  // --- Optionsliste -----------------------------------------------------------------------------
  function button(text, cls, aria) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-sm ' + (cls || '');
    b.textContent = text;
    if (aria) b.setAttribute('aria-label', aria);
    return b;
  }

  function initOptions(editor) {
    var source = editor.querySelector('[data-options-source]');
    var list = editor.querySelector('[data-options-list]');
    if (!source || !list) return;
    var labelText = editor.querySelector('label');

    var sync = function () {
      var values = [];
      each(list.querySelectorAll('input'), function (input) {
        var v = input.value.replace(/[\r\n]+/g, ' ').trim();
        if (v) values.push(v);
      });
      source.value = values.join('\n');
    };

    var renumber = function () {
      each(list.querySelectorAll('.option-row'), function (row, i) {
        var input = row.querySelector('input');
        input.setAttribute('aria-label', 'Option ' + (i + 1));
        row.querySelector('[data-up]').disabled = i === 0;
        row.querySelector('[data-down]').disabled = row.nextElementSibling === null || !row.nextElementSibling.classList.contains('option-row');
      });
    };

    var addRow = function (value, focus) {
      var row = document.createElement('div');
      row.className = 'option-row';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'input';
      input.maxLength = 200;
      input.value = value || '';
      var up = button('↑', '', 'Nach oben');
      up.setAttribute('data-up', '');
      var down = button('↓', '', 'Nach unten');
      down.setAttribute('data-down', '');
      var remove = button('Entfernen', '', 'Option entfernen');
      row.appendChild(input);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(remove);
      list.insertBefore(row, addButton);
      input.addEventListener('input', sync);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addRow('', true);
        }
      });
      up.addEventListener('click', function () {
        var prev = row.previousElementSibling;
        if (prev) list.insertBefore(row, prev);
        renumber();
        sync();
        up.focus();
      });
      down.addEventListener('click', function () {
        var next = row.nextElementSibling;
        if (next && next.classList.contains('option-row')) list.insertBefore(next, row);
        renumber();
        sync();
        down.focus();
      });
      remove.addEventListener('click', function () {
        var neighbour = row.nextElementSibling;
        row.parentNode.removeChild(row);
        renumber();
        sync();
        var target = neighbour && neighbour.querySelector('input');
        (target || addButton).focus();
      });
      renumber();
      if (focus) input.focus();
      return row;
    };

    var addButton = button('Option hinzufügen', 'options-add');
    addButton.classList.remove('btn-ghost');
    addButton.classList.add('btn-secondary');
    list.appendChild(addButton);
    addButton.addEventListener('click', function () { addRow('', true); });

    var initial = source.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (initial.length === 0) initial = ['', ''];
    initial.forEach(function (v) { addRow(v, false); });

    source.hidden = true;
    list.hidden = false;
    if (labelText) labelText.removeAttribute('for');
    var form = editor.closest('form');
    if (form) form.addEventListener('submit', sync);
  }

  // --- Rückfragen -------------------------------------------------------------------------------
  function initConfirm() {
    each(document.querySelectorAll('form[data-confirm]'), function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    });
    each(document.querySelectorAll('[data-delete-form]'), function (form) {
      var input = form.querySelector('[data-expected]');
      var submit = form.querySelector('[data-delete-button]');
      if (!input || !submit) return;
      var expected = input.getAttribute('data-expected').trim();
      var update = function () {
        var v = input.value.trim();
        var ok = v !== '' && (v === expected || v.toLocaleLowerCase('de-DE') === 'löschen');
        submit.disabled = !ok;
      };
      input.addEventListener('input', update);
      update();
    });
  }

  function init() {
    initCopy();
    each(document.querySelectorAll('[data-question-form]'), initTypeFields);
    each(document.querySelectorAll('[data-options-editor]'), initOptions);
    initConfirm();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
