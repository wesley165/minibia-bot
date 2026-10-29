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
  //     range: 7 }                 // monsters binnen zoveel tegels tellen
  // Gebruikt alleen B.api en ctx.

  var st = { phase: 'up', since: 0, nextDownAt: 0, ammo0: null, targetId: null, targetHp: null, attackedAt: 0, empty: false, lastStepAt: 0 };
  var stats = { shots: 0, empties: 0, lastShotMs: null, lastRoundMs: null, lastShotAt: 0, shotGapMs: null, downAt: 0 };

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

  function tick(ctx) {
    var cfg = ctx.config && ctx.config.trapHop;
    if (!cfg || !cfg.enabled || !cfg.base || !cfg.below) return null;
    var p = ctx.player;
    if (!p || p.isDead) return null;
    var now = ctx.now;
    var base = cfg.base;
    var minHp = num(cfg.minHpPct, 60);

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
      if (!done && now - st.since > num(cfg.maxDownMs, 2500)) { done = true; why = 'te lang beneden'; }

      if (!done) {
        // Schot gelost? Munitie minder, of het doel verloor HP.
        var shot = st.ammo0 != null && ammoCount() < st.ammo0;
        if (!shot && st.targetId != null) {
          var tc = (ctx.creatures || []).filter(function (c) { return c.id === st.targetId; })[0];
          if (!tc || !(tc.hpPct > 0) || (st.targetHp != null && tc.hpPct < st.targetHp)) shot = true;
        }
        if (shot) {
          done = true; why = 'schot';
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
  }

  B.traphop = { tick: tick, reset: reset, stats: function () { return Object.assign({ phase: st.phase }, stats); } };
})(window.WJBot = window.WJBot || {});
