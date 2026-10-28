(function () {
  'use strict';

  // Tabjes: één onderdeel tegelijk tonen. Het laatst gekozen tabje onthoudt de
  // browser (alleen voor het gemak, mag ook leeg zijn). Een rood bolletje op
  // Chat of Log betekent: daar is iets nieuws terwijl je ergens anders keek.
  var KEY = 'wj-minibia-tab';
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  if (!buttons.length) return;

  function panel(id) { return document.getElementById('tab-' + id); }
  function current() {
    var b = buttons.find(function (x) { return x.getAttribute('aria-selected') === 'true'; });
    return b ? b.dataset.tab : null;
  }

  function show(id, focus) {
    if (!panel(id)) id = buttons[0].dataset.tab;
    buttons.forEach(function (b) {
      var on = b.dataset.tab === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      var p = panel(b.dataset.tab);
      if (p) p.hidden = !on;
      if (on) {
        var dot = b.querySelector('.tab-dot');
        if (dot) dot.hidden = true;
        if (focus) b.focus();
      }
    });
    try { localStorage.setItem(KEY, id); } catch (e) { /* geen opslag: niet erg */ }
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  }

  buttons.forEach(function (b, i) {
    b.addEventListener('click', function () { show(b.dataset.tab); });
    // Pijltjestoetsen: naar het vorige of volgende tabje.
    b.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var n = (i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
      show(buttons[n].dataset.tab, true);
      e.preventDefault();
    });
  });

  // Bovenbalk is soms hoger (knoppen op twee regels): tabjes er netjes onder.
  var topbar = document.querySelector('.topbar');
  function placeTabs() {
    if (topbar) document.documentElement.style.setProperty('--tabs-top', topbar.offsetHeight + 'px');
  }
  window.addEventListener('resize', placeTabs);
  placeTabs();

  // Bolletje bij nieuwe chatberichten en bij meldingen in het log.
  function watch(listId, tabId, isNew) {
    var list = document.getElementById(listId);
    var btn = buttons.find(function (b) { return b.dataset.tab === tabId; });
    if (!list || !btn || typeof MutationObserver === 'undefined') return;
    var dot = btn.querySelector('.tab-dot');
    new MutationObserver(function (changes) {
      if (current() === tabId || !dot) return;
      var fresh = changes.some(function (c) {
        return Array.prototype.some.call(c.addedNodes, function (n) { return n.nodeType === 1 && isNew(n); });
      });
      if (fresh) dot.hidden = false;
    }).observe(list, { childList: true });
  }
  // Pas na het eerste laden kijken, anders staat het bolletje er meteen.
  setTimeout(function () {
    watch('chatList', 'chat', function () { return true; });
    watch('logList', 'log', function (n) { return n.classList.contains('is-alert') || n.classList.contains('is-alert-pause'); });
  }, 3000);

  var start = (location.hash || '').slice(1);
  if (!panel(start)) {
    try { start = localStorage.getItem(KEY) || ''; } catch (e) { start = ''; }
  }
  show(start || buttons[0].dataset.tab);
})();
