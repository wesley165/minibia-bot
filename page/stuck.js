(function (B) {
  'use strict';

  // Vastzit-controle.
  // Komt de speler langer dan 1 minuut niet verder dan 2 tegels van dezelfde
  // plek terwijl er niets gebeurt (geen kill, het doel verliest geen HP), dan
  // zoekt de bot uit
  // waarom en onderneemt hij actie. Lukt dat niet, dan elke 30 seconden een
  // zwaardere stap. Na de derde stap komt er ook een melding.
  // Alleen tijdens jagen en onderweg, niet bij refillen, death of pauze.
  if (B.stuck) return;

  var STUCK_MS = 60000;     // zo lang op dezelfde plek = vast
  var STEP_MS = 30000;      // tijd tussen de stappen
  var ALERT_STEP = 3;       // vanaf deze stap ook een melding
  var HOLD_MS = 1500;       // zo lang laat de cavebot ons even opzij stappen
  var IGNORE_MS = 60000;    // zo lang slaan we een doel over dat niet opschiet

  var DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]];

  var MOVE_TILES = 2;       // pas verder dan dit telt als echt verder gekomen

  var anchor = null;        // plek waar de teller begon { x, y, z }
  var since = 0;            // sinds wanneer er niets gebeurt
  var lastKills = -1;
  var lastTarget = null;    // { id, hp }
  var step = 0;
  var lastStepAt = 0;
  var holdUntil = 0;
  var info = null;          // { seconds, step, reason } voor de status

  function api() { return B.api; }

  function restart(now, p) {
    anchor = p ? { x: p.x, y: p.y, z: p.z } : null;
    since = now;
    step = 0;
    lastStepAt = 0;
    info = null;
  }

  function freeAround(p, range) {
    var out = [];
    for (var dx = -range; dx <= range; dx++) {
      for (var dy = -range; dy <= range; dy++) {
        if (!dx && !dy) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
        if (api().tileFree(p.x + dx, p.y + dy, p.z)) out.push({ x: p.x + dx, y: p.y + dy, z: p.z });
      }
    }
    return out;
  }

  function adjacentNames(ctx) {
    var p = ctx.player;
    var names = [];
    (ctx.creatures || []).forEach(function (c) {
      if (!c || c.id === p.id || c.z !== p.z) return;
      if (Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) === 1) names.push(c.name);
    });
    return names;
  }

  function wpLabel(i, wp) {
    return 'waypoint ' + (i + 1) + (wp && wp.type && wp.type !== 'walk' ? ' (' + wp.type + ')' : '');
  }

  // Waarom staan we stil? Geeft { code, text }.
  function diagnose(ctx) {
    var p = ctx.player;
    var wps = (ctx.route && ctx.route.waypoints) || [];
    var i = ctx.index;
    var wp = wps[i];

    if (ctx.mode === 'fighting' && ctx.target) {
      return { code: 'target', text: 'Ik val ' + ctx.target.name + ' aan, maar die verliest geen HP (' + ctx.target.hpPct + '%).' };
    }
    if (!freeAround(p, 1).length) {
      var who = adjacentNames(ctx);
      return { code: 'boxed', text: 'Ik sta ingesloten. Er is geen vrije tegel om me heen' + (who.length ? ' (' + who.join(', ') + ')' : '') + '.' };
    }
    if (!wp) return { code: 'noroute', text: 'Er is geen waypoint om naartoe te lopen.' };
    var dist = api().distance(p, wp);
    if (wp.z !== p.z) {
      return { code: 'floor', text: 'Ik sta op een andere verdieping dan ' + wpLabel(i, wp) + ' (z ' + p.z + ' in plaats van ' + wp.z + ').' };
    }
    if (ctx.mode === 'action') {
      return { code: 'action', text: 'De actie bij ' + wpLabel(i, wp) + ' lukt niet.' };
    }
    if (dist <= 1 && !api().tileFree(wp.x, wp.y, wp.z)) {
      return { code: 'occupied', text: 'De tegel van ' + wpLabel(i, wp) + ' is bezet.' };
    }
    if (!p.isWalking) {
      return { code: 'blocked', text: 'Ik kom niet bij ' + wpLabel(i, wp) + ' (nog ' + dist + ' tegels). De weg is geblokkeerd.' };
    }
    return { code: 'unknown', text: 'Ik loop wel, maar kom niet van mijn plek.' };
  }

  function stepAside(ctx, range) {
    var free = freeAround(ctx.player, range);
    if (!free.length && range > 1) free = freeAround(ctx.player, 1);
    if (!free.length) return false;
    var t = free[Math.floor(Math.random() * free.length)];
    api().cancelWalk();
    api().walkTo(t.x, t.y, t.z);
    holdUntil = ctx.now + HOLD_MS * range;
    return true;
  }

  // Actie per stap, zwaarder naarmate we langer vastzitten.
  function act(ctx, d) {
    var did = [];
    if (step === 1) {
      if (d.code === 'target') {
        if (B.targeting && B.targeting.ignore) B.targeting.ignore(ctx.target.id, IGNORE_MS);
        api().clearTarget();
        did.push('doel losgelaten');
      }
      api().cancelWalk();
      if (d.code === 'occupied' || d.code === 'action') {
        B.cavebot.skipCurrent();
        did.push('waypoint overgeslagen');
      } else if (d.code === 'boxed') {
        did.push('even afwachten tot er ruimte komt');
      } else {
        B.cavebot.reset(false);
        did.push('opnieuw het dichtstbijzijnde waypoint gekozen');
      }
    } else if (step === 2) {
      if (stepAside(ctx, 1)) did.push('een stap opzij gezet');
      // Alleen gewone looppunten overslaan. Een touw, trap of gat overslaan
      // brengt je op de verkeerde verdieping.
      var wps = (ctx.route && ctx.route.waypoints) || [];
      var cur = wps[ctx.index];
      if (!cur || !cur.type || cur.type === 'walk') {
        B.cavebot.skipCurrent();
        did.push('waypoint overgeslagen');
      }
    } else {
      if (ctx.player.targetId) api().clearTarget();
      if (stepAside(ctx, 2)) did.push('twee tegels opzij gelopen');
      B.cavebot.reset(false);
      did.push('opnieuw het dichtstbijzijnde waypoint gekozen');
    }
    return did.join(', ');
  }

  // Twijfel-detector: loopt de speler heen en weer tussen dezelfde paar
  // tegels (A, B, A, B), dan komt in het log waar dat is en waar hij heen wil.
  // Zo kunnen we de oorzaak later terugvinden. Hooguit één keer per 30 s.
  var trail = [];          // { key, t }
  var lastWobbleLog = 0;
  function wobble(ctx) {
    var p = ctx.player;
    var key = p.x + ',' + p.y + ',' + p.z;
    if (!trail.length || trail[trail.length - 1].key !== key) trail.push({ key: key, t: ctx.now });
    while (trail.length && ctx.now - trail[0].t > 8000) trail.shift();
    if (ctx.mode !== 'walking' || trail.length < 5 || ctx.now - lastWobbleLog < 30000) return;
    var seen = {};
    var back = 0;
    for (var i = 0; i < trail.length; i++) {
      if (seen[trail[i].key] !== undefined && i - seen[trail[i].key] >= 2) back++;
      seen[trail[i].key] = i;
    }
    var uniq = Object.keys(seen).length;
    if (back < 2 || uniq > 4) return;
    lastWobbleLog = ctx.now;
    var wps = (ctx.route && ctx.route.waypoints) || [];
    var wp = wps[ctx.index];
    ctx.log('Twijfel: ik loop heen en weer tussen ' + Object.keys(seen).join(' en ') + '. Doel: waypoint ' + (ctx.index + 1) +
      (wp ? ' (' + wp.x + ',' + wp.y + ',' + wp.z + ')' : '') + (ctx.approach ? ', ik loop naar ' + ctx.approach : '') + '.');
    // Eén richting kiezen: een paar seconden alleen eigen stappen naar het waypoint.
    if (wp && B.api && B.api.commitWalk) B.api.commitWalk(wp.x, wp.y, wp.z, 8000);
  }

  // Elke statusronde (ook als de lus even niets doet).
  function check(ctx) {
    var now = ctx.now;
    var p = ctx.player;
    if (!ctx.active || !p || p.isDead) { restart(now, p); lastKills = ctx.kills; return; }
    // Bewust wachten bij een stand-waypoint telt niet als vastzitten.
    if (B.cavebot && B.cavebot.phase && B.cavebot.phase() === 'stand' && ctx.mode === 'action') { restart(now, p); return; }
    if (!anchor) { restart(now, p); lastKills = ctx.kills; return; }
    try { wobble(ctx); } catch (e) { /* alleen voor het log */ }

    // Voortgang: meer dan 2 tegels verder, een kill of het doel verliest HP.
    // Heen en weer lopen op 1 of 2 tegels telt dus niet als verder komen.
    var key = p.x + ',' + p.y + ',' + p.z;
    var moved = p.z !== anchor.z || Math.max(Math.abs(p.x - anchor.x), Math.abs(p.y - anchor.y)) > MOVE_TILES;
    var progress = moved || ctx.kills !== lastKills;
    if (ctx.target) {
      if (lastTarget && lastTarget.id === ctx.target.id && ctx.target.hpPct < lastTarget.hp) progress = true;
      if (!lastTarget || lastTarget.id !== ctx.target.id || ctx.target.hpPct < lastTarget.hp) {
        lastTarget = { id: ctx.target.id, hp: ctx.target.hpPct };
      }
    }
    lastKills = ctx.kills;
    if (progress) {
      if (step > 0) ctx.log('Niet meer vast. De bot loopt weer.');
      restart(now, p);
      return;
    }

    var still = now - since;
    if (still < STUCK_MS) { info = null; return; }
    if (lastStepAt && now - lastStepAt < STEP_MS) {
      if (info) info.seconds = Math.round(still / 1000);
      return;
    }

    step++;
    lastStepAt = now;
    var d = diagnose(ctx);
    var did = '';
    try { did = act(ctx, d); } catch (e) { did = 'actie mislukt (' + e.message + ')'; }
    var secs = Math.round(still / 1000);
    info = { seconds: secs, step: step, reason: d.text };
    var msg = 'Vast op ' + key + ' sinds ' + secs + ' seconden. ' + d.text + ' Actie: ' + (did || 'geen') + '.';
    ctx.log(msg);
    if (step === ALERT_STEP) {
      ctx.emit('alert', { reason: 'stuck', action: 'alert', message: msg });
    }
  }

  B.stuck = {
    check: check,
    // Laat de cavebot even met rust zodat een stap opzij lukt.
    holding: function (now) { return now < holdUntil; },
    info: function () { return info; },
    reset: function () { restart(Date.now(), null); holdUntil = 0; lastTarget = null; }
  };
})(window.WJBot = window.WJBot || {});
