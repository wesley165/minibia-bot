(function (B) {
  'use strict';

  // Bags open houden: ligt er in je backpack nog een bag of backpack die dicht
  // is, dan opent de bot hem. Zo kan automove een nieuwe life ring omdoen en
  // telt de voorraad (status.supplies) ook wat in die bag zit.
  // Draait altijd zolang het spel open is, ook als de bot gestopt is.
  if (B.bags) return;

  var CHECK_MS = 5000;
  var WAIT_MS = 3000;        // na een klik even wachten op het spel
  var MAX_TRIES = 3;         // per bag-vak, daarna een tijd met rust laten
  var RETRY_AFTER_MS = 600000;
  var waitUntil = 0;
  var tries = {};            // vak -> { n, since }

  function g() { return window.gameClient; }
  function me() { return g() && g().player; }
  function name(item) {
    try { return String(((g().itemDefinitions[g().sidByCid[item.id]] || {}).properties || {}).name || '').toLowerCase(); } catch (e) { return ''; }
  }
  function isBag(item) { return /(^|\s)(bag|backpack)$/.test(name(item)); }

  function check() {
    try {
      var now = Date.now();
      if (now < waitUntil) return;
      if (!B.api || !B.api.ready() || typeof ItemUsePacket === 'undefined') return;
      // Tijdens het refillen niets doen: het depot opent en sluit zelf vensters.
      if (B.depot && B.depot.isBusy && B.depot.isBusy()) return;
      if (B.api.depotTarget && B.api.depotTarget()) return;
      var p = me();
      if (!p || p.isDead || !p.__openedContainers) return;

      var opened = Array.from(p.__openedContainers);
      // De backpack die je draagt: heet soms "Main Backpack", soms gewoon
      // "backpack" met parent 0 (geopend vanuit je uitrusting).
      var main = opened.find(function (c) { return c && c.__title === 'Main Backpack'; }) ||
        opened.find(function (c) { return c && c.__parentCid === 0; });
      if (!main || typeof main.getSlotItem !== 'function') return;

      var bagSlots = [];
      for (var s = 0; s < (main.size || 0); s++) {
        var it = main.getSlotItem(s);
        if (it && isBag(it)) bagSlots.push(s);
      }
      if (!bagSlots.length) return;
      // Open bags tellen. Het spel geeft een geopende bag ook parent 0, dus we
      // kijken naar de naam van het venster (bag/backpack), niet naar de parent.
      var openChildren = opened.filter(function (c) {
        return c && c !== main && /(^|\s)(bag|backpack)$/i.test(String(c.__title || ''));
      }).length;
      // Alles al open: niets doen (nog een klik zou een bag juist sluiten).
      if (openChildren >= bagSlots.length) { tries = {}; return; }

      for (var i = 0; i < bagSlots.length; i++) {
        var slot = bagSlots[i];
        var t = tries[slot];
        if (t && now - t.since > RETRY_AFTER_MS) { delete tries[slot]; t = null; }
        if (t && t.n >= MAX_TRIES) continue;
        // Dit vak al geprobeerd en er ging iets open: de volgende bag nemen.
        if (t && openChildren > i) continue;
        tries[slot] = { n: (t ? t.n : 0) + 1, since: t ? t.since : now };
        g().send(new ItemUsePacket({ which: main, index: slot }));
        waitUntil = now + WAIT_MS;
        if (B.engine && B.engine.log) B.engine.log('Bag in de backpack geopend (vak ' + (slot + 1) + ').');
        return; // één klik per keer
      }
    } catch (e) { /* volgende keer weer */ }
  }

  // Overzicht voor controle: welke vensters open zijn en wat erin ligt.
  function info() {
    try {
      var p = me();
      if (!p || !p.__openedContainers) return { ok: false, error: 'Geen speler.' };
      return {
        ok: true,
        containers: Array.from(p.__openedContainers).map(function (c) {
          var items = [];
          for (var s = 0; s < (c.size || 0); s++) {
            var it = c.getSlotItem && c.getSlotItem(s);
            if (it) items.push({ slot: s, id: it.id, name: name(it), count: it.count, bag: isBag(it) });
          }
          return { cid: c.__containerId, parent: c.__parentCid, title: c.__title, size: c.size, items: items };
        }),
        tries: tries
      };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  B.bags = { check: check, info: info };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
