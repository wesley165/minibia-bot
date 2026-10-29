(function (B) {
  'use strict';

  // Rondjes om een vaste spot (bijv. bomen) zolang er een lok-monster (Giant Spider)
  // achter je aan zit. De spiders lopen achter je aan, jij blijft schieten.
  // Aan met config.circle:
  //   { enabled: true,
  //     ring: [{x,y,z}, ...],      // punten van het rondje, met de klok mee
  //     names: ['Giant Spider'],   // alleen hiervoor rondjes lopen
  //     see: 7,                    // zo dichtbij moet zo'n monster zijn
  //     holdFrom: 5 }              // staat de dichtstbijzijnde verder dan dit: blijven staan en schieten
  // Geen lok-monster in de buurt: niets doen (gewone route en targeting).

  var lastStep = 0;
  var dir = 1;          // 1 = met de klok mee, -1 = tegen de klok in
  var dirSince = 0;
  var why = '';

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  function monsters(ctx, p) {
    return (ctx.creatures || []).filter(function (c) {
      return c && c.type === 1 && c.hpPct > 0 && !c.masterId && c.z === p.z;
    });
  }

  // Eén stap richting q, nooit naast een Giant Spider als het anders kan (andere monsters zijn niet gevaarlijk).
  function stepToward(p, q, mons, now) {
    if (now - lastStep < 150 || p.isWalking) return false;
    var best = null, bestSc = Infinity;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      var n = { x: p.x + dx, y: p.y + dy };
      if (B.api.tileFree && !B.api.tileFree(n.x, n.y, p.z)) continue;
      if (B.api.dangerTile && B.api.dangerTile(n.x, n.y, p.z)) continue;
      var md = Infinity;
      mons.forEach(function (c) { md = Math.min(md, cheb(c, n)); });
      // Liefst recht lopen: een schuine stap kost meer dan hij oplevert (schuin is in het spel ook trager).
      var sc = (Math.abs(n.x - q.x) + Math.abs(n.y - q.y)) * 10 + (dx && dy ? 12 : 0) + (md <= 1 ? 100 : 0);
      if (sc < bestSc) { bestSc = sc; best = { dx: dx, dy: dy }; }
    }
    if (best && B.api.step(best.dx, best.dy)) { lastStep = now; return true; }
    return false;
  }

  function tick(ctx) {
    var cfg = ctx.config && ctx.config.circle;
    if (!cfg || !cfg.enabled || !Array.isArray(cfg.ring) || cfg.ring.length < 3) return null;
    var p = ctx.player;
    if (!p || p.isDead || p.z !== cfg.ring[0].z) return null;
    var now = ctx.now;
    var names = (Array.isArray(cfg.names) ? cfg.names : ['Giant Spider']).map(lower);
    var mons = monsters(ctx, p);
    var lure = mons.filter(function (c) { return names.indexOf(lower(c.name)) >= 0 && cheb(c, p) <= num(cfg.see, 7); });
    if (!lure.length) { why = 'geen spider'; return null; }

    // Aanvallen zoals altijd (Giant Spider gaat voor).
    if (B.api.chaseMode && B.api.chaseMode() !== 0 && B.api.setChaseMode) B.api.setChaseMode(0);
    if (B.targeting) { try { B.targeting.tick(ctx); } catch (e) { /* niets */ } }

    var ring = cfg.ring;
    var near = Infinity;
    lure.forEach(function (c) { near = Math.min(near, cheb(c, p)); });

    // Waar op het rondje sta ik? Het dichtstbijzijnde punt.
    var k = 0, bd = Infinity;
    for (var i = 0; i < ring.length; i++) { var d = cheb(ring[i], p); if (d < bd) { bd = d; k = i; } }

    // Ver van de spot: eerst ernaartoe (de spiders lopen mee).
    if (bd > 3) {
      stepToward(p, ring[k], lure, now);
      why = 'naar de spot';
      return { mode: 'fighting', why: why };
    }
    // Spider nog ver weg: blijven staan en schieten, dan komt hij dichterbij.
    if (near >= num(cfg.holdFrom, 5)) { why = 'wachten op spider'; return { mode: 'fighting', why: why }; }

    // Richting kiezen: weg van de spiders. Kijk 2 punten vooruit in beide richtingen;
    // de kant waar de dichtstbijzijnde spider het verst weg blijft, wint. Een gekozen
    // richting blijft 3 s staan, behalve als je anders recht op een spider afloopt.
    function ahead(d) {
      var a1 = ring[((k + d) % ring.length + ring.length) % ring.length];
      if (cheb(a1, p) <= 1) a1 = ring[((k + 2 * d) % ring.length + ring.length) % ring.length];
      return a1;
    }
    function gap(q) { var m = Infinity; lure.forEach(function (c) { m = Math.min(m, cheb(c, q)); }); return m; }
    var here = ahead(dir), other = ahead(-dir);
    var gHere = gap(here), gOther = gap(other);
    var stuck = gHere <= 1 && gOther > 1;
    if (stuck || (now - dirSince > 3000 && gOther >= gHere + 2)) { dir = -dir; dirSince = now; here = other; }
    stepToward(p, here, lure, now);
    why = 'rondje ' + (dir > 0 ? 'met de klok mee' : 'tegen de klok in');
    return { mode: 'fighting', why: why };
  }

  B.circle = { tick: tick, why: function () { return why; } };
})(window.WJBot = window.WJBot || {});
