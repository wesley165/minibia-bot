(function (B) {
  'use strict';

  // Automatisch verplaatsen: bijv. crystal coins altijd naar het pijlenvak.
  // Draait altijd zolang het spel open is, ook als de bot gestopt is.
  // Regels uit config.autoMove: [{ itemId, slot, name, toDepot, onlyEmpty }].
  // Bijv. een nieuwe life ring omdoen als de oude op is (slot 8, onlyEmpty).
  if (B.automove) return;

  var CHECK_MS = 1000;
  var AFTER_MOVE_MS = 1500; // even wachten tot de server de verplaatsing heeft verwerkt
  var MAX_STACK = 100;
  var waitUntil = 0;
  var altOn = null;   // ammoSwitch: nu de andere munitie (bijv. power bolts) gebruiken?

  // Munitie wisselen: config.ammoSwitch = { slot: 9, normal: 3446, alt: 3450, altAbove: 200, altUntil: 100 }.
  // Meer dan altAbove van 'alt': die gebruiken tot er altUntil over zijn, dan weer 'normal'.
  // Geeft het item-ID dat nu in het vak hoort, of null als er geen wissel is ingesteld.
  function ammoActive(sw) {
    if (!sw || !(Number(sw.alt) > 0) || !(Number(sw.normal) > 0)) return null;
    var alt = Number(sw.alt), n = 0;
    try { n = B.api.countItem(alt); } catch (e) { n = 0; }
    var q = B.api.equipSlotItem(Number(sw.slot));
    if (q && q.id === alt) n += q.count;
    if (altOn === null) altOn = n > Number(sw.altAbove);
    if (n > Number(sw.altAbove)) altOn = true;
    if (n <= Number(sw.altUntil)) altOn = false;
    return altOn ? alt : Number(sw.normal);
  }

  function check() {
    try {
      var now = Date.now();
      if (now < waitUntil) return;
      var cfg = B.engine && B.engine.getConfig ? B.engine.getConfig() : null;
      var rules = (cfg && cfg.autoMove) || [];
      if ((!rules.length && !(cfg && cfg.stack && cfg.stack.length)) || !B.api || !B.api.ready()) return;
      // Tijdens het refillen niets verplaatsen: dat schuift de depot-vakken op.
      if (B.depot && B.depot.isBusy && B.depot.isBusy()) return;
      var p = B.api.player();
      if (!p || p.isDead) return;

      // Stapels samenvoegen: config.stack = [itemId, ...], bijv. [3447] voor arrows.
      var stackIds = (cfg && Array.isArray(cfg.stack)) ? cfg.stack : [];
      for (var si = 0; si < stackIds.length; si++) {
        if (B.api.stackItem(Number(stackIds[si]))) {
          waitUntil = now + AFTER_MOVE_MS;
          return; // één verplaatsing per keer
        }
      }

      var depot = B.api.depotTarget();

      // Munitie wisselen: verkeerde soort in het vak eerst terug in de tas.
      var sw = cfg && cfg.ammoSwitch;
      var ammoId = depot ? null : ammoActive(sw);
      if (ammoId) {
        var aq = B.api.equipSlotItem(Number(sw.slot));
        var other = ammoId === Number(sw.alt) ? Number(sw.normal) : Number(sw.alt);
        var mb = B.api.mainBackpack && B.api.mainBackpack();
        if (aq && aq.id === other && mb && B.api.moveToContainer({ equip: Number(sw.slot) }, mb, aq.count)) {
          waitUntil = now + AFTER_MOVE_MS;
          if (B.engine && B.engine.log) B.engine.log('Munitie wisselen: item ' + other + ' terug in de tas, nu item ' + ammoId + '.');
          return;
        }
      }

      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (!r || r.enabled === false) continue;
        var id = Number(r.itemId);
        var slot = Number(r.slot);
        // De munitieregel volgt de wissel (bolts of power bolts).
        if (ammoId && slot === Number(sw.slot) && (id === Number(sw.normal) || id === Number(sw.alt))) id = ammoId;
        if (!(id > 0) || !(slot >= 0 && slot <= 9)) continue;

        // Depot open: deze regel even uit, en (als dat aan staat) alles naar het depot.
        if (depot) {
          if (r.toDepot === false) continue;
          var bag = B.api.findItem(id);
          var fromBag = bag ? { cid: bag.cid, slot: bag.slot } : null;
          var q = B.api.equipSlotItem(slot);
          var from = fromBag || (q && q.id === id ? { equip: slot } : null);
          var cnt = fromBag ? bag.count : (q ? q.count : 0);
          if (from && B.api.moveToContainer(from, depot, cnt)) {
            waitUntil = now + AFTER_MOVE_MS;
            if (B.engine && B.engine.log) B.engine.log((r.name || ('Item ' + id)) + ' naar het depot gezet.');
            return;
          }
          continue;
        }

        // Uitrusting-wissel (bijv. schild bij een Ghost) houdt dit vak bewust leeg.
        if (B.gearswap && B.gearswap.holding && B.gearswap.holding(slot)) continue;

        // In het vak zit iets anders: niet aanraken.
        var inSlot = B.api.equipSlotItem(slot);
        // Alleen een leeg vak vullen (bijv. een ring): nooit iets erbij leggen.
        if (r.onlyEmpty && inSlot) continue;
        if (inSlot && inSlot.id !== id) continue;
        var room = MAX_STACK - (inSlot ? inSlot.count : 0);
        if (room <= 0) continue;
        // Pas aanvullen als er genoeg mist (bijv. minMissing 15: bij 85 of minder).
        // Een leeg vak vult hij altijd meteen.
        if (inSlot && Number(r.minMissing) > 0 && room < Number(r.minMissing)) continue;

        var found = B.api.findItem(id);
        if (!found) continue;
        if (B.api.moveToEquip(found.cid, found.slot, slot, Math.min(room, found.count))) {
          waitUntil = now + AFTER_MOVE_MS;
          if (B.engine && B.engine.log) B.engine.log((r.name || ('Item ' + id)) + ' naar vak ' + slot + ' gezet.');
          return; // één verplaatsing per keer
        }
      }
    } catch (e) { /* volgende keer weer */ }
  }

  B.automove = { check: check };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
