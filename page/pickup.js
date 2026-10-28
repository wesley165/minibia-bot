(function (B) {
  'use strict';

  // Spullen van de grond oppakken (bijv. verschoten bolts).
  // config.pickup = { ids: [3446], walk: 4 }
  //   ids: welke items
  //   walk: zo ver (tegels) mag de bot ervoor lopen als er geen monster dichtbij is (0 = niet lopen)
  // Naast je (1 tegel): altijd meteen oppakken, ook tijdens een gevecht.
  // Gebruikt alleen B.api.

  var GAP_MS = 700;          // tijd tussen twee verplaatsingen
  var lastMove = 0;
  var skip = {};             // "x,y,z" -> tijd: plek even overslaan (lukte niet of niet bereikbaar)
  var target = null;         // { x, y, z, since } plek waar we naartoe lopen
  // Lijken om langs te lopen (auto-loot van de client werkt alleen dichtbij).
  // config.pickup.lootWalk (standaard aan): zo dicht moet de bot erbij komen.
  var corpses = [];          // { x, y, z, added, near }
  var CORPSE_MAX_MS = 8000;  // langer dan dit: opgeven
  var CORPSE_DWELL_MS = 0;   // zo lang naast het lijk blijven staan (0 = meteen door)

  function addCorpse(pos, now) {
    corpses.push({ x: pos.x, y: pos.y, z: pos.z, added: now || Date.now(), near: 0 });
    if (corpses.length > 6) corpses.shift();
  }

  // Volgende lijk om naartoe te lopen, of null. Haalt afgehandelde lijken weg.
  function corpseTarget(ctx, me, cfg) {
    if (cfg.lootWalk === false) { corpses = []; return null; }
    var reach = Number(cfg.lootRange) > 0 ? Number(cfg.lootRange) : 1;
    while (corpses.length) {
      var c = corpses[0];
      var d = me.z === c.z ? B.api.distance(me, c) : Infinity;
      if (ctx.now - c.added > CORPSE_MAX_MS || d > 12) { corpses.shift(); continue; }
      if (d <= reach) {
        if (!c.near) c.near = ctx.now;
        var dwell = cfg.lootDwellMs != null ? Number(cfg.lootDwellMs) : CORPSE_DWELL_MS;
        if (ctx.now - c.near >= dwell) { corpses.shift(); continue; }
        return { x: me.x, y: me.y, z: me.z, stay: true };   // even blijven staan
      }
      return { x: c.x, y: c.y, z: c.z };
    }
    return null;
  }

  function key(t) { return t.x + ',' + t.y + ',' + t.z; }

  // Eén keer per tick: oppakken als het naast je ligt. Geeft true als er iets is verplaatst.
  function grab(ctx) {
    var cfg = (ctx.config && ctx.config.pickup) || {};
    var ids = Array.isArray(cfg.ids) ? cfg.ids.map(Number) : [];
    var me = ctx.player;
    if (!ids.length || !me || ctx.now - lastMove < GAP_MS) return false;
    var bag = B.api.mainBackpack && B.api.mainBackpack();
    if (!bag) return false;
    var near = B.api.groundItems(me.x, me.y, me.z, 1, ids);
    for (var i = 0; i < near.length; i++) {
      var it = near[i];
      if (skip[key(it)] && skip[key(it)] > ctx.now) continue;
      if (B.api.moveToContainer({ tile: it, index: it.index }, bag, it.count)) {
        lastMove = ctx.now;
        skip[key(it)] = ctx.now + 1500;   // niet direct opnieuw dezelfde plek proberen
        if (ctx.log) ctx.log('Opgepakt: ' + it.count + 'x item ' + it.id + ' op ' + key(it) + '.');
        return true;
      }
    }
    return false;
  }

  // Plek om naartoe te lopen (alleen als het rustig is). Geeft {x,y,z} of null.
  function walkTarget(ctx) {
    var cfg = (ctx.config && ctx.config.pickup) || {};
    var ids = Array.isArray(cfg.ids) ? cfg.ids.map(Number) : [];
    var r = Number(cfg.walk) || 0;
    var me = ctx.player;
    if (!me) return null;
    // Rustig: geen monster binnen 4 tegels.
    var list = ctx.creatures || [];
    for (var c = 0; c < list.length; c++) {
      var m = list[c];
      if (m && m.type === 1 && m.hpPct > 0 && m.z === me.z && B.api.distance(me, m) <= 4) { target = null; return null; }
    }
    var ct = corpseTarget(ctx, me, cfg);
    if (ct) return ct;   // ook "blijven staan" (eigen plek): dan loopt de route niet verder
    if (target && ctx.now - target.since > 6000) { skip[key(target)] = ctx.now + 60000; target = null; }
    if (target && B.api.distance(me, target) <= 1) target = null;   // erbij: grab() pakt het op
    if (target) return target;
    if (!ids.length || !(r > 1)) return null;
    var found = B.api.groundItems(me.x, me.y, me.z, r, ids);
    var best = null;
    for (var i = 0; i < found.length; i++) {
      var f = found[i];
      if (skip[key(f)] && skip[key(f)] > ctx.now) continue;
      var d = B.api.distance(me, f);
      if (d <= 1) continue;   // dat doet grab()
      if (B.api.dangerTile && B.api.dangerTile(f.x, f.y, f.z)) continue;   // nooit op een gat of trap
      if (B.api.walkDistance && B.api.walkDistance(f) > d + 4) continue;   // niet om een muur heen
      if (!best || d < best.d) best = { x: f.x, y: f.y, z: f.z, d: d };
    }
    if (best) target = { x: best.x, y: best.y, z: best.z, since: ctx.now };
    return target;
  }

  function reset() { target = null; skip = {}; lastMove = 0; }

  B.pickup = { grab: grab, walkTarget: walkTarget, reset: reset, addCorpse: addCorpse };
})(window.WJBot = window.WJBot || {});
