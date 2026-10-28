(function (B) {
  'use strict';

  // Uitrusting wisselen per doel: bijv. bij een Ghost het wapen (crossbow, twee
  // handen) in de tas en een Beholder Shield aan; daarna weer terug.
  // config.gearSwap = [{ names: ['Ghost'], itemId: 3418, slot: 5, freeSlot: 4, backMs: 3000 }]
  //   itemId/slot: wat er aan moet (5 = schildvak)
  //   freeSlot: vak dat eerst leeg moet (4 = wapenvak, voor een tweehandig wapen)
  //   backMs: zo lang geen doel uit de lijst, dan alles terug
  // Gebruikt alleen B.api.

  var GAP_MS = 900;          // tijd tussen twee verplaatsingen (anders negeert het spel ze)
  var lastMove = 0;
  var state = {};            // per regel: { on, lastSeen, weaponId }

  function lower(s) { return String(s || '').toLowerCase(); }

  function targetName(ctx) {
    var me = ctx.player;
    if (!me || !me.targetId) return null;
    var list = ctx.creatures || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === me.targetId) return list[i].name;
    return null;
  }

  function tick(ctx) {
    try {
      var rules = (ctx.config && Array.isArray(ctx.config.gearSwap)) ? ctx.config.gearSwap : [];
      if (!rules.length || ctx.now - lastMove < GAP_MS) return;
      var bag = B.api.mainBackpack && B.api.mainBackpack();
      if (!bag) return;
      var tn = lower(targetName(ctx));
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!rule || !(Number(rule.itemId) > 0)) continue;
        var key = 'r' + r;
        var s = state[key] || (state[key] = { on: false, lastSeen: 0, weaponId: null });
        var names = (rule.names || []).map(lower);
        var want = tn && names.indexOf(tn) >= 0;
        if (want) s.lastSeen = ctx.now;
        var slot = Number(rule.slot), free = rule.freeSlot != null ? Number(rule.freeSlot) : null;
        s.freeSlot = free;
        var inSlot = B.api.equipSlotItem(slot);

        if (want) {
          if (inSlot && inSlot.id === Number(rule.itemId)) { s.on = true; continue; }
          // Hooguit 3 pogingen per Ghost, anders blijft hij elke seconde proberen.
          if ((s.equipTries || 0) >= 3) continue;
          // 1. Beide handen leegmaken: het (tweehandige) wapen kan in het wapenvak
          //    of in het schildvak zitten. Onthouden in welk vak, om het terug te zetten.
          var hands = [free, slot].filter(function (h) { return h != null; });
          for (var hi = 0; hi < hands.length; hi++) {
            var w = B.api.equipSlotItem(hands[hi]);
            if (w && w.id !== Number(rule.itemId)) {
              s.weaponId = w.id;
              s.weaponSlot = hands[hi];
              s.on = true;   // vanaf nu wacht automove met het wapen
              if (B.api.moveToContainer({ equip: hands[hi] }, bag, 1)) { lastMove = ctx.now; return; }
            }
          }
          // 2. Item (schild) uit de tas aantrekken.
          var it = B.api.findItem(Number(rule.itemId));
          if (it && B.api.moveToEquip(it.cid, it.slot, slot, 1)) {
            lastMove = ctx.now; s.on = true;
            s.equipTries = (s.equipTries || 0) + 1;
            if (ctx.log) ctx.log('Uitrusting: ' + (rule.label || ('item ' + rule.itemId)) + ' aan (doel ' + targetName(ctx) + ').');
            return;
          }
        } else if (s.on && ctx.now - s.lastSeen >= Number(rule.backMs || 3000)) {
          // Terug: eerst het schild in de tas, dan het wapen weer aan.
          if (inSlot && inSlot.id === Number(rule.itemId)) {
            if (B.api.moveToContainer({ equip: slot }, bag, 1)) {
              lastMove = ctx.now;
              if (ctx.log) ctx.log('Uitrusting: ' + (rule.label || ('item ' + rule.itemId)) + ' terug in de tas.');
              return;
            }
            if (ctx.log) ctx.log('Uitrusting: ' + (rule.label || 'item') + ' terug in de tas lukte niet.');
          }
          var back = s.weaponSlot != null ? s.weaponSlot : free;
          if (back != null && s.weaponId && !B.api.equipSlotItem(back)) {
            var wp = B.api.findItem(s.weaponId);
            if (wp && B.api.moveToEquip(wp.cid, wp.slot, back, 1)) {
              lastMove = ctx.now;
              s.tries = (s.tries || 0) + 1;
              if (ctx.log) ctx.log('Uitrusting: wapen (' + s.weaponId + ') weer aan, poging ' + s.tries + '.');
              if (s.tries < 5) return;   // controleren bij de volgende tick of hij echt aan zit
            } else if (ctx.log) {
              ctx.log('Uitrusting: wapen ' + s.weaponId + (wp ? ' aandoen lukte niet.' : ' niet gevonden in de tas.'));
            }
          }
          s.on = false;
          s.tries = 0;
          s.equipTries = 0;
        }
      }
    } catch (e) {
      if (ctx && typeof ctx.log === 'function') ctx.log('Fout in uitrusting wisselen: ' + (e && e.message));
    }
  }

  // Houdt de wissel dit vak nu bezet (wapen bewust uitgedaan)? Dan laat
  // automove het met rust, anders zet die het wapen meteen terug.
  function holding(slot) {
    for (var k in state) {
      // Hooguit 15 s na de laatste Ghost: daarna (bijv. bot gestopt midden in de
      // wissel) mag automove het wapen gewoon weer aandoen.
      if (state[k] && state[k].on && state[k].freeSlot === slot && Date.now() - (state[k].lastSeen || 0) < 15000) return true;
    }
    return false;
  }

  B.gearswap = { tick: tick, holding: holding, reset: function () { state = {}; lastMove = 0; } };
})(window.WJBot = window.WJBot || {});
