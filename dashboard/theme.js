// Thema-knop: wisselt tussen licht en donker en onthoudt de keuze.
(function () {
  'use strict';

  var SLEUTEL = 'wj-theme';
  var knop = document.getElementById('btnTheme');
  var systeem = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  // Opgeslagen keuze lezen (kan falen in privémodus)
  function lees() {
    try {
      var v = localStorage.getItem(SLEUTEL);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) { return null; }
  }

  function bewaar(waarde) {
    try { localStorage.setItem(SLEUTEL, waarde); } catch (e) { /* negeren */ }
  }

  // Welk thema is nu actief?
  function actief() {
    return document.documentElement.dataset.theme || (systeem && systeem.matches ? 'dark' : 'light');
  }

  // Knoptekst en aria-pressed bijwerken
  function toonKnop() {
    if (!knop) return;
    var donker = actief() === 'dark';
    knop.textContent = donker ? 'Licht' : 'Donker';
    knop.setAttribute('aria-pressed', donker ? 'true' : 'false');
  }

  function zet(thema) {
    document.documentElement.dataset.theme = thema;
    toonKnop();
  }

  // Bij laden: opgeslagen keuze, anders het systeem volgen
  var opgeslagen = lees();
  if (opgeslagen) document.documentElement.dataset.theme = opgeslagen;
  toonKnop();

  if (knop) {
    knop.addEventListener('click', function () {
      var nieuw = actief() === 'dark' ? 'light' : 'dark';
      zet(nieuw);
      bewaar(nieuw);
    });
  }

  // Zonder eigen keuze meebewegen met het systeem
  if (systeem && systeem.addEventListener) {
    systeem.addEventListener('change', function () {
      if (!lees()) toonKnop();
    });
  }
})();
