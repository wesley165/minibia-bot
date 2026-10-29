(function (B) {
  'use strict';

  // Targeting: kiest elke tick opnieuw het beste monster en valt het aan.
  // Gebruikt alleen B.api en ctx, nooit gameClient zelf.

  var STICKY_BONUS = 4200;      // bonus om bij het huidige doel te blijven
  var DIST_PENALTY = 240;       // straf per tegel afstand
  var WOUND_FACTOR = 4;         // (100 - hpPct) x 4 voor gewonde monsters
  var PRIORITY_FACTOR = 500;    // prioriteit 1 = belangrijkst, 10 = minst belangrijk
  var CHASE_HP_PCT = 30;        // doel met zo weinig HP (vlucht vaak) niet loslaten voor een ander
  var ALWAYS_BONUS = 100000;    // monster met always: true gaat altijd voor (ook voor het huidige doel)
  var ATTACK_GAP_MS = 400;      // max 1 attack-poging per 400 ms per doel
  var KILL_MEMORY_MS = 60000;   // zo lang onthouden we een getelde kill
  var FINISH_MS = 8000;         // zo lang achter een bijna dood doel aan dat buiten beeld of te ver vlucht

  var cooldown = new Map();     // id -> tijd tot wanneer we hem overslaan
  var noApproach = new Map();   // id -> tijd: niet naartoe lopen (buiten beeld), wel aanvallen als hij komt
  var approach = null;          // { id, since }: monster net buiten beeld waar we naartoe lopen
  var finish = null;            // { id, until }: bijna dood doel (<= CHASE_HP_PCT) dat we willen afmaken
  var APPROACH_GIVEUP_MS = 6000;   // zo lang proberen we een monster buiten beeld te bereiken
  var APPROACH_COOLDOWN_MS = 45000;

  // Monster uit de lijst dat we nog niet kunnen aanvallen omdat het net buiten
  // beeld staat, of wel in beeld maar verder dan maxDistance (zelfde verdieping,
  // binnen approachDistance). Geeft het dichtstbijzijnde terug.
  function offscreen(ctx, cfg) {
    var me = ctx.player;
    var maxD = num(cfg.approachDistance, 10);
    var attackD = num(cfg.maxDistance, 7);
    if (!(maxD > 0)) return null;
    var names = {};
    (cfg.monsters || []).forEach(function (m) { if (m && m.name) names[lower(m.name)] = true; });
    var best = null;
    var same = null; // het monster waar we al naartoe lopen
    (ctx.creatures || []).forEach(function (c) {
      if (!c || c.type !== 1 || !(c.hpPct > 0) || c.masterId) return;
      var dying = c.hpPct <= CHASE_HP_PCT;   // bijna dood: altijd proberen af te maken
      if (c.z !== me.z || (cooldown.has(c.id) && !dying)) return;
      if (noApproach.has(c.id) && noApproach.get(c.id) > ctx.now) return;
      if (!cfg.attackAll && !names[lower(c.name)]) return;
      if (ignored(cfg, lower(c.name))) return;
      if (nearLimit(cfg, c.name) !== null) return; // daar lopen we niet naartoe
      var d = B.api.distance(me, c);
      if (!(d <= maxD)) return;
      // In beeld en dichtbij genoeg: dat doet de gewone targeting al.
      if (c.canSee !== false && c.los !== false && d <= attackD) return;
      // Muur ertussen: niet naartoe lopen, anders pendelt de bot tussen route en
      // monster. Alleen een bijna dood monster vlakbij nog afmaken.
      if (c.canSee !== false && c.los === false && !(dying && d <= 4)) return;
      // Alleen erheen als er echt een looppad is dat niet veel langer is dan
      // de rechte afstand (niet helemaal om een muur of over een gat heen).
      if (!walkableTo(c, d, ctx.now)) return;
      if (finish && finish.id === c.id && finish.until > ctx.now) { same = { c: c, d: d }; return; }
      if (approach && approach.id === c.id && !(same && finish && same.c.id === finish.id)) same = { c: c, d: d };
      if (!best || d < best.d) best = { c: c, d: d };
    });
    // Niet steeds van monster wisselen: houd het huidige vast zolang het er is.
    // Anders klikt de bot elke seconde een andere kant op en maakt niets af.
    return same || best;
  }
  // Looppad-controle, per monster 2 seconden onthouden (rekenen kost wat).
  var walkCache = new Map();    // id -> { at, ok }
  function walkableTo(c, d, now) {
    var hit = walkCache.get(c.id);
    if (hit && now - hit.at < 2000) return hit.ok;
    var len = B.api.walkDistance ? B.api.walkDistance(c) : 0;
    var ok = len <= Math.max(d + 6, d * 2) && len <= 20;
    walkCache.set(c.id, { at: now, ok: ok });
    if (walkCache.size > 50) walkCache.clear();
    return ok;
  }
  var lastAttack = new Map();   // id -> tijd van laatste attack-poging
  var minHp = new Map();        // id -> laagste hpPct gezien als doel
  var killed = new Map();       // id -> tijd van getelde kill (niet dubbel tellen)
  var track = null;             // { id, since, dist, hp } voor onbereikbaar-check
  var prev = null;              // { id, name } doel van de vorige tick

  function lower(s) {
    return String(s || '').toLowerCase();
  }

  // Monsters die je alleen van dichtbij wilt (config.targeting.nearOnly:
  // [{ name: 'Slime', maxDistance: 2 }]). Geeft de grens of null.
  function nearLimit(cfg, name) {
    var list = (cfg && Array.isArray(cfg.nearOnly)) ? cfg.nearOnly : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && lower(list[i].name) === lower(name)) return num(list[i].maxDistance, 2);
    }
    return null;
  }

  function num(v, standaard) {
    return typeof v === 'number' && isFinite(v) ? v : standaard;
  }

  // Monsterlijst uit config als map: naam (kleine letters) -> prioriteit.
  function monsterMap(cfg) {
    var map = new Map();
    var list = (cfg && Array.isArray(cfg.monsters)) ? cfg.monsters : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || !m.name) continue;
      map.set(lower(m.name), num(m.priority, 1));
    }
    return map;
  }

  // Monsters die altijd voorgaan (always: true in de lijst), in kleine letters.
  function alwaysSet(cfg) {
    var set = new Set();
    var list = (cfg && Array.isArray(cfg.monsters)) ? cfg.monsters : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name && list[i].always) set.add(lower(list[i].name));
    }
    return set;
  }

  // Oude regels in de maps opruimen.
  function cleanup(now) {
    cooldown.forEach(function (until, id) { if (now >= until) cooldown.delete(id); });
    noApproach.forEach(function (until, id) { if (now >= until) noApproach.delete(id); });
    lastAttack.forEach(function (t, id) { if (now - t > 10000) lastAttack.delete(id); });
    killed.forEach(function (t, id) { if (now - t > KILL_MEMORY_MS) killed.delete(id); });
  }

  // Alle wezens die we mogen aanvallen, met afstand en score.
  // Monsters die de bot altijd negeert (config.targeting.ignoreNames), ook bij 'alles aanvallen'.
  function ignored(cfg, key) {
    var list = Array.isArray(cfg.ignoreNames) ? cfg.ignoreNames : [];
    for (var i = 0; i < list.length; i++) if (lower(list[i]) === key) return true;
    return false;
  }

  function candidates(ctx, cfg, currentId) {
    var me = ctx.player;
    var monsters = monsterMap(cfg);
    var always = alwaysSet(cfg);
    var attackAll = !!cfg.attackAll;
    var maxDist = num(cfg.maxDistance, 7);
    var out = [];
    var list = ctx.creatures || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c.id === me.id) continue;
      if (c.type !== 1) continue;                 // nooit spelers (0) of NPC's (2)
      if (c.masterId) continue;                   // nooit opgeroepen monsters (summons)
      if (c.canSee === false) continue;           // buiten beeld: de server weigert dan het doel
      // Muur ertussen: niet aanvallen (wel naartoe lopen via offscreen, als het kan).
      // Valt hij ons aan, dan toch: de muur-check kan te streng zijn, en anders
      // houdt de bot afstand van een monster dat hij nooit aanvalt.
      if (c.los === false && !c.targetsMe && !(B.api.distance(me, c) <= 1)) continue;   // bijna dood: offscreen loopt erheen
      if (!(c.hpPct > 0)) continue;               // nooit een lijk
      if (c.z !== me.z) continue;                 // alleen dezelfde verdieping
      if (killed.has(c.id)) continue;             // al als kill geteld
      var key = lower(c.name);
      if (ignored(cfg, key)) continue;            // bijv. Chicken: nooit aanvallen
      var dist = B.api.distance(me, c);
      // Tijdelijk onbereikbaar: overslaan, behalve als hij nu naast ons staat
      // of ons aanvalt. Dan is hij duidelijk wel bereikbaar.
      if (cooldown.has(c.id)) {
        // Bijna dood (vlucht vaak): nooit overslaan, afmaken.
        if (dist <= 1 || c.targetsMe || c.hpPct <= CHASE_HP_PCT) cooldown.delete(c.id);
        else continue;
      }
      // Niet in de lijst, maar valt ons aan of staat direct naast ons? Dan toch vechten.
      if (!attackAll && !monsters.has(key) && !c.targetsMe && !(dist <= 1)) continue;
      // Bijna dood en ons doel: ook iets verder weg blijven aanvallen (hij vlucht).
      var finishing = (c.id === currentId || (finish && finish.id === c.id && finish.until > ctx.now)) && c.hpPct <= CHASE_HP_PCT;
      if (!isFinite(dist) || dist > (finishing ? Math.max(maxDist, num(cfg.approachDistance, 10)) : maxDist)) continue;
      // Alleen van dichtbij (bijv. Slime): verder weg alleen als hij al ons doel is.
      // targetsMe telt hier niet: bijna elk monster in beeld richt zich op jou.
      var lim = nearLimit(cfg, c.name);
      if (lim !== null && dist > lim && c.id !== currentId) continue;
      // 1 geeft de meeste punten. Monsters buiten de lijst (alles aanvallen) krijgen 0.
      var prio = monsters.has(key) ? (11 - Math.min(10, Math.max(1, monsters.get(key)))) : 0;
      var score = prio * PRIORITY_FACTOR
        - dist * DIST_PENALTY
        + (100 - c.hpPct) * WOUND_FACTOR;
      if (c.id === currentId) score += STICKY_BONUS;
      var isAlways = always.has(key);
      if (isAlways) score += ALWAYS_BONUS;
      out.push({ c: c, dist: dist, score: score, always: isAlways, finishing: finishing });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  // Kies het doel. Wissel naar een monster naast je als het huidige doel
  // 3 of meer tegels weg is. Behalve als het doel bijna dood is en wegrent:
  // dan afmaken.
  function choose(list, currentId, switchIfAdjacent) {
    if (!list.length) return null;
    // Ons doel is bijna dood: eerst afmaken, ook als er een monster met voorrang is.
    for (var f = 0; f < list.length; f++) {
      if (list[f].finishing) return list[f];
    }
    var best = list[0];
    // Een monster dat altijd voorgaat, laten we nooit los voor een ander.
    if (switchIfAdjacent && !best.always && best.c.hpPct > CHASE_HP_PCT && best.c.id === currentId && best.dist >= 3) {
      for (var i = 1; i < list.length; i++) {
        if (list[i].dist <= 1) return list[i];   // lijst staat al op score
      }
    }
    return best;
  }

  // Kill tellen: vorig doel is weg of heeft hpPct 0, en het had schade.
  function checkKill(ctx) {
    if (!prev) return;
    var now = ctx.now;
    var found = null;
    var list = ctx.creatures || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === prev.id) { found = list[i]; break; }
    }
    if (found && found.hpPct > 0) { prev.x = found.x; prev.y = found.y; prev.z = found.z; return; }
    if (found) { prev.x = found.x; prev.y = found.y; prev.z = found.z; }
    var low = minHp.has(prev.id) ? minHp.get(prev.id) : 100;
    if (found && found.hpPct <= 0) low = 0;
    if (low < 100 && !killed.has(prev.id)) {
      killed.set(prev.id, now);
      ctx.emit('kill', { name: prev.name, time: now });
      // Even naar het lijk lopen, zodat de client automatisch kan looten.
      if (prev.x != null && B.pickup && B.pickup.addCorpse) B.pickup.addCorpse({ x: prev.x, y: prev.y, z: prev.z }, now);
    }
    minHp.delete(prev.id);
    if (track && track.id === prev.id) track = null;
    prev = null;
  }

  // Onbereikbaar: binnen unreachableMs niet dichterbij en niet geraakt.
  // Geeft true als we het doel hebben losgelaten.
  function checkUnreachable(ctx, cfg, pick) {
    // Uit te zetten met targeting.unreachableOff: dan nooit een doel loslaten als 'onbereikbaar'.
    if (cfg.unreachableOff) return false;
    var now = ctx.now;
    var id = pick.c.id;
    if (!track || track.id !== id) {
      track = { id: id, since: now, dist: pick.dist, hp: pick.c.hpPct, seen: now };
      return false;
    }
    // Was de bot even weg (pauze, verbinding kwijt)? Dan telt die tijd niet mee,
    // anders lijkt een monster na het terugkomen meteen onbereikbaar.
    if (now - (track.seen || now) > 1500) track.since = now;
    track.seen = now;
    // Afstand houden (paladin): op schietafstand en in beeld is hij bereikbaar,
    // ook als hij niet dichterbij komt. Dat is juist de bedoeling.
    var keep = num(cfg.keepDistance, 0);
    var shootRange = Math.max(keep + 1, num(cfg.kiteRange, keep + 2)) + 1;
    // In beeld is niet hetzelfde als raakbaar (een muur ertussen). Daarom op
    // schietafstand alleen langer wachten, niet eindeloos: raakt hij niets, dan loslaten.
    var inRange = keep >= 1 && pick.c.canSee !== false && pick.dist <= shootRange;
    // Vrij schootsveld en binnen bereik (bijv. een Elf Scout die zelf afstand houdt):
    // veel langer geduld en daarna maar kort overslaan, anders 'ziet' de bot hem niet meer.
    var clearShot = pick.c.canSee !== false && pick.c.los !== false && pick.dist <= Math.max(shootRange, num(cfg.maxDistance, shootRange));
    if (pick.dist < track.dist || pick.c.hpPct < track.hp || pick.dist <= 1) {
      track.since = now;
      track.dist = Math.min(track.dist, pick.dist);
      track.hp = Math.min(track.hp, pick.c.hpPct);
      return false;
    }
    // Altijd minstens 6 s proberen (ook recht voor het doel gaan staan) voor 'onbereikbaar'.
    // Raakt de bot het doel niet, dan niet lang blijven staan maar verder lopen:
    // na hooguit 4 s (doel bijna dood: 6 s) loslaten.
    if (now - track.since < (pick.finishing ? 6000 : 4000)) return false;

    // Loslaten en een tijdje overslaan.
    cooldown.set(id, now + (clearShot ? 15000 : num(cfg.unreachableCooldownMs, 15000)));
    if (ctx.player.targetId === id) B.api.clearTarget();
    ctx.log('Doel ' + pick.c.name + ' op ' + pick.dist + ' tegels is onbereikbaar. Ik sla het even over.');
    track = null;
    if (prev && prev.id === id) prev = null;     // geen kill tellen na loslaten
    minHp.delete(id);
    return true;
  }

  function tick(ctx) {
    try {
      var me = ctx && ctx.player;
      if (!me) return { targetId: null, fighting: false };
      var cfg = (ctx.config && ctx.config.targeting) || {};
      var now = ctx.now;
      cleanup(now);

      // Eerst kijken of het vorige doel dood is.
      checkKill(ctx);

      // Oude schade-metingen weggooien van wezens die er niet meer zijn.
      var present = new Set((ctx.creatures || []).map(function (c) { return c && c.id; }));
      minHp.forEach(function (v, cid) { if (!present.has(cid)) minHp.delete(cid); });

      var currentId = me.targetId || null;
      var pick = null;
      // Hooguit een paar keer opnieuw kiezen als een doel net is losgelaten.
      for (var tries = 0; tries < 3; tries++) {
        var list = candidates(ctx, cfg, currentId);
        pick = choose(list, currentId, cfg.switchIfAdjacent !== false);
        if (!pick) break;
        if (!checkUnreachable(ctx, cfg, pick)) break;
        if (currentId === pick.c.id) currentId = null;
        pick = null;
      }

      // Bijna dood doel is uit beeld of te ver gevlucht: er even achteraan,
      // ook als er een ander monster in de buurt is.
      if (finish && finish.until > now && (!pick || pick.c.id !== finish.id)) {
        var fl = offscreen(ctx, cfg);
        if (fl && fl.c.id === finish.id) {
          if (me.targetId) B.api.clearTarget();
          prev = null;
          approach = { id: fl.c.id, since: now };
          return { targetId: null, fighting: false, approach: { id: fl.c.id, x: fl.c.x, y: fl.c.y, z: fl.c.z, name: fl.c.name } };
        }
      }
      if (finish && (finish.until <= now || !present.has(finish.id))) finish = null;

      if (!pick) {
        prev = null;
        // Staat er nog een doel dat we niet (meer) willen of kunnen aanvallen
        // (uit beeld, te ver, summon), dan loslaten. Anders weigert walkTo
        // steeds en staat de bot stil.
        if (me && me.targetId) B.api.clearTarget();

        // Geen doel in beeld: misschien staat er een net buiten beeld.
        var off = offscreen(ctx, cfg);
        if (off) {
          if (!approach || approach.id !== off.c.id) approach = { id: off.c.id, since: now };
          if (now - approach.since > APPROACH_GIVEUP_MS) {
            noApproach.set(off.c.id, now + APPROACH_COOLDOWN_MS);
            approach = null;
            ctx.log(off.c.name + ' buiten beeld niet bereikt in 6 seconden. Ik loop er even niet meer naartoe.');
            return { targetId: null, fighting: false };
          }
          return { targetId: null, fighting: false, approach: { id: off.c.id, x: off.c.x, y: off.c.y, z: off.c.z, name: off.c.name } };
        }
        approach = null;
        return { targetId: null, fighting: false };
      }

      var id = pick.c.id;
      if (pick.c.hpPct <= CHASE_HP_PCT) finish = { id: id, until: now + FINISH_MS };
      else if (finish && finish.id === id) finish = null;
      approach = null; // we vechten weer: een volgende approach begint opnieuw te tellen
      // Laagste hpPct bijhouden, zodat we weten of het doel schade had.
      var oldLow = minHp.has(id) ? minHp.get(id) : 100;
      minHp.set(id, Math.min(oldLow, pick.c.hpPct));

      // Alleen aanvallen als het doel anders is dan het huidige.
      if (id !== me.targetId) {
        var last = lastAttack.get(id);
        if (last === undefined || now - last >= ATTACK_GAP_MS) {
          lastAttack.set(id, now);
          B.api.attack(id);
        }
      }

      prev = { id: id, name: pick.c.name };
      return { targetId: id, fighting: true };
    } catch (e) {
      if (ctx && typeof ctx.log === 'function') ctx.log('Fout in targeting: ' + (e && e.message));
      return { targetId: null, fighting: false };
    }
  }

  function reset() {
    approach = null;
    finish = null;
    cooldown.clear();
    noApproach.clear();
    lastAttack.clear();
    minHp.clear();
    killed.clear();
    track = null;
    prev = null;
  }

  // Doel een tijdje overslaan (vastzit-controle).
  function ignore(id, ms) {
    if (id == null) return;
    cooldown.set(id, Date.now() + (ms || 60000));
    if (track && track.id === id) track = null;
    if (prev && prev.id === id) prev = null;
    minHp.delete(id);
  }

  // Niet meer naartoe lopen als hij buiten beeld staat (wel aanvallen als hij komt).
  function skipApproach(id, ms) {
    if (id == null) return;
    noApproach.set(id, Date.now() + (ms || APPROACH_COOLDOWN_MS));
    if (approach && approach.id === id) approach = null;
  }

  B.targeting = { tick: tick, reset: reset, ignore: ignore, skipApproach: skipApproach };
})(window.WJBot = window.WJBot || {});
