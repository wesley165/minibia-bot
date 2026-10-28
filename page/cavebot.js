(function (B) {
  'use strict';

  // Cavebot: loopt de waypoints van de route af.
  // Gebruikt alleen B.api en ctx, nooit gameClient direct.

  var ROPE_ID = 3003;          // touw (client-id)
  var SHOVEL_ID = 3457;        // shovel (client-id)
  var DIG_GIVEUP_MS = 20000;   // zo lang proberen we een gat te graven
  var ACT_WAIT_MS = 3000;      // max wachten op andere verdieping
  var ACT_MAX_TRIES = 2;       // 1 keer proberen + 1 keer opnieuw
  var IDLE_RESEND_MS = 600;    // zo lang stil voordat we opnieuw walkTo sturen
  var OTHER_Z_MAX_REPATHS = 2; // andere z: na 2 mislukte repaths overslaan
  var GAP_MS = 1000;           // langer geen tick (bijv. vechten): timers opnieuw
  var LOOKAHEAD = 8;           // na een gevecht zoveel waypoints vooruit kijken

  var index = 0;
  var pickNearest = true; // bij start: verder bij het dichtstbijzijnde waypoint
  var indexChosen = false; // met "Ga naar deze" gekozen: die gaat voor bij start
  var ended = false;   // route klaar en loop staat uit
  var forceSkip = false; // vastzit-controle: huidig waypoint overslaan
  var lastRoute = null;
  var st = freshState(-1, 0);

  // Nieuwe teller per waypoint.
  function freshState(i, now) {
    return {
      idx: i,
      phase: 'walk',      // walk | stand | act
      walkSent: false,
      lastDist: Infinity,
      lastImproveAt: now,
      repaths: 0,
      stillSince: 0,
      standUntil: 0,
      actAt: 0,
      actStartZ: null,
      actTries: 0,
      sawZ: false,
      digSince: 0,
      digAt: 0,
      enterAt: 0,
      stepOffAt: 0,
      lastTick: now
    };
  }

  function num(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : def;
  }

  // Strikt (config.cavebot.strict): een waypoint is pas klaar als je er
  // hooguit 1 tegel vanaf staat. Geen spawn-straal, niet overslaan na een
  // gevecht of onderweg. Alleen echt onbereikbaar wordt nog overgeslagen.
  var strict = false;

  function cfgOf(ctx) {
    var c = (ctx.config && ctx.config.cavebot) || {};
    strict = c.strict === true;
    return {
      arriveDistance: Math.max(0, num(c.arriveDistance, 0)),
      repathMs: Math.max(500, num(c.repathMs, 3000)),
      maxRepaths: Math.max(0, num(c.maxRepaths, 2)),
      loop: c.loop !== false
    };
  }

  function wpType(wp) {
    var t = wp && wp.type;
    return (t === 'stand' || t === 'rope' || t === 'use' || t === 'floor' || t === 'shovel') ? t : 'walk';
  }

  // Gat graven: naast de stone pile staan, shovel gebruiken, erin stappen.
  // Geeft een resultaat als deze stap de tick afhandelt, anders null.
  function digTick(ctx, wp, p, dist, count, cfg) {
    var now = ctx.now;
    if (!st.digSince) st.digSince = now;
    if (now - st.digSince > DIG_GIVEUP_MS) {
      ctx.log('Gat graven bij waypoint ' + (index + 1) + ' lukt niet. Overgeslagen.');
      skip(ctx, count, cfg);
      return { mode: 'walking', index: index };
    }
    var ground = B.api.groundName(wp.x, wp.y, wp.z);
    if (ground === 'stone pile' && !st.noShovelLogged && !B.api.findItem(SHOVEL_ID)) {
      st.noShovelLogged = true;
      ctx.log('Geen shovel gevonden in een open backpack. Graven lukt zo niet.');
    }
    // Op de stone pile zelf: eerst een stap opzij.
    if (dist === 0 && ground === 'stone pile') {
      if (!st.stepOffAt || now - st.stepOffAt > 1500) {
        st.stepOffAt = now;
        var dirs = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]];
        for (var i = 0; i < dirs.length; i++) {
          var nx = wp.x + dirs[i][0];
          var ny = wp.y + dirs[i][1];
          if (B.api.tileFree(nx, ny, wp.z)) { B.api.walkTo(nx, ny, wp.z); break; }
        }
      }
      return { mode: 'action', index: index };
    }
    if (dist === 1) {
      if (ground === 'stone pile') {
        if (!st.digAt || now - st.digAt > 2000) {
          if (p.isWalking) B.api.cancelWalk();
          st.digAt = now;
          B.api.useItemOnTile(SHOVEL_ID, wp.x, wp.y, wp.z);
        }
      } else if (!st.enterAt || now - st.enterAt > 1500) {
        // Het gat is open: erin stappen.
        st.enterAt = now;
        B.api.walkTo(wp.x, wp.y, wp.z);
      }
      return { mode: 'action', index: index };
    }
    return null; // nog niet in de buurt: gewoon lopen
  }

  // Door naar het volgende waypoint. Aan het eind: lus of routeEnd.
  function next(ctx, count, cfg) {
    index++;
    if (index >= count) {
      index = 0;
      if (!cfg.loop) {
        ended = true;
        ctx.emit('routeEnd', {});
      }
    }
    st = freshState(index, ctx.now);
  }

  function skip(ctx, count, cfg) {
    ctx.log('Waypoint ' + (index + 1) + ' overgeslagen');
    next(ctx, count, cfg);
  }

  // Al voorbij dit looppunt? Dat is zo als je er dichtbij staat (hooguit 4
  // tegels) en dichter bij het volgende punt bent dan dit punt zelf. Dan
  // hoeft de bot niet terug te lopen en gaat hij meteen door.
  function passed(wps, i, p, cfg) {
    if (strict) return false;   // strikt: nooit als 'voorbij' afvinken
    var cur = wps[i];
    if (!cur || wpType(cur) !== 'walk' || cur.z !== p.z) return false;
    var j = i + 1;
    if (j >= wps.length) { if (!cfg.loop) return false; j = 0; }
    var nxt = wps[j];
    if (!nxt || nxt.z !== cur.z) return false;
    var dCur = B.api.distance(p, cur);
    if (!(dCur <= 4)) return false;
    // Verder van het vorige punt dan dit punt zelf. Anders sta je nog vóór
    // dit punt (bijv. in een doodlopende gang) en moet je er wel heen.
    var prev = wps[i - 1 >= 0 ? i - 1 : wps.length - 1];
    if (prev && prev !== cur && prev.z === cur.z && B.api.distance(p, prev) < B.api.distance(cur, prev)) return false;
    // Echt voorbij: je staat aan de kant van het volgende punt. Zo snijdt de
    // bot geen keerpunt af (doodlopende gang, scherpe bocht).
    var ahead = (p.x - cur.x) * (nxt.x - cur.x) + (p.y - cur.y) * (nxt.y - cur.y);
    if (!(ahead > 0)) return false;
    return B.api.distance(p, nxt) < B.api.distance(cur, nxt);
  }

  // Zo vaak als nodig doorschuiven naar het eerste punt dat nog vóór ons ligt.
  function skipPassed(ctx, wps, p, cfg) {
    var start = index;
    var max = Math.min(LOOKAHEAD, wps.length - 1);
    for (var n = 0; n < max && passed(wps, index, p, cfg); n++) {
      var j = index + 1 >= wps.length ? 0 : index + 1;
      if (j === start) break; // nooit rondjes draaien
      index = j;
    }
    if (index === start) return false;
    st = freshState(index, ctx.now);
    return true;
  }

  function walk(wp) {
    try { return B.api.walkTo(wp.x, wp.y, wp.z) === true; } catch (e) { return false; }
  }

  // Touw of use uitvoeren en starten met wachten op een andere z.
  function doAct(ctx, wp, type) {
    if (ctx.player.isWalking) B.api.cancelWalk();
    st.phase = 'act';
    st.actStartZ = ctx.player.z;
    st.actAt = ctx.now;
    st.actTries++;
    if (type === 'rope') B.api.useItemOnTile(ROPE_ID, wp.x, wp.y, wp.z);
    else if (type === 'use') B.api.useTile(wp.x, wp.y, wp.z);
    // floor: één tegel verder stappen in de richting waar je bij het opnemen
    // uitkwam. Daar ligt de trap of het gat. Verder lopen kan achter een muur uitkomen.
    else if (type === 'floor' && wp.toX != null && wp.toY != null) {
      var sx = Math.sign(wp.toX - wp.x);
      var sy = Math.sign(wp.toY - wp.y);
      if (sx || sy) B.api.walkTo(wp.x + sx, wp.y + sy, wp.z);
    }
  }

  // Een spawn-middelpunt (label "spawn ...") of een actie-waypoint mag nooit
  // worden overgeslagen: daar moet de bot echt heen.
  var SPAWN_RADIUS = 5; // binnen zoveel tegels van het midden telt een spawn als gedaan
  function isSpawn(wp) {
    return !!wp && wpType(wp) === 'walk' && /^spawn/i.test(String(wp.label || ''));
  }
  function mustVisit(wp, p) {
    if (strict && wp && wpType(wp) === 'walk') return !(p && wp.z === p.z && B.api.distance(p, wp) <= 1);
    if (!wp || wpType(wp) !== 'walk') return true;
    if (!isSpawn(wp)) return false;
    // Al in de spawn geweest (binnen SPAWN_RADIUS)? Dan hoeft hij niet meer naar het midden.
    return !(p && wp.z === p.z && B.api.distance(p, wp) <= SPAWN_RADIUS);
  }

  // Na een gevecht: niet teruglopen. Ligt het huidige waypoint niet op de weg
  // naar het volgende (omweg van meer dan DETOUR_SLACK tegels)? Dan meteen door
  // naar het volgende. Alleen gewone loop-waypoints, nooit trap, touw of actie.
  var DETOUR_SLACK = 2;
  function skipDetours(ctx, wps, p, cfg) {
    var start = index;
    for (var n = 0; n < LOOKAHEAD; n++) {
      var cur = wps[index];
      if (!cur || mustVisit(cur, p) || cur.z !== p.z) break;
      var j = index + 1;
      if (j >= wps.length) { if (!cfg.loop) break; j = 0; }
      if (j === start) break;
      var nxt = wps[j];
      if (!nxt || wpType(nxt) !== 'walk' || nxt.z !== cur.z) break;
      var dCur = B.api.distance(p, cur);
      if (!(dCur >= 2)) break; // je staat er al (bijna): gewoon afmaken
      // Alleen overslaan als je al voorbij dit punt bent (gezien vanaf het
      // vorige punt). Sta je er nog vóór, bijv. in een doodlopende gang, dan
      // eerst het eind van de gang halen.
      var prev = wps[index - 1 >= 0 ? index - 1 : wps.length - 1];
      if (prev && prev !== cur && prev.z === cur.z) {
        var past = (p.x - cur.x) * (cur.x - prev.x) + (p.y - cur.y) * (cur.y - prev.y);
        if (past < 0) break;
      }
      var detour = dCur + B.api.distance(cur, nxt) - B.api.distance(p, nxt);
      if (!(detour > DETOUR_SLACK)) break;
      index = j;
    }
    if (index === start) return false;
    st = freshState(index, ctx.now);
    return true;
  }

  // Na een gevecht: zoek in de komende waypoints het punt dat het dichtst bij
  // de speler ligt en ga daar verder. We kijken niet verder dan het eerste
  // actie-waypoint (stand, rope, use, floor), zodat die nooit worden overgeslagen.
  function resync(ctx, wps, p, cfg) {
    var best = index;
    var bestDist = B.api.distance(p, wps[index]);
    for (var k = 1; k <= LOOKAHEAD; k++) {
      var j = index + k;
      if (j >= wps.length) {
        if (!cfg.loop) break;
        j = j % wps.length;
      }
      if (j === index) break;
      var d = B.api.distance(p, wps[j]);
      if (isFinite(d) && d <= bestDist) { best = j; bestDist = d; }
      if (mustVisit(wps[j], p)) break;
    }
    if (mustVisit(wps[index], p)) return false;
    var from = index;
    if (best !== index) { index = best; st = freshState(index, ctx.now); }
    skipDetours(ctx, wps, p, cfg);
    skipPassed(ctx, wps, p, cfg);
    if (index === from) return false;
    ctx.log('Na het gevecht verder bij waypoint ' + (index + 1) + ' in plaats van ' + (from + 1) + '.');
    return true;
  }

  function tickInner(ctx) {
    var wps = ctx.route && ctx.route.waypoints;
    if (!wps || !wps.length) return { mode: 'idle', index: index };

    // Andere route (of bewerkt): teller opnieuw, index binnen de lijst houden.
    if (ctx.route !== lastRoute) {
      lastRoute = ctx.route;
      ended = false;
      forceSkip = false;
      if (index >= wps.length) index = 0;
      st = freshState(index, ctx.now);
    }
    if (index >= wps.length || index < 0) index = 0;
    if (ended) return { mode: 'idle', index: index };

    var p = ctx.player;
    if (!p) return { mode: 'idle', index: index };

    var now = ctx.now;
    var cfg = cfgOf(ctx);
    var count = wps.length;

    // Net gestart: niet terug naar het begin, maar verder bij het waypoint
    // dat het dichtst bij de speler ligt (zelfde verdieping).
    // Een gekozen waypoint geldt maar één keer: daarna weer gewoon.
    if (indexChosen) indexChosen = false;
    if (pickNearest) {
      pickNearest = false;
      var bestJ = -1;
      var bestD = Infinity;
      for (var j = 0; j < count; j++) {
        var dj = B.api.distance(p, wps[j]);
        if (dj < bestD) { bestD = dj; bestJ = j; }
      }
      if (bestJ >= 0 && bestJ !== index) {
        index = bestJ;
        st = freshState(index, now);
        skipPassed(ctx, wps, p, cfg);
        ctx.log('Verder bij waypoint ' + (index + 1) + ', dat ligt het dichtst bij.');
      }
    }
    // Vastzit-controle vroeg om dit waypoint over te slaan.
    if (forceSkip) {
      forceSkip = false;
      skip(ctx, count, cfg);
      if (ended) return { mode: 'idle', index: index };
    }
    var wp = wps[index];
    var type = wpType(wp);

    if (st.idx !== index) st = freshState(index, now);

    // Lang geen tick gehad (bijv. tijdens vechten): eerst kijken of een
    // waypoint verderop dichterbij ligt, zodat we niet teruglopen.
    if (now - st.lastTick > GAP_MS && st.phase === 'walk') {
      if (resync(ctx, wps, p, cfg)) {
        wp = wps[index];
        type = wpType(wp);
      }
    }

    // Timers opnieuw starten en opnieuw lopen, anders telt de vecht-tijd
    // als vastlopen.
    if (now - st.lastTick > GAP_MS) {
      st.walkSent = false;
      st.lastDist = Infinity;
      st.lastImproveAt = now;
      st.stillSince = 0;
      if (st.phase === 'act') st.actAt = now;
      // Gevecht naast een gat telt niet als "graven mislukt".
      st.digSince = 0;
      st.digAt = 0;
    }
    st.lastTick = now;

    var dist = B.api.distance(p, wp);

    // Trap, gat of ramp: klaar zodra we van verdieping wisselen nadat we
    // op de verdieping van het waypoint stonden.
    if (type === 'floor' || type === 'shovel') {
      if (p.z === wp.z) st.sawZ = true;
      else if (st.sawZ) {
        next(ctx, count, cfg);
        return { mode: 'action', index: index };
      }
    }

    // Wachten op een andere verdieping na touw of use.
    if (st.phase === 'act') {
      if (p.z !== st.actStartZ) {
        next(ctx, count, cfg);
        return { mode: 'action', index: index };
      }
      if (now - st.actAt >= ACT_WAIT_MS) {
        if (st.actTries >= ACT_MAX_TRIES) {
          skip(ctx, count, cfg);
          return { mode: 'walking', index: index };
        }
        if (dist <= 1) {
          doAct(ctx, wp, type);
        } else {
          // Weggeduwd: eerst weer naar het gat lopen, pogingen blijven staan.
          st.phase = 'walk';
          st.walkSent = false;
          st.lastDist = Infinity;
          st.lastImproveAt = now;
        }
      }
      return { mode: st.phase === 'act' ? 'action' : 'walking', index: index };
    }

    // Stand: even blijven staan na aankomst.
    if (st.phase === 'stand') {
      if (now >= st.standUntil) next(ctx, count, cfg);
      return { mode: 'action', index: index };
    }

    // Gat graven: bij een shovel-waypoint, of bij een trap/gat-waypoint waar
    // de grond een stone pile is (dicht gat).
    if (p.z === wp.z && dist <= 1 && (type === 'shovel' || (type === 'floor' && B.api.groundName(wp.x, wp.y, wp.z) === 'stone pile') || st.digSince)) {
      var dr = digTick(ctx, wp, p, dist, count, cfg);
      if (dr) return dr;
    }

    // Voorbij een looppunt (bijv. omgelopen voor een monster)? Niet teruglopen.
    // Meteen in dezelfde ronde naar het nieuwe punt lopen.
    if (type === 'walk' && st.phase === 'walk' && skipPassed(ctx, wps, p, cfg)) {
      wp = wps[index];
      type = wpType(wp);
      dist = B.api.distance(p, wp);
    }

    // Aangekomen? Een looppunt telt al binnen 1 tegel, dan loopt de bot
    // zonder stil te staan door naar het volgende punt.
    var need = (type === 'rope' || type === 'use') ? 1 : ((type === 'floor' || type === 'shovel') ? 0 : (type === 'walk' ? Math.max(1, cfg.arriveDistance) : cfg.arriveDistance));
    // Spawn-middelpunt: binnen SPAWN_RADIUS is goed genoeg, de monsters komen toch naar je toe.
    if (isSpawn(wp) && p.z === wp.z && !strict) need = Math.max(need, SPAWN_RADIUS);
    if (dist <= need) {
      if (type === 'walk') {
        next(ctx, count, cfg);
        return { mode: 'walking', index: index };
      }
      if (type === 'stand') {
        if (p.isWalking) B.api.cancelWalk();
        st.phase = 'stand';
        st.standUntil = now + Math.max(0, num(wp.waitMs, 1000));
        return { mode: 'action', index: index };
      }
      doAct(ctx, wp, type);
      return { mode: 'action', index: index };
    }

    // Voortgang meten: de afstand moet dalen.
    if (dist < st.lastDist) {
      st.lastDist = dist;
      st.lastImproveAt = now;
      st.repaths = 0;
    }

    var otherZ = wp.z !== p.z;
    var maxRepaths = otherZ ? OTHER_Z_MAX_REPATHS : cfg.maxRepaths;

    // Eerste keer naar dit waypoint.
    if (!st.walkSent) {
      walk(wp);
      st.walkSent = true;
      st.stillSince = 0;
      st.lastImproveAt = now;
      return { mode: 'walking', index: index };
    }

    // Geen voortgang binnen repathMs: repath, of overslaan.
    if (now - st.lastImproveAt >= cfg.repathMs) {
      if (st.repaths >= maxRepaths) {
        skip(ctx, count, cfg);
        return { mode: 'walking', index: index };
      }
      st.repaths++;
      st.lastImproveAt = now;
      st.stillSince = 0;
      walk(wp);
      return { mode: 'walking', index: index };
    }

    // Speler staat echt stil (niet lopen én niet van tegel gewisseld) maar is
    // er nog niet: na 600 ms opnieuw sturen. Tussen twee stappen is het
    // loop-vlaggetje soms even uit. Opnieuw sturen kiest dan soms een andere,
    // even lange weg en dan lijkt de bot te twijfelen. Dat voorkomen we zo.
    var posKey = p.x + ',' + p.y + ',' + p.z;
    if (posKey !== st.lastPosKey) { st.lastPosKey = posKey; st.lastPosAt = now; }
    if (!p.isWalking && now - (st.lastPosAt || now) >= IDLE_RESEND_MS) {
      if (!st.stillSince) {
        st.stillSince = now;
      } else if (now - st.stillSince >= IDLE_RESEND_MS) {
        walk(wp);
        st.stillSince = now;
      }
    } else {
      st.stillSince = 0;
    }

    return { mode: 'walking', index: index };
  }

  B.cavebot = {
    tick: function (ctx) {
      try {
        return tickInner(ctx);
      } catch (e) {
        try { ctx.log('Cavebot fout: ' + (e && e.message ? e.message : e)); } catch (e2) { /* niets */ }
        return { mode: 'idle', index: index };
      }
    },
    // Naar een bepaald waypoint springen. Teller begint opnieuw.
    setIndex: function (i) {
      var n = parseInt(i, 10);
      index = isFinite(n) && n >= 0 ? n : 0;
      ended = false;
      pickNearest = false; // gekozen waypoint gaat voor
      forceSkip = false;
      indexChosen = true;
      st = freshState(index, Date.now());
    },
    // Huidig waypoint overslaan (bij de volgende tick).
    skipCurrent: function () { forceSkip = true; },
    // Na een gevecht meteen weer lopen: de aanval heeft het lopen gestopt, dus
    // de vorige loopopdracht is weg. Niet eerst 1,2 s stilstaan.
    kick: function () {
      if (st && st.phase === 'walk') { st.walkSent = false; st.stillSince = 0; st.lastImproveAt = Date.now(); }
    },
    phase: function () { return st.phase; },
    getIndex: function () {
      return index;
    },
    // Terug naar het begin.
    // Opnieuw beginnen: bij de volgende tick kiezen we het dichtstbijzijnde waypoint.
    // fresh = true: echt opnieuw (bijv. andere route), index terug naar 0.
    reset: function (fresh) {
      if (fresh) { index = 0; indexChosen = false; }
      ended = false;
      forceSkip = false;
      lastRoute = null;
      pickNearest = !indexChosen;
      st = freshState(indexChosen ? index : -1, Date.now());
    }
  };
})(window.WJBot = window.WJBot || {});
