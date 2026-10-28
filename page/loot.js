(function (B) {
  'use strict';

  // Looten: staat er een lijk open (het spel opent lijken zelf), dan haalt de
  // bot de items uit de lootlijst eruit en legt ze in je backpack.
  // Goud en eten lootet het spel zelf. Lijst in config.loot: [{ name, itemId }].
  // Zonder itemId zoekt de bot op naam (hoofdletters en spaties tellen niet).
  if (B.loot) return;

  var CHECK_MS = 500;
  var AFTER_MOVE_MS = 700; // even wachten tot de server de verplaatsing heeft verwerkt
  var waitUntil = 0;

  function key(name) {
    return String(name || '').toLowerCase().replace(/^(a|an)\s+/, '').replace(/[^a-z0-9]/g, '');
  }

  function isCorpse(c) {
    return /^(dead|slain|remains|the remains)\b/i.test(String(c.__title || ''));
  }

  // Backpack met plek: een stapel van hetzelfde item (minder dan 100) of een leeg vak.
  function hasRoom(c, id) {
    var size = Number(c.size) || 0;
    for (var i = 0; i < size; i++) {
      var it = c.getSlotItem(i);
      if (!it || (it.id === id && (Number(it.count) || 1) < 100)) return true;
    }
    return false;
  }

  function check() {
    try {
      var now = Date.now();
      if (now < waitUntil) return;
      var cfg = B.engine && B.engine.getConfig ? B.engine.getConfig() : null;
      var list = (cfg && cfg.loot) || [];
      if (!list.length || !B.api || !B.api.ready()) return;
      if (B.depot && B.depot.isBusy && B.depot.isBusy()) return;
      var ids = {};
      var names = {};
      list.forEach(function (r) {
        if (!r || r.enabled === false) return;
        if (Number(r.itemId) > 0) ids[Number(r.itemId)] = r.name || ('item ' + r.itemId);
        else if (r.name) names[key(r.name)] = r.name;
      });
      var hasNames = Object.keys(names).length > 0;

      var conts = B.api.openContainers();
      var corpses = conts.filter(isCorpse);
      if (!corpses.length) return;
      var bags = conts.filter(function (c) { return !isCorpse(c); });

      for (var k = 0; k < corpses.length; k++) {
        var c = corpses[k];
        var size = Number(c.size) || 0;
        for (var s = 0; s < size; s++) {
          var it = c.getSlotItem(s);
          if (!it) continue;
          if (!ids[it.id] && hasNames) {
            var nm = names[key(B.api.itemName(it.id))];
            if (nm) ids[it.id] = nm;
          }
          if (!ids[it.id]) continue;
          var bag = bags.find(function (b) { return hasRoom(b, it.id); });
          if (!bag) {
            if (B.engine && B.engine.log) B.engine.log('Geen plek in je backpack voor ' + ids[it.id] + '.');
            waitUntil = now + 30000;
            return;
          }
          var cnt = Number(it.count) || 1;
          if (B.api.moveToContainer({ cid: c.__containerId, slot: s }, bag, cnt)) {
            waitUntil = now + AFTER_MOVE_MS;
            if (B.engine && B.engine.log) B.engine.log(ids[it.id] + (cnt > 1 ? ' (' + cnt + ')' : '') + ' gelootet.');
            return; // één verplaatsing per keer
          }
        }
      }
    } catch (e) { /* volgende keer weer */ }
  }

  B.loot = { check: check };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
