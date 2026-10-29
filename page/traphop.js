(function (B) {
  'use strict';

  // Trap-hoppen: de bot staat veilig boven aan een trap (bijv. de tempel van
  // Plains of Havoc). Hij gaat de trap af, schiet één keer op een monster en gaat
  // meteen weer omhoog. Boven wacht hij kort en dan opnieuw, tot er beneden
  // niets meer staat. Aan met config.trapHop:
  //   { enabled: true,
  //     base:  { x, y, z },        // veilige plek boven (naast de trap)
  //     down:  { dx: 0, dy: 1 },   // stap vanaf base de trap af
  //     below: { x, y, z },        // waar je beneden uitkomt
  //     up:    { x, y, z },        // traptegel beneden die weer omhoog gaat
  //     minHpPct: 60,              // lager: boven blijven en eerst healen
  //     waitUpMs: 1000,            // boven wachten na een schot
  //     emptyWaitMs: 5000,         // boven wachten als er beneden niets stond
  //     maxDownMs: 2500,           // nooit langer beneden
  //     range: 7,                  // monsters binnen zoveel tegels tellen
  //     lureAfterEmpty: 2,         // zo vaak achter elkaar niets beneden: monsters ophalen
  //     lureSee: 7,                // monster binnen zoveel tegels: terug naar de trap
  //     lureRoutes: [[{x,y,z},...], ...] }  // looproutes vanaf de trap (bijv. oost, zuid, zuidwest)
  // Lokken: loopt een lokroute af. Ziet hij een monster, dan valt hij aan en stapt
  // hij terug naar de trap (de monsters lopen mee). Bij de trap: omhoog en trap-hoppen.
  // Gebruikt alleen B.api en ctx.

  var st = { phase: 'up', since: 0, nextDownAt: 0, ammo0: null, targetId: null, targetHp: null, attackedAt: 0, empty: false, lastStepAt: 0 };
  var lure = { empties: 0, idx: 0, route: null, i: 0, back: null, since: 0 };
  var stats = { shots: 0, empties: 0, lures: 0, lureName: null, lastShotMs: null, lastRoundMs: null, lastShotAt: 0, shotGapMs: null, downAt: 0 };

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function ammoCount() {
    var it = B.api.equipSlotItem ? B.api.equipSlotItem(9) : null;
    return it ? it.count : 0;
  }
  function log(ctx, msg) { if (ctx && ctx.log) ctx.log('Trap-hop: ' + msg); }

  function monstersBelow(ctx, p, cfg) {
    var ign = ((ctx.config && ctx.config.targeting && ctx.config.targeting.ignoreNames) || []).map(lower);
    var r = num(cfg.range, 7);
    return (ctx.creatures || []).filter(function (c) {
      if (!c || c.type !== 1 || !(c.hpPct > 0) || c.masterId || c.z !== p.z) return false;
      if (ign.indexOf(lower(c.name)) >= 0) return false;
      return Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) <= r;
    });
  }

  function pickTarget(list, p) {
    var best = null, bestKey = Infinity;
    list.forEach(function (c) {
      if (!c.canSee) return;
      var d = Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y));
      // Eerst een vrije schietlijn, dan het minste HP, dan het dichtst bij.
      var key = (c.los ? 0 : 100000) + c.hpPct * 100 + d;
      if (key < bestKey) { bestKey = key; best = c; }
    });
    return best;
  }

  function goUp(ctx, p, cfg, now) {
    var up = cfg.up;
    if (!up) return;
    var dx = up.x - p.x, dy = up.y - p.y;
    if (now - st.lastStepAt < 300) return;
    st.lastStepAt = now;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy)) B.api.stairStep(dx, dy);
    else B.api.walkTo(up.x, up.y, up.z);
  }


  function safe(fn) { try { return fn(); } catch (e) { return null; } }
  function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  // Eén stap richting punt q (met toetsen, zodat het doel blijft staan en hij doorschiet).
  function stepToward(p, q, now) {
    if (now - st.lastStepAt < 150) return;
    var best = null, bestSc = Infinity;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      var n = { x: p.x + dx, y: p.y + dy };
      if (B.api.tileFree && !B.api.tileFree(n.x, n.y, p.z)) continue;
      if (B.api.dangerTile && B.api.dangerTile(n.x, n.y, p.z)) continue;
      var sc = cheb(n, q) * 10 + Math.abs(n.x - q.x) + Math.abs(n.y - q.y) + (dx && dy ? 3 : 0);
      if (sc < bestSc) { bestSc = sc; best = { dx: dx, dy: dy }; }
    }
    if (best && B.api.step(best.dx, best.dy)) st.lastStepAt = now;
  }

  // Weg van de monsters (nooit dichterbij), en van de mogelijke stappen die het dichtst bij het doel.
  function stepAway(ctx, p, goal, now) {
    if (now - st.lastStepAt < 150) return;
    var mons = (ctx.creatures || []).filter(function (c) { return c && c.type === 1 && c.hpPct > 0 && !c.masterId && c.z === p.z && cheb(c, p) <= 8; });
    function mind(q) { var d = Infinity; mons.forEach(function (c) { d = Math.min(d, cheb(c, q)); }); return d; }
    var cur = mind(p), best = null, bestSc = Infinity, far = null, farD = -1;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      var n = { x: p.x + dx, y: p.y + dy };
      if (B.api.tileFree && !B.api.tileFree(n.x, n.y, p.z)) continue;
      if (B.api.dangerTile && B.api.dangerTile(n.x, n.y, p.z)) continue;
      var d = mind(n);
      if (d > farD) { farD = d; far = { dx: dx, dy: dy }; }
      if (d < cur) continue;
      var sc = cheb(n, goal) * 10 + (dx && dy ? 3 : 0) - d;
      if (sc < bestSc) { bestSc = sc; best = { dx: dx, dy: dy }; }
    }
    var pick = best || far;
    if (pick && B.api.step(pick.dx, pick.dy)) st.lastStepAt = now;
  }

  function nearestMonster(ctx, p, cfg, r) {
    var only = (Array.isArray(cfg.lureTargets) ? cfg.lureTargets : []).map(lower);
    var list = monstersBelow(ctx, p, Object.assign({}, cfg, { range: r })).filter(function (c) { return !only.length || only.indexOf(lower(c.name)) >= 0; });
    var best = null, bd = Infinity;
    list.forEach(function (c) { var d = cheb(c, p) + (c.los ? 0 : 3); if (d < bd) { bd = d; best = c; } });
    return best;
  }

  // Terugweg: de lokroute achterstevoren vanaf het punt waar je nu bent, en dan de trap.
  function startBack(cfg, p) {
    var r = lure.route || [];
    var k = 0, bd = Infinity;
    for (var i = 0; i < r.length; i++) { var d = cheb(r[i], p); if (d < bd) { bd = d; k = i; } }
    // Rondje: liefst het vroegste punt dat bijna even dichtbij ligt (kortste weg terug).
    for (var j = 0; j < k; j++) if (cheb(r[j], p) <= bd + 2) { k = j; break; }
    var back = r.slice(0, k + 1).reverse();
    back.push({ x: cfg.below.x, y: cfg.below.y, z: cfg.below.z });
    lure.back = back;
    lure.i = 0;
    st.phase = 'lureBack';
    st.since = Date.now();
  }

  // Gewoon hunten (aanvallen, 3-4 tegels afstand, naar het monster toe als hij te ver staat),
  // met als enige verschil: bij het weglopen richting de trap. Alleen lok-monsters.
  // Zit er een Giant Spider (config lureChase) achter je aan? Alleen dan richting de tempel.
  function chasing(ctx, p, cfg) {
    var names = (Array.isArray(cfg.lureChase) ? cfg.lureChase : ['Giant Spider']).map(lower);
    return (ctx.creatures || []).some(function (c) {
      return c && c.type === 1 && c.hpPct > 0 && c.z === p.z && names.indexOf(lower(c.name)) >= 0 && cheb(c, p) <= 7;
    });
  }

  function huntTick(ctx, p, cfg, now) {
    var only = (Array.isArray(cfg.lureTargets) && cfg.lureTargets.length) ? cfg.lureTargets : null;
    var tc = Object.assign({}, (ctx.config && ctx.config.targeting) || {});
    tc.keepDistance = num(cfg.lureKeep, 3);
    tc.kiteRange = num(cfg.lureRange, tc.keepDistance + 1);
    if (only) { tc.monsters = only.map(function (n) { return { name: n, priority: 1 }; }); tc.attackAll = false; }
    var home = chasing(ctx, p, cfg) ? { x: cfg.below.x, y: cfg.below.y, z: cfg.below.z } : null;
    var tctx = Object.assign({}, ctx, { config: Object.assign({}, ctx.config, { targeting: tc }), kiteHome: home });
    var t = B.targeting ? safe(function () { return B.targeting.tick(tctx); }) : null;
    if (t && t.fighting) {
      if (B.kite) safe(function () { return B.kite.tick(tctx, t.targetId); });
      return { mode: 'fighting', why: 'lokken: hunten' };
    }
    if (t && t.approach) {
      if (now - st.lastStepAt > 800 || !p.isWalking) { st.lastStepAt = now; B.api.walkTo(t.approach.x, t.approach.y, t.approach.z); }
      return { mode: 'walking', why: 'lokken: naar ' + t.approach.name };
    }
    // In beeld maar (nog) niet aan te vallen: blijven staan tot hij dichterbij komt.
    var vis = nearestMonster(ctx, p, cfg, 9);
    if (vis && Math.abs(vis.x - p.x) <= 7 && Math.abs(vis.y - p.y) <= 5) {
      if (p.isWalking && B.api.cancelWalk) B.api.cancelWalk();
      return { mode: 'fighting', why: 'lokken: wachten op ' + vis.name };
    }
    return null;
  }

  function lureTick(ctx, p, cfg, now) {
    var minHp = num(cfg.minHpPct, 60);
    var r = lure.route || [];
    if (!(p.hpPct >= minHp) && st.phase === 'lureOut') { log(ctx, 'HP laag, terug naar de trap.'); startBack(cfg, p); }

    // Giant Spider achter je aan en je bent bij de trap: omhoog, dan trap-hoppen.
    if (chasing(ctx, p, cfg) && cheb(p, cfg.below) <= 2) {
      if (B.api.clearTarget) B.api.clearTarget();
      st.phase = 'goingUp';
      lure.empties = 0; lure.fought = false;
      goUp(ctx, p, cfg, now);
      return { mode: 'walking', why: 'lokken: spider mee, trap op' };
    }
    // Lok-monster in de buurt (Giant Spider, Wolf): gewoon hunten.
    if (p.hpPct >= minHp) {
      var h = huntTick(ctx, p, cfg, now);
      if (h) { lure.fought = true; lure.quietSince = 0; return h; }
    }
    // Net klaar met vechten: even rustig? Dicht bij de trap: omhoog en trap-hoppen.
    if (lure.fought) {
      if (!lure.quietSince) lure.quietSince = now;
      if (now - lure.quietSince < 1500) return { mode: 'action', why: 'lokken: kijken' };
      lure.fought = false;
      if (st.phase === 'lureOut') {
        // Verder op de lokroute vanaf het dichtstbijzijnde punt.
        var k = 0, bd = Infinity;
        for (var i = 0; i < r.length; i++) { var d = cheb(r[i], p); if (d < bd) { bd = d; k = i; } }
        lure.i = k;
      }
    }

    if (st.phase === 'lureOut') {
      while (lure.i < r.length && cheb(r[lure.i], p) <= 1) lure.i++;
      if (lure.i >= r.length) { log(ctx, 'eind van de lokroute, terug naar de trap.'); startBack(cfg, p); }
      else {
        if (now - st.lastStepAt > 800 || !p.isWalking) { st.lastStepAt = now; B.api.walkTo(r[lure.i].x, r[lure.i].y, r[lure.i].z); }
        return { mode: 'walking', why: 'lokken: zoeken' };
      }
    }

    // Terug naar de trap (geen lok-monsters meer in de buurt).
    var bk = lure.back || [];
    while (lure.i < bk.length - 1 && cheb(bk[lure.i], p) <= 1) lure.i++;
    var goal = bk[lure.i] || cfg.below;
    if (lure.i >= bk.length - 1 && p.x === cfg.below.x && p.y === cfg.below.y) {
      st.phase = 'goingUp';
      lure.empties = 0;
      goUp(ctx, p, cfg, now);
      return { mode: 'walking', why: 'lokken: trap op' };
    }
    if (now - st.lastStepAt > 800 || !p.isWalking) { st.lastStepAt = now; B.api.walkTo(goal.x, goal.y, goal.z); }
    return { mode: 'walking', why: 'lokken: naar de trap' };
  }

  function tick(ctx) {
    var cfg = ctx.config && ctx.config.trapHop;
    if (!cfg || !cfg.enabled || !cfg.base || !cfg.below) return null;
    var p = ctx.player;
    if (!p || p.isDead) return null;
    var now = ctx.now;
    var base = cfg.base;
    var minHp = num(cfg.minHpPct, 60);
    // Ver van de trap (bijv. na een death of als je zelf ergens anders speelt)? Niets doen,
    // dan pauzeert de engine zelf ('waar'). Nooit in de verte naar de tempel lopen.
    if (Math.max(cheb(p, base), cheb(p, cfg.below)) > num(cfg.maxRange, 40) || (p.z !== base.z && p.z !== cfg.below.z)) { reset(); return null; }

    // Boven (veilige verdieping).
    if (p.z === base.z) {
      if (st.phase !== 'up') {
        // Net boven aangekomen.
        stats.lastRoundMs = stats.downAt ? now - stats.downAt : null;
        st.nextDownAt = now + (st.empty ? num(cfg.emptyWaitMs, 5000) : num(cfg.waitUpMs, 1000));
        st.phase = 'up';
        st.since = now;
        if (B.api.clearTarget) B.api.clearTarget();
      }
      // Niet op de basisplek? Eerst daarheen.
      if (p.x !== base.x || p.y !== base.y) {
        if (now - st.lastStepAt > 800) { st.lastStepAt = now; B.api.walkTo(base.x, base.y, base.z); }
        return { mode: 'walking', why: 'naar basis' };
      }
      if (!(p.hpPct >= minHp)) return { mode: 'action', why: 'healen boven' };
      if (now < st.nextDownAt) return { mode: 'action', why: 'wachten boven' };
      if (now - st.lastStepAt > 600) {
        st.lastStepAt = now;
        var dn = cfg.down || { dx: 0, dy: 1 };
        B.api.stairStep(num(dn.dx, 0), num(dn.dy, 1));
      }
      return { mode: 'action', why: 'trap af' };
    }

    // Beneden.
    if (p.z === cfg.below.z) {
      if (st.phase === 'lureOut' || st.phase === 'lureBack') return lureTick(ctx, p, cfg, now);
      if (st.phase !== 'down' && st.phase !== 'goingUp') {
        st.phase = 'down';
        st.since = now;
        stats.downAt = now;
        st.ammo0 = ammoCount();
        st.targetId = null;
        st.targetHp = null;
        st.attackedAt = 0;
        st.empty = false;
      }
      if (st.phase === 'goingUp') { goUp(ctx, p, cfg, now); return { mode: 'walking', why: 'trap op' }; }

      var done = false, why = '';
      if (!(p.hpPct >= minHp)) { done = true; why = 'HP laag'; }
      // Monster direct naast je: meteen omhoog.
      // Monster direct naast je: eerst kort de kans geven om te schieten, dan omhoog.
      if (!done && now - st.since > num(cfg.adjacentGraceMs, 1200) && (ctx.creatures || []).some(function (c) { return c && c.type === 1 && c.hpPct > 0 && !c.masterId && c.z === p.z && cheb(c, p) <= 1; })) { done = true; why = 'monster naast me'; }
      // Doel gekozen maar nog geen schot: wachten tot de bolt gaat. Zonder doel na maxDownMs omhoog,
      // met doel pas na maxWaitShotMs (veiligheidsgrens).
      if (!done && now - st.since > (st.targetId != null ? num(cfg.maxWaitShotMs, 10000) : num(cfg.maxDownMs, 2500))) { done = true; why = 'te lang beneden'; }

      if (!done) {
        // Schot gelost? Munitie minder, of het doel verloor HP.
        var shot = st.ammo0 != null && ammoCount() < st.ammo0;
        if (!shot && st.targetId != null) {
          var tc = (ctx.creatures || []).filter(function (c) { return c.id === st.targetId; })[0];
          if (!tc || !(tc.hpPct > 0) || (st.targetHp != null && tc.hpPct < st.targetHp)) shot = true;
        }
        if (shot) {
          done = true; why = 'schot'; lure.empties = 0;
          stats.shots++;
          stats.lastShotMs = now - st.since;
          if (stats.lastShotAt) stats.shotGapMs = now - stats.lastShotAt;
          stats.lastShotAt = now;
        }
      }

      if (!done && st.targetId == null) {
        var list = monstersBelow(ctx, p, cfg);
        var t = pickTarget(list, p);
        if (t) {
          if (B.api.attack(t.id)) { st.targetId = t.id; st.targetHp = t.hpPct; st.attackedAt = now; }
        } else if (now - st.since > 700) {
          // Monsters zijn na 0,7 s in beeld. Niets? Dan omhoog en langer wachten.
          lure.empties++;
          var routes = Array.isArray(cfg.lureRoutes) ? cfg.lureRoutes.filter(function (r) { return r && r.length; }) : [];
          if (routes.length && lure.empties >= num(cfg.lureAfterEmpty, 2) && p.hpPct >= minHp) {
            lure.route = routes[lure.idx % routes.length];
            stats.lureName = (cfg.lureNames && cfg.lureNames[lure.idx % routes.length]) || String(lure.idx % routes.length);
            lure.idx++; lure.i = 0; stats.lures++;
            st.phase = 'lureOut'; st.since = now;
            log(ctx, 'niets beneden, monsters ophalen (' + stats.lureName + ').');
            return lureTick(ctx, p, cfg, now);
          }
          done = true; why = 'niets beneden'; st.empty = true; stats.empties++;
        }
      }

      if (done) {
        st.phase = 'goingUp';
        if (why !== 'schot' && why !== 'niets beneden') log(ctx, why + ', weer omhoog.');
        goUp(ctx, p, cfg, now);
        return { mode: 'walking', why: 'trap op (' + why + ')' };
      }
      return { mode: 'fighting', why: st.targetId != null ? 'schieten' : 'zoeken' };
    }

    // Op een andere verdieping: niet ingrijpen.
    return null;
  }

  function reset() {
    st = { phase: 'up', since: 0, nextDownAt: 0, ammo0: null, targetId: null, targetHp: null, attackedAt: 0, empty: false, lastStepAt: 0 };
    lure = { empties: 0, idx: 0, route: null, i: 0, back: null, since: 0 };
  }

  B.traphop = { tick: tick, reset: reset, stats: function () { return Object.assign({ phase: st.phase }, stats); } };
})(window.WJBot = window.WJBot || {});
