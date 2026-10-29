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
  var idx = -1;         // punt van de ring waar we nu heen lopen
  var why = '';

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  function monsters(ctx, p) {
    return (ctx.creatures || []).filter(function (c) {
      return c && c.type === 1 && c.hpPct > 0 && !c.masterId && c.z === p.z;
    });
  }

  // Eén stap richting q via het kortste pad (Dijkstra over vrije tegels in de buurt).
  // Zo loopt hij niet in een gat tussen de bosjes waar hij niet verder kan.
  // Recht kost 10, schuin 14 (schuin is trager); naast een Giant Spider kost veel extra.
  function stepToward(p, q, lure, now) {
    if (now - lastStep < 150 || p.isWalking) return false;
    var x0 = Math.min(p.x, q.x) - 4, x1 = Math.max(p.x, q.x) + 4;
    var y0 = Math.min(p.y, q.y) - 4, y1 = Math.max(p.y, q.y) + 4;
    var free = {};
    function key(x, y) { return x + ',' + y; }
    function ok(x, y) {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      var k = key(x, y);
      if (!(k in free)) free[k] = (x === p.x && y === p.y) || (!!(B.api.tileFree && B.api.tileFree(x, y, p.z)) && !(B.api.dangerTile && B.api.dangerTile(x, y, p.z)));
      return free[k];
    }
    function near(x, y) { var m = Infinity; lure.forEach(function (c) { m = Math.min(m, Math.max(Math.abs(c.x - x), Math.abs(c.y - y))); }); return m; }
    var dist = {}, first = {}, open = [{ x: p.x, y: p.y, d: 0 }];
    dist[key(p.x, p.y)] = 0;
    var goal = null;
    while (open.length) {
      var bi = 0;
      for (var i = 1; i < open.length; i++) if (open[i].d < open[bi].d) bi = i;
      var c = open.splice(bi, 1)[0];
      if (c.d > dist[key(c.x, c.y)]) continue;
      if (Math.max(Math.abs(c.x - q.x), Math.abs(c.y - q.y)) <= 0) { goal = c; break; }
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        var nx = c.x + dx, ny = c.y + dy;
        if (!ok(nx, ny)) continue;
        if (dx && dy && !(ok(c.x + dx, c.y) || ok(c.x, c.y + dy))) continue;   // niet door een hoekje
        var cost = (dx && dy ? 14 : 10) + (near(nx, ny) <= 1 ? 200 : 0);
        var nd = c.d + cost, nk = key(nx, ny);
        if (!(nk in dist) || nd < dist[nk]) {
          dist[nk] = nd;
          first[nk] = (c.x === p.x && c.y === p.y) ? { dx: dx, dy: dy } : first[key(c.x, c.y)];
          open.push({ x: nx, y: ny, d: nd });
        }
      }
    }
    var st = goal ? first[key(goal.x, goal.y)] : null;
    if (!st) {
      // Geen pad (doel bezet of buiten beeld): de vrije buurtegel die het dichtst bij het doel ligt.
      var bestSc = Infinity;
      for (var ddx = -1; ddx <= 1; ddx++) for (var ddy = -1; ddy <= 1; ddy++) {
        if (!ddx && !ddy) continue;
        if (!ok(p.x + ddx, p.y + ddy)) continue;
        var sc = (Math.abs(p.x + ddx - q.x) + Math.abs(p.y + ddy - q.y)) * 10 + (ddx && ddy ? 12 : 0) + (near(p.x + ddx, p.y + ddy) <= 1 ? 100 : 0);
        if (sc < bestSc) { bestSc = sc; st = { dx: ddx, dy: ddy }; }
      }
    }
    if (st && B.api.step(st.dx, st.dy)) { lastStep = now; return true; }
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
      // Niet te ver vooruit lopen: staat de spider verder dan leadDist, eerst wachten en schieten.
      if (near > num(cfg.leadDist, 3)) { why = 'lokken: wachten op spider'; return { mode: 'fighting', why: why }; }
      stepToward(p, ring[k], lure, now);
      why = 'naar de spot';
      return { mode: 'fighting', why: why };
    }
    // Spider nog ver weg: blijven staan en schieten, dan komt hij dichterbij.
    if (near >= num(cfg.holdFrom, 5)) { why = 'wachten op spider'; return { mode: 'fighting', why: why }; }

    // Richting kiezen: weg van de spiders. Vergelijk het volgende punt in beide richtingen;
    // de kant waar de dichtstbijzijnde spider het verst weg blijft, wint. Een gekozen
    // richting blijft 3 s staan, behalve als je anders recht op een spider afloopt.
    var n = ring.length;
    function at(i) { return ring[((i % n) + n) % n]; }
    function gap(q) { var m = Infinity; lure.forEach(function (c) { m = Math.min(m, cheb(c, q)); }); return m; }
    if (idx < 0 || cheb(at(idx), p) > 4) idx = (cheb(ring[k], p) <= 1) ? k + dir : k;
    var gHere = gap(at(cheb(at(idx), p) <= 1 ? idx + dir : idx));
    var gOther = gap(at(k - dir));
    var stuck = gHere <= 1 && gOther > 1;
    if (stuck || (now - dirSince > 3000 && gOther >= gHere + 2)) {
      dir = -dir; dirSince = now;
      idx = (cheb(ring[k], p) <= 1) ? k + dir : k;
    }
    // Pas door naar het volgende punt als we er precies op staan (geen hoeken afsnijden).
    // Binnen 1 tegel van het punt is goed genoeg: dan door naar het volgende.
    if (cheb(at(idx), p) <= 1) idx += dir;
    idx = ((idx % n) + n) % n;
    stepToward(p, at(idx), lure, now);
    why = 'rondje ' + (dir > 0 ? 'met de klok mee' : 'tegen de klok in');
    return { mode: 'fighting', why: why };
  }

  B.circle = { tick: tick, why: function () { return why; } };
})(window.WJBot = window.WJBot || {});
