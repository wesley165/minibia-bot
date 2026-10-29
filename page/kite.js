(function (B) {
  'use strict';

  // Schuin lopen duurt in het spel veel langer dan recht. Strafpunten per schuine stap
  // (1000 = één tegel verder van een monster, dus afstand gaat altijd voor).
  var DIAG = 300;

  // Afstand houden (voor een paladin): tijdens het vechten blijft de speler
  // op keepDistance tegels van elk monster. Komt een monster dichterbij, dan
  // zet de bot één stap weg. Staat het doel te ver weg, dan één stap ernaartoe.
  // Aan met config.targeting.keepDistance (bijv. 2). 0 of leeg = uit.
  // Gebruikt alleen B.api en ctx, nooit gameClient zelf.

  var STEP_GAP_MS = 150;    // niet vaker dan dit een stap sturen
  var lastStep = 0;
  var chaseSet = false;     // chase al op stand gezet in deze run
  var why = '';             // laatste reden (voor controle via WJBot.kite.why())
  var trail = [];           // laatste tegels waar we liepen (oudste eerst)
  var TRAIL_MAX = 40;
  var trailSet = {};

  // Onthoud waar we vandaan komen (engine roept dit elke tick aan).
  function note(p) {
    if (!p || p.x == null) return;
    var last = trail[trail.length - 1];
    if (last && last.x === p.x && last.y === p.y && last.z === p.z) return;
    trail.push({ x: p.x, y: p.y, z: p.z });
    if (trail.length > TRAIL_MAX) trail.shift();
    trailSet = {};
    for (var i = 0; i < trail.length; i++) trailSet[trail[i].x + ',' + trail[i].y + ',' + trail[i].z] = true;
  }

  // Bonus voor een tegel op of naast ons eigen pad: daar komen we vandaan,
  // daar is al opgeruimd. Kleiner dan het verschil in veiligheid (1000 per tegel).
  function cameFrom(x, y, z, list) {
    // Alleen als het daar echt rustig is: geen monster binnen 4 tegels.
    if (list && minDist(x, y, z, list) <= 4) return 0;
    if (trailSet[x + ',' + y + ',' + z]) return 300;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      if (trailSet[(x + dx) + ',' + (y + dy) + ',' + z]) return 150;
    }
    return 0;
  }

  function num(v, standaard) {
    return typeof v === 'number' && isFinite(v) ? v : standaard;
  }

  // Monsters die ons kunnen raken: levend, zelfde verdieping, geen speler of NPC.
  function threats(ctx) {
    var me = ctx.player;
    var cfg = (ctx.config && ctx.config.targeting) || {};
    var ign = (Array.isArray(cfg.ignoreNames) ? cfg.ignoreNames : []).map(function (n) { return String(n).toLowerCase(); });
    return (ctx.creatures || []).filter(function (c) {
      return c && c.id !== me.id && c.type === 1 && c.hpPct > 0 && c.z === me.z && ign.indexOf(String(c.name).toLowerCase()) < 0;
    });
  }

  // Drukte rond een tegel: elk monster binnen 4 tegels telt mee, dichterbij zwaarder.
  // Zo kiest de bot niet een plek vlak bij een groep, ook al is één monster ver.
  function crowd(x, y, z, list) {
    var c = 0;
    for (var i = 0; i < list.length; i++) {
      var d = B.api.distance({ x: x, y: y, z: z }, list[i]);
      if (d <= 4) c += 5 - d;
    }
    return c;
  }

  // Vuurgolf ontwijken (bijv. Dragon): een golf gaat recht vooruit en wordt breder
  // met de afstand. Een tegel ligt 'in de lijn' als de kleine afwijking hooguit de
  // helft is van de grote. Schuin (|dx| = |dy|) is altijd veilig.
  var extra = {};   // naam (kleine letters) -> extra tegels afstand
  var avoid = [];   // monsters (namen, kleine letters) uit config.targeting.avoidLine
  // Hoe diep staat een tegel in de vuurlijn? 0 = erbuiten. Hoe groter, hoe meer
  // in het midden. Zo kan de bot stap voor stap naar de rand en eruit.
  function coneDepth(x, y, z, list) {
    var worst = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (avoid.indexOf(String(m.name || '').toLowerCase()) < 0 || m.z !== z) continue;
      var dx = Math.abs(x - m.x), dy = Math.abs(y - m.y);
      var big = Math.max(dx, dy), small = Math.min(dx, dy);
      if (big < 1 || big > 8) continue;
      var d = Math.floor((big - 1) / 2) - small + 1;   // >0: in de golf
      if (d > worst) worst = d;
    }
    return worst;
  }
  function inCone(x, y, z, list) { return coneDepth(x, y, z, list) > 0; }

  // Kleinste afstand van een tegel tot alle monsters.
  function minDist(x, y, z, list) {
    var best = Infinity;
    for (var i = 0; i < list.length; i++) {
      // Per monster extra afstand (config.targeting.extraDistance): telt alsof hij dichterbij staat.
      var d = B.api.distance({ x: x, y: y, z: z }, list[i]) - (extra[String(list[i].name).toLowerCase()] || 0);
      if (d < best) best = d;
    }
    return best;
  }

  // Vluchtrichting vasthouden: bij twee monsters rende de bot anders heen en weer.
  // Na een vluchtstap blijft de gekozen richting een paar seconden 'vast'. Een stap
  // terug (tegen die richting in) kost veel punten; alleen als het écht moet.
  var flee = null;           // { dx, dy, until }
  var FLEE_MS = 4000;
  function fleeBonus(dx, dy) {
    if (!flee || Date.now() > flee.until) return 0;
    var dot = dx * flee.dx + dy * flee.dy;
    return dot > 0 ? 300 : dot < 0 ? -1500 : -200;
  }
  // Lokken: bij het weglopen liefst richting deze plek (bijv. de trap bij de tempel).
  var home = null;
  function homeBonus(x, y, me) {
    if (!home || home.z !== me.z) return 0;
    var now = Math.max(Math.abs(me.x - home.x), Math.abs(me.y - home.y));
    var then = Math.max(Math.abs(x - home.x), Math.abs(y - home.y));
    return (now - then) * 350;
  }
  function noteFlee(step) {
    var now = Date.now();
    if (flee && now <= flee.until && step.dx * flee.dx + step.dy * flee.dy >= 0) {
      flee.until = now + FLEE_MS;    // zelfde kant (of zijstap): kant houden en verlengen
    } else {
      flee = { dx: step.dx, dy: step.dy, until: now + FLEE_MS };   // eerste keuze, of het moest echt
    }
  }


  // Beste buurtegel kiezen. Score: zo ver mogelijk van monsters (tot keep),
  // het doel binnen schietafstand, liefst recht (schuin lopen is trager).
  function bestStep(me, list, target, keep, range, wantCloser) {
    var hereMin = minDist(me.x, me.y, me.z, list);
    var hereT = target ? B.api.distance(me, target) : 0;
    var best = null;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        var x = me.x + dx, y = me.y + dy;
        if (!B.api.tileFree(x, y, me.z)) continue;
        if (B.api.dangerTile && B.api.dangerTile(x, y, me.z)) continue;   // gat of trap: daar val je door
        var m = minDist(x, y, me.z, list);
        var t = target ? B.api.distance({ x: x, y: y, z: me.z }, target) : 0;
        if (target && t > range) continue;              // doel niet uit bereik lopen
        if (wantCloser) {
          if (!(t < hereT) || m < keep) continue;       // dichterbij, maar niet te dichtbij
        } else if (!(m > hereMin)) continue;            // alleen weg als het beter wordt
        var score = Math.min(m, keep) * 1000 - (dx && dy ? DIAG : 0) - t - crowd(x, y, me.z, list) * 150 + cameFrom(x, y, me.z, list)
          + (wantCloser ? 0 : fleeBonus(dx, dy) + homeBonus(x, y, me))
          - (inCone(x, y, me.z, list) ? 400 : 0);
        if (!best || score > best.score) best = { dx: dx, dy: dy, score: score };
      }
    }
    return best;
  }

  // Vluchtpad: zoek binnen DEPTH stappen de vrije plek die het verst van de
  // monsters ligt (tot keep) en geef de eerste stap ernaartoe. Zo komt de bot
  // ook weg als hij met zijn rug tegen een muur staat: dan eerst opzij langs de muur.
  var DEPTH = 5;
  function escapeStep(me, list, target, keep, range) {
    var hereMin = minDist(me.x, me.y, me.z, list);
    var hereCrowd = crowd(me.x, me.y, me.z, list);
    var floor = Math.max(1, Math.min(hereMin, keep - 1));  // onderweg niet dichter dan dit
    var key = function (x, y) { return x + ',' + y; };
    var seen = {};
    seen[key(me.x, me.y)] = true;
    var queue = [{ x: me.x, y: me.y, d: 0, diag: 0, first: null }];
    var best = null;
    while (queue.length) {
      var n = queue.shift();
      if (n.first) {
        var m = minDist(n.x, n.y, me.z, list);
        var t = target ? B.api.distance({ x: n.x, y: n.y, z: me.z }, target) : 0;
        if (!target || t <= range) {
          // Liefst ver weg (tot keep), dan zo kort mogelijk lopen, dan recht.
          var score = Math.min(m, keep) * 1000 - n.d * 10 - (n.first.dx && n.first.dy ? DIAG : 0) - n.diag * (DIAG / 3)
            - crowd(n.x, n.y, me.z, list) * 150
            - (inCone(n.x, n.y, me.z, list) ? 400 : 0)
            + fleeBonus(n.first.dx, n.first.dy) + homeBonus(me.x + n.first.dx, me.y + n.first.dy, me)
            + cameFrom(n.x, n.y, me.z, list) + cameFrom(me.x + n.first.dx, me.y + n.first.dy, me.z, list) / 2
            + Math.min(minDist(me.x + n.first.dx, me.y + n.first.dy, me.z, list), keep) * 60;   // eerste stap liefst al weg
          // Beter = verder van het dichtstbijzijnde monster, of even ver maar rustiger (minder drukte).
          var better = m > hereMin || (m === hereMin && crowd(n.x, n.y, me.z, list) < hereCrowd);
          if (better && (!best || score > best.score)) best = { score: score, dx: n.first.dx, dy: n.first.dy };
        }
      }
      if (n.d >= DEPTH) continue;
      // Buren; vanaf de start de veiligste eerst, zodat elke plek bereikt wordt
      // via de veiligste eerste stap (BFS onthoudt de eerste route die hij vindt).
      // Rechte stappen eerst: dan vindt de zoektocht liefst een pad zonder schuine stappen.
      var nb = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]];
      if (n.d === 0) nb.sort(function (a, b) {
        return (minDist(me.x + b[0], me.y + b[1], me.z, list) - minDist(me.x + a[0], me.y + a[1], me.z, list)) ||
          ((a[0] && a[1] ? 1 : 0) - (b[0] && b[1] ? 1 : 0));
      });
      for (var bi = 0; bi < nb.length; bi++) {
        {
          var dx = nb[bi][0], dy = nb[bi][1];
          var x = n.x + dx, y = n.y + dy;
          if (seen[key(x, y)]) continue;
          seen[key(x, y)] = true;
          if (!B.api.tileFree(x, y, me.z)) continue;
          if (B.api.dangerTile && B.api.dangerTile(x, y, me.z)) continue;   // gat of trap
          if (minDist(x, y, me.z, list) < floor) continue;
          queue.push({ x: x, y: y, d: n.d + 1, diag: n.diag + (dx && dy ? 1 : 0), first: n.first || { dx: dx, dy: dy } });
        }
      }
    }
    return best;
  }


  // Recht voor het doel gaan staan. Schuin achter een muurhoek kan de bot niet
  // schieten. Dan één stap naar een tegel in dezelfde rij of kolom als het doel,
  // met een vrije schietlijn, zonder dichter bij monsters te komen dan nu (of keep).
  var aimHp = null;          // { id, hp, since }: hoe lang raakt de bot het doel al niet
  function aimStep(ctx, me, list, target, keep, range) {
    if (!target) return null;
    var now = ctx.now;
    if (!aimHp || aimHp.id !== target.id || target.hpPct < aimHp.hp) aimHp = { id: target.id, hp: target.hpPct, since: now };
    var here = { x: me.x, y: me.y, z: me.z };
    var aligned = me.x === target.x || me.y === target.y;
    var shot = B.api.clearShot ? B.api.clearShot(here, target) : true;
    // Alleen verplaatsen als hij nu geen vrije lijn heeft, of schuin staat en al 1,5 s niet raakt.
    if (shot && (aligned || now - aimHp.since < 1500)) return null;
    var hm = minDist(me.x, me.y, me.z, list);
    var floor = Math.min(hm, keep);
    // Zoek binnen 4 stappen een tegel recht voor het doel (zelfde rij of kolom) met een
    // vrije schietlijn. Schuin langs een muur schieten lukt vaak niet. De eerste stap
    // van het kortste pad ernaartoe wordt gezet; rechte stappen eerst.
    var NB = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]];
    var seen = {}; seen[me.x + ',' + me.y] = true;
    var queue = [{ x: me.x, y: me.y, d: 0, first: null }];
    var best = null;
    while (queue.length) {
      var n = queue.shift();
      if (n.first) {
        var p = { x: n.x, y: n.y, z: me.z };
        var m = minDist(n.x, n.y, me.z, list);
        var t = B.api.distance(p, target);
        var al = n.x === target.x || n.y === target.y;
        if (m >= floor && t <= range && (B.api.clearShot ? B.api.clearShot(p, target) : true)) {
          var sc = (al ? 500 : 0) - n.d * 60 + Math.min(m, keep) * 100 - (n.first.dx && n.first.dy ? DIAG : 0) - crowd(n.x, n.y, me.z, list) * 20;
          if (!best || sc > best.sc) best = { dx: n.first.dx, dy: n.first.dy, sc: sc, al: al };
        }
      }
      if (n.d >= 4) continue;
      for (var k = 0; k < NB.length; k++) {
        var x = n.x + NB[k][0], y = n.y + NB[k][1], key = x + ',' + y;
        if (seen[key]) continue;
        seen[key] = true;
        if (!B.api.tileFree(x, y, me.z) || (B.api.dangerTile && B.api.dangerTile(x, y, me.z))) continue;
        if (minDist(x, y, me.z, list) < floor) continue;
        queue.push({ x: x, y: y, d: n.d + 1, first: n.first || { dx: NB[k][0], dy: NB[k][1] } });
      }
    }
    // Alleen een stap als het echt beter wordt: vrije lijn erbij, of recht gaan staan.
    if (!best || (shot && !best.al)) return null;
    return best;
  }

  // Elke tick tijdens het vechten. Geeft true als er een stap is gezet.
  function tick(ctx, targetId) {
    try {
      var cfg = (ctx.config && ctx.config.targeting) || {};
      home = ctx.kiteHome || null;
      var keep = num(cfg.keepDistance, 0);
      extra = {};
      var ex = cfg.extraDistance || {};
      for (var en in ex) if (Number(ex[en]) > 0) extra[String(en).toLowerCase()] = Number(ex[en]);
      avoid = (Array.isArray(cfg.avoidLine) ? cfg.avoidLine : []).map(function (n) { return String(n).toLowerCase(); });
      if (!(keep >= 1)) { chaseSet = false; return false; }
      var me = ctx.player;
      if (!me) return false;

      // Chase op stand, anders loopt het spel zelf naar het monster toe.
      if (!chaseSet || B.api.chaseMode() !== 0) {
        if (B.api.chaseMode() !== 0) B.api.setChaseMode(0);
        chaseSet = true;
      }

      if (me.isWalking) { why = 'loopt al'; return false; }
      if (ctx.now - lastStep < STEP_GAP_MS) { why = 'wacht'; return false; }
      var list = threats(ctx);
      if (!list.length) { why = 'geen monsters'; return false; }
      var target = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === targetId) target = list[i];
      // Verder dan range: een stap naar het doel toe (nooit binnen keep). Standaard = keep.
      var range = Math.max(keep, num(cfg.kiteRange, keep));

      var step = null;
      if (minDist(me.x, me.y, me.z, list) < keep) {
        var fleeRange = Math.max(range + 2, target ? B.api.distance(me, target) + 1 : range);
        step = escapeStep(me, list, target, keep, fleeRange) || bestStep(me, list, target, keep, fleeRange, false);
        if (step) noteFlee(step);
      } else if (target && B.api.distance(me, target) > range) {
        step = bestStep(me, list, target, keep, Infinity, true);
      }
      if (!step && avoid.length && inCone(me.x, me.y, me.z, list)) {
        // In de vuurlijn: één stap opzij naar een tegel buiten de lijn, niet dichterbij.
        var hm = minDist(me.x, me.y, me.z, list), best2 = null;
        var hereDepth = coneDepth(me.x, me.y, me.z, list);
        for (var sx = -1; sx <= 1; sx++) for (var sy = -1; sy <= 1; sy++) {
          if (!sx && !sy) continue;
          var nx = me.x + sx, ny = me.y + sy;
          if (!B.api.tileFree(nx, ny, me.z) || (B.api.dangerTile && B.api.dangerTile(nx, ny, me.z))) continue;
          var cd = coneDepth(nx, ny, me.z, list);
          if (cd >= hereDepth) continue;            // alleen als het beter wordt (richting de rand)
          var nm = minDist(nx, ny, me.z, list);
          if (nm < Math.min(hm, keep)) continue;
          if (target && B.api.distance({ x: nx, y: ny, z: me.z }, target) > range + 1) continue;
          var sc = Math.min(nm, keep) * 10 - cd * 20 - (sx && sy ? 15 : 0);
          if (!best2 || sc > best2.sc) best2 = { dx: sx, dy: sy, sc: sc };
        }
        if (best2) step = best2;
      }
      if (!step && target) {
        var aim = aimStep(ctx, me, list, target, keep, Math.max(range, num(cfg.maxDistance, range)));
        if (aim) { step = aim; why = 'recht voor het doel'; }
      }
      var md = minDist(me.x, me.y, me.z, list);
      if (!step) { why = 'geen stap (dichtstbij ' + md + ', doel ' + (target ? B.api.distance(me, target) : '-') + ')'; return false; }
      if (B.api.step(step.dx, step.dy)) { lastStep = ctx.now; why = 'stap ' + step.dx + ',' + step.dy + ' (dichtstbij ' + md + ')'; return true; }
      why = 'stap geweigerd';
      return false;
    } catch (e) {
      if (ctx && typeof ctx.log === 'function') ctx.log('Fout in afstand houden: ' + (e && e.message));
      return false;
    }
  }

  function reset() {
    lastStep = 0;
    chaseSet = false;
    trail = [];
    trailSet = {};
  }

  B.kite = { tick: tick, reset: reset, note: note, why: function () { return why; } };
})(window.WJBot = window.WJBot || {});
