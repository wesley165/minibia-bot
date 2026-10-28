(function (B) {
  'use strict';

  // Engine: houdt de toestand bij, draait de lus en stuurt de status naar Node.
  // Guard: als de engine al bestaat (dubbel geladen), niets opnieuw starten.
  if (B.engine) return;

  var TICK_MS = 250;
  var STATUS_MS = 500;
  var NEAR = 8;

  // Standaardwaarden, zodat modules niet vastlopen op een ontbrekend deel van de config.
  var DEFAULTS = {
    routeName: '',
    targeting: { monsters: [], attackAll: false, maxDistance: 7, unreachableMs: 3000, unreachableCooldownMs: 15000, switchIfAdjacent: true },
    healing: { skipInPz: true, rules: [] },
    cavebot: { arriveDistance: 0, repathMs: 3000, maxRepaths: 2, loop: true },
    safety: { onPlayer: 'alert', playerIgnore: [], lowHpAlertPct: 30 },
    notify: { ntfyTopic: '', desktop: true }
  };

  var state = 'stopped';
  var pauseReason = null;
  var lastApproachAt = 0;
  var approachFails = 0;      // walkTo naar een monster buiten beeld mislukt, achter elkaar
  var lastApproachName = null; // monster buiten bereik waar we nu naartoe lopen
  var approachCommit = null;   // { id, since, x, y, z, name }: monster waar we minstens approachMinMs naartoe lopen
  var farSince = 0;            // sinds wanneer we ver van de route staan
  var lastPos = null;          // { x, y, z, t }: positie vorige tick, om een teleport te zien
  var teleportAt = 0;          // wanneer we een echte sprong (teleport) zagen

  // Fases na een death: hunt -> death -> toDepot -> refill -> toHunt -> hunt.
  var phase = 'hunt';
  var phaseRoute = null;      // route van de huidige fase (niet bij hunt)
  var routes = {};            // extra routes op naam (tempel-depot, depot-hunt)
  var routeEnded = false;     // cavebot meldde einde van de route
  var deathInfo = null;       // { at, okAt, aliveSince }
  var refillBusy = false;
  var refillGen = 0;          // volgnummer: een oude refill telt niet meer
  var needDecide = false;     // bij de volgende tick eerst kijken waar we zijn
  var routesReceived = false; // extra routes (tempel-depot, depot-hunt) binnen
  var configReceived = false;
  var readySince = 0;         // sinds wanneer het spel weer klaar is (na storing)
  var wanted = null;          // van de server: true = Start, false = Stop, null = nog niet bekend
  var seek = null;            // zelf naar een route lopen: { x, y, z, name, until, lastWalk }

  // Onthouden in dit tabblad of de bot aan stond en in welke fase, zodat hij
  // na het herladen van de pagina vanzelf verder kan.
  var SAVE_KEY = 'wjbot-state';
  function persist() {
    if (pendingResume) return; // eerst de bewaarde stand gebruiken, niet overschrijven
    try {
      var active = state === 'running' || (state === 'paused' && pauseReason === 'disconnect');
      sessionStorage.setItem(SAVE_KEY, JSON.stringify({ active: active, phase: phase, time: Date.now() }));
    } catch (e) { /* geen opslag: dan niet */ }
  }
  var pendingResume = null;
  try {
    var saved = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null');
    // Alleen als het kort geleden was (binnen 10 minuten).
    if (saved && saved.active && Date.now() - saved.time < 600000) pendingResume = saved;
  } catch (e) { pendingResume = null; }

  // Na herladen: wachten op spel, instellingen en route, dan verder.
  function tryResumeAfterReload() {
    if (!pendingResume || state !== 'stopped' || !configReceived) return;
    if (wanted === false) { pendingResume = null; return; } // staat op Stop: niet vanzelf verder
    var api = B.api;
    if (!api || !safeCall(function () { return api.ready(); }, false)) return;
    var p = safeCall(function () { return api.player(); }, null);
    var dead = safeCall(function () { return api.modalVisible('death-modal'); }, false) || (p && p.isDead);
    if (!p && !dead) return;
    var want = pendingResume.phase;
    pendingResume = null;
    var r = start();
    if (r && r.ok === false) return;
    log('Pagina was herladen. De bot gaat vanzelf verder.');
    if (restockOn() && (dead || want === 'death')) {
      deathInfo = { at: Date.now(), okAt: 0, aliveSince: 0 };
      needDecide = false;
      setPhase('death');
    }
    // Anders bepaalt de waar-ben-ik-check (needDecide via start) de fase.
  }
  var mode = 'idle';
  var config = mergeConfig({});
  var route = { name: '', waypoints: [] };
  var wasFighting = false;
  var busy = false;
  var stats = { kills: 0, startedAt: null, stoppedAt: null };
  var keyCount = {}; // bijv. { 'attackSpell F3': 12 }

  function mergeConfig(cfg) {
    cfg = cfg && typeof cfg === 'object' ? cfg : {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var d = DEFAULTS[k];
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        out[k] = Object.assign({}, d, cfg[k] && typeof cfg[k] === 'object' ? cfg[k] : {});
      } else {
        out[k] = cfg[k] !== undefined ? cfg[k] : d;
      }
    });
    Object.keys(cfg).forEach(function (k) {
      if (!(k in out)) out[k] = cfg[k];
    });
    return out;
  }

  // Event naar Node sturen. wjEmit geeft een Promise terug; fouten vangen we af.
  function send(type, payload) {
    try {
      if (typeof window.wjEmit === 'function') {
        var r = window.wjEmit(type, payload);
        if (r && typeof r.catch === 'function') r.catch(function () {});
        return;
      }
    } catch (e) { /* val terug op console */ }
    try { console.log('[WJBot]', type, payload); } catch (e) { /* niets */ }
  }

  // emit met interne hook: kills tellen en tijd toevoegen.
  function emit(type, payload) {
    var p = payload && typeof payload === 'object' ? Object.assign({}, payload) : {};
    if (type !== 'status' && type !== 'routeEnd' && p.time === undefined) p.time = Date.now();
    if (type === 'kill') stats.kills += 1;
    send(type, type === 'routeEnd' ? (payload || {}) : p);
  }

  function log(msg) {
    emit('log', { msg: String(msg) });
  }

  function safeCall(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function resetModules() {
    ['targeting', 'cavebot', 'healing', 'safety', 'stuck'].forEach(function (n) {
      var m = B[n];
      if (m && typeof m.reset === 'function') {
        try { m.reset(); } catch (e) { log('Reset van ' + n + ' mislukt: ' + e.message); }
      }
    });
  }

  function cancelWalk() {
    safeCall(function () { B.api.cancelWalk(); });
  }

  // Toestand

  // Bij welk character horen deze instellingen? config.character (of anders
  // autoLogin.character). Staat er een ander character in het spel, dan niet spelen:
  // instellingen en route van de één kunnen de ander laten sterven.
  function wrongCharacter() {
    var want = String((config && (config.character || (config.autoLogin && config.autoLogin.character))) || '').trim().toLowerCase();
    if (!want) return null;
    var p = safeCall(function () { return B.api.player(); }, null);
    if (!p || !p.name) return null;
    return String(p.name).trim().toLowerCase() === want ? null : p.name;
  }

  function start() {
    if (B.recorder && B.recorder.active()) return { ok: false, error: 'Stop eerst de opname voordat je de bot start.' };
    if (state === 'running') return result();
    var other = wrongCharacter();
    if (other) {
      log('Niet gestart: ' + other + ' is ingelogd, maar de instellingen zijn voor ' + (config.character || config.autoLogin.character) + '.');
      return { ok: false, error: 'Ander character ingelogd (' + other + ').' };
    }
    if (state === 'paused') return resume();
    resetModules();
    phase = 'hunt';
    phaseRoute = null;
    deathInfo = null;
    stats = { kills: 0, startedAt: Date.now(), stoppedAt: null };
    keyCount = {};
    wasFighting = false;
    mode = 'idle';
    pauseReason = null;
    state = 'running';
    needDecide = true;
    log('Bot gestart.');
    return result();
  }

  function stop() {
    refillGen++;
    refillBusy = false;
    seek = null;
    pendingResume = null; // na Stop niet alsnog verder na het herladen
    if (state !== 'stopped') {
      state = 'stopped';
      pauseReason = null;
      mode = 'idle';
      wasFighting = false;
      stats.stoppedAt = Date.now();
      cancelWalk();
      safeCall(function () { B.api.clearTarget(); });
      resetModules();
      log('Bot gestopt.');
    }
    return result();
  }

  // Hoort een verdiepingswissel bij de route? Dan staat er een trap-, touw-,
  // use- of shovel-waypoint binnen 2 tegels van waar we stonden.
  function plannedFloorChange(rt, pos) {
    var wps = (rt && rt.waypoints) || [];
    for (var i = 0; i < wps.length; i++) {
      var w = wps[i];
      if (!w || w.z !== pos.z || !w.type || w.type === 'walk' || w.type === 'stand') continue;
      if (Math.max(Math.abs(w.x - pos.x), Math.abs(w.y - pos.y)) <= 2) return true;
    }
    return false;
  }

  function pause(reason) {
    if (state === 'stopped') return result();
    seek = null;
    refillGen++;        // lopende refill stopt bij de volgende actie
    refillBusy = false;
    state = 'paused';
    pauseReason = reason || 'handmatig';
    mode = 'idle';
    wasFighting = false;
    cancelWalk();
    log('Bot gepauzeerd: ' + pauseReason + '.');
    return result();
  }

  function resume() {
    if (state !== 'paused') return result();
    if (B.recorder && B.recorder.active()) return { ok: false, error: 'Stop eerst de opname voordat je doorgaat.' };
    state = 'running';
    pauseReason = null;
    if (phase !== 'death' && phase !== 'refill') needDecide = true;
    log('Bot gaat verder.');
    return result();
  }

  function result(extra) {
    return Object.assign({ ok: true, state: state, pauseReason: pauseReason }, extra || {});
  }

  function setConfig(cfg) {
    configReceived = true;
    config = mergeConfig(cfg);
    return result();
  }

  // Extra routes voor na een death, op naam: { 'tempel-depot': {...}, ... }
  function setRoutes(map) {
    routes = map && typeof map === 'object' ? map : {};
    routesReceived = true;
    return result({ routes: Object.keys(routes) });
  }

  function setRoute(r) {
    var next = {
      name: (r && r.name) || '',
      waypoints: r && Array.isArray(r.waypoints) ? r.waypoints : []
    };
    var changed = next.name !== route.name;
    route = next;
    // Andere route: cavebot begint weer bij het eerste waypoint.
    if (changed && B.cavebot && typeof B.cavebot.reset === 'function') {
      safeCall(function () { B.cavebot.reset(); });
    }
    return result({ routeName: route.name, waypointCount: route.waypoints.length });
  }

  // Beschrijf een waarde kort: soort, sleutels, lengte, eerste getallen.
  function describe(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return String(v);
    if (typeof v !== 'object') return typeof v === 'string' ? 'str:' + v.slice(0, 60) : typeof v + ':' + v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      var arr = ArrayBuffer.isView(v) ? v : new Uint8Array(v);
      return (v.constructor && v.constructor.name) + '[' + arr.length + '] ' + Array.prototype.slice.call(arr, 0, 24).join(',');
    }
    if (typeof Blob !== 'undefined' && v instanceof Blob) return 'Blob ' + v.size + ' ' + v.type;
    if (Array.isArray(v)) return 'Array[' + v.length + '] ' + (depth < 2 && v.length ? describe(v[0], depth + 1) : '');
    if (depth > 2) return 'Object{' + Object.keys(v).slice(0, 10).join(',') + '}';
    var out = {};
    Object.keys(v).slice(0, 25).forEach(function (k) { try { out[k] = describe(v[k], depth + 1); } catch (e) { out[k] = '?'; } });
    return out;
  }

  function kaartProbe() {
    var g = window.gameClient;
    var dbw = g && g.database;
    var info = { databaseKeys: dbw ? Object.keys(dbw).slice(0, 40) : null, protoKeys: dbw ? Object.getOwnPropertyNames(Object.getPrototypeOf(dbw)).slice(0, 60) : null };
    var idb = null;
    if (dbw) Object.keys(dbw).forEach(function (k) { try { if (dbw[k] && typeof IDBDatabase !== 'undefined' && dbw[k] instanceof IDBDatabase) idb = dbw[k]; } catch (e) { /* niets */ } });
    if (!idb) return Promise.resolve(info);
    info.dbName = idb.name;
    info.stores = Array.prototype.slice.call(idb.objectStoreNames);
    var jobs = info.stores.map(function (name) {
      return new Promise(function (resolve) {
        try {
          var tx = idb.transaction(name, 'readonly');
          var st = tx.objectStore(name);
          var res = { keyPath: st.keyPath, indexes: Array.prototype.slice.call(st.indexNames) };
          var cnt = st.count();
          cnt.onsuccess = function () { res.count = cnt.result; };
          var cur = st.openCursor();
          var n = 0;
          res.samples = [];
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c || n >= 2) { resolve(res); return; }
            res.samples.push({ key: describe(c.key), value: describe(c.value) });
            n++;
            c.continue();
          };
          cur.onerror = function () { res.error = 'cursor'; resolve(res); };
        } catch (e) { resolve({ error: String(e.message || e) }); }
      }).then(function (r) { info[name] = r; });
    });
    return Promise.all(jobs).then(function () { return info; });
  }

  function command(name, args) {
    try {
      switch (name) {
        // Onderzoek: hoe bewaart de client de minimap (IndexedDB)? Async: start, daarna Result ophalen.
        case 'kaartProbe': {
          B.kaartProbeResult = { busy: true };
          kaartProbe().then(function (r) { B.kaartProbeResult = r; }, function (e) { B.kaartProbeResult = { error: String(e && e.message || e) }; });
          return { ok: true, started: true };
        }
        case 'kaartProbeResult': return B.kaartProbeResult || { none: true };
        case 'start': return start();
        case 'stop': return stop();
        case 'pause': return pause((args && args.reason) || 'handmatig');
        case 'resume': return resume();
        // Zelf een privébericht terugsturen (tekst komt van jou, uit het dashboard).
        case 'scanArea': {
          var pl = safeCall(function () { return B.api.player(); }, null);
          if (!pl) return { ok: false, error: 'Niet ingelogd.' };
          var sx = args && args.x != null ? Number(args.x) : pl.x;
          var sy = args && args.y != null ? Number(args.y) : pl.y;
          var sz = args && args.z != null ? Number(args.z) : pl.z;
          return { ok: true, scan: B.api.scanArea(sx, sy, sz, args && args.r) };
        }
        case 'walkTo': {
          var okW = safeCall(function () { return B.api.walkTo(Number(args.x), Number(args.y), Number(args.z)); }, false);
          return { ok: !!okW };
        }
        case 'getHotbar': {
          // Hele hotbar-instelling (alle presets) als tekst, via de export van het spel.
          var hbG = safeCall(function () { var hb = gameClient.interface.hotbarManager; return hb.exportConfiguration(); }, null);
          return hbG ? { ok: true, hotbar: hbG } : { ok: false, error: 'Hotbar lezen lukte niet.' };
        }
        case 'setHotbar': {
          // Hotbar overnemen van een andere Chrome (bijv. Mac -> VPS), via de import van het spel.
          var okHb = safeCall(function () { return gameClient.interface.hotbarManager.importConfiguration(String(args && args.hotbar || '')); }, false);
          if (okHb) log('Hotbar ingesteld (overgenomen).');
          return okHb ? { ok: true } : { ok: false, error: 'Hotbar instellen lukte niet.' };
        }
        case 'setHotkeyItem': {
          var okHk = safeCall(function () { return B.api.setHotkeyItem(args && args.slot, args && args.itemId, args && args.mode, args && args.fluidType); }, false);
          if (okHk) log('F' + args.slot + ' staat nu op item ' + args.itemId + ' (' + (args.mode || 'self') + ').');
          return okHk ? { ok: true } : { ok: false, error: 'Hotkey instellen lukte niet.' };
        }
        case 'sendPm': return B.chat ? B.chat.sendPm(args) : { ok: false, error: 'Chat is nog niet geladen.' };
        case 'bagsInfo': return B.bags ? B.bags.info() : { ok: false, error: 'Bags is nog niet geladen.' };
        case 'setIndex': {
          var i = Number(args && args.i);
          if (!B.cavebot || !(i >= 0)) return { ok: false, error: 'Ongeldig waypoint.' };
          B.cavebot.setIndex(Math.floor(i));
          return result({ index: B.cavebot.getIndex() });
        }
        case 'status': return getStatus();
        case 'restockTest':
          // Test zonder dood te gaan: begin bij "op weg naar het depot".
          if (!restockOn()) return { ok: false, error: 'Restocken staat niet aan in de instellingen.' };
          if (state !== 'running') {
            var st0 = start();
            if (st0 && st0.ok === false) return st0;
          }
          // Optioneel verder vanaf een latere stap: { phase: 'toHunt' }.
          setPhase(args && (args.phase === 'toHunt' || args.phase === 'refill') ? args.phase : 'toDepot');
          return result({ phase: phase });
        case 'openLocker':
        case 'refill': {
          // Depot-acties duren even. We starten ze en melden de uitkomst in het log.
          if (!B.depot) return { ok: false, error: 'Depot-functie is niet geladen.' };
          if (state === 'running') return { ok: false, error: 'Stop eerst de bot.' };
          var job = name === 'refill' ? B.depot.refill(config.restock) : B.depot.openLocker();
          Promise.resolve(job).then(function (r) {
            emit('refillDone', { action: name, result: r });
          }).catch(function (e) { log('Fout bij ' + name + ': ' + e.message); });
          return { ok: true, started: true };
        }
        case 'recordStart':
          if (!B.recorder) return { ok: false, error: 'Opnemen is niet beschikbaar.' };
          if (state !== 'stopped') return { ok: false, error: 'Stop eerst de bot voordat je gaat opnemen.' };
          return B.recorder.start(args || {});
        case 'recordStop':
          if (!B.recorder) return { ok: false, error: 'Opnemen is niet beschikbaar.' };
          return B.recorder.stop();
        default: return { ok: false, error: 'Onbekend commando: ' + name };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------- Fases na een death ----------

  function restockOn() {
    return !!(config.restock && config.restock.enabled && config.restock.routes);
  }

  function setPhase(p) {
    seek = null;  // nieuwe fase: niet meer zelf naar een route lopen
    if (phase === 'refill' && p !== 'refill') { refillGen++; refillBusy = false; }
    phase = p;
    routeEnded = false;
    if (p === 'toDepot' || p === 'toHunt') {
      var name = (config.restock.routes || {})[p];
      var r = routes[name];
      if (!r || !r.waypoints || !r.waypoints.length) {
        phase = 'hunt';
        phaseRoute = null;
        pause('restock');
        emit('alert', { reason: 'restock', action: 'pause', message: 'Route ' + (name || '?') + ' ontbreekt. Ik kan niet verder met restocken.' });
        return;
      }
      // Na een death moet je bij het begin van de route staan. Sta je ergens
      // anders (bijv. een andere tempel), dan niet gaan zoeken maar melden.
      if (p === 'toDepot') {
        var me0 = safeCall(function () { return B.api.player(); }, null);
        var first = r.waypoints[0];
        var far = !me0 || me0.z !== first.z || Math.max(Math.abs(me0.x - first.x), Math.abs(me0.y - first.y)) > 30;
        if (far) {
          phase = 'hunt';
          phaseRoute = null;
          pause('restock');
          emit('alert', { reason: 'restock', action: 'pause', message: 'Je staat niet bij het begin van route ' + name + ' (andere tempel?). De bot wacht op jou.' });
          return;
        }
      }
      phaseRoute = r;
    } else {
      phaseRoute = null;
    }
    // Nieuwe route: echt opnieuw beginnen (index 0, dan dichtstbijzijnde).
    if (B.cavebot && B.cavebot.reset) safeCall(function () { B.cavebot.reset(true); });
    if (B.targeting && B.targeting.reset) safeCall(function () { B.targeting.reset(); });
    if (B.kite && B.kite.reset) safeCall(function () { B.kite.reset(); });
    var label = { hunt: 'Weer aan het hunten.', death: 'Dood gegaan. Ik log opnieuw in en ga refillen.', toDepot: 'Op weg naar het depot.', refill: 'Bezig met refillen.', toHunt: 'Op weg naar de huntspot.' };
    log(label[p] || ('Fase: ' + p));
  }

  // ---------- Waar ben ik? ----------

  // Afstand tot het dichtstbijzijnde waypoint van een route op jouw verdieping.
  function nearestDist(p, r) {
    var best = Infinity;
    ((r && r.waypoints) || []).forEach(function (w) {
      if (w.z !== p.z) return;
      var d = Math.max(Math.abs(w.x - p.x), Math.abs(w.y - p.y));
      if (d < best) best = d;
    });
    return best;
  }

  // Mist er uitrusting? Kijkt naar de vakken uit het refill-plan.
  function gearMissing() {
    var plan = (config.restock && config.restock.equip) || [];
    var SLOT = { helm: 0, armor: 1, legs: 2, boots: 3, wapen: 4, schild: 5, backpack: 6, ketting: 7, ring: 8, pijlen: 9 };
    return plan.some(function (e) {
      var s = SLOT[e.slot];
      return s != null && !safeCall(function () { return B.api.equipSlotItem(s); }, null);
    });
  }

  // Dichtstbijzijnde waypoint van een of meer routes op jouw verdieping.
  function nearestPoint(p, list) {
    var best = null;
    list.forEach(function (r) {
      ((r && r.waypoints) || []).forEach(function (w) {
        if (w.z !== p.z) return;
        var d = Math.max(Math.abs(w.x - p.x), Math.abs(w.y - p.y));
        if (!best || d < best.d) best = { x: w.x, y: w.y, z: w.z, d: d, name: r.name || '' };
      });
    });
    return best;
  }

  // Niet bij een route? Dan zelf naar het dichtstbijzijnde waypoint lopen,
  // als dat op dezelfde verdieping ligt en niet te ver weg is.
  var SEEK_MAX = 120;      // hooguit zo veel tegels ver
  var SEEK_MS = 3 * 60 * 1000;
  function startSeek(p, list) {
    var t = nearestPoint(p, list.filter(Boolean));
    if (!t || t.d > SEEK_MAX) return false;
    seek = { x: t.x, y: t.y, z: t.z, name: t.name, until: Date.now() + SEEK_MS, lastWalk: 0 };
    log('Niet bij een route. Ik loop zelf naar ' + (t.name ? 'route ' + t.name : 'de route') + ' (' + t.d + ' tegels, ' + t.x + ',' + t.y + ',' + t.z + ').');
    return true;
  }

  // Elke tick tijdens het zoeken: lopen, en kijken of we er zijn.
  function seekTick(p, now) {
    var near = nearestDist(p, { waypoints: [{ x: seek.x, y: seek.y, z: seek.z }] }) <= 2;
    if (near) {
      log('Bij de route aangekomen.');
      seek = null;
      needDecide = true;
      return;
    }
    if (now > seek.until || p.z !== seek.z) {
      var why = p.z !== seek.z ? 'Ik kwam op een andere verdieping uit' : 'Het lukte niet binnen 3 minuten';
      seek = null;
      cancelWalk();
      pause('waar');
      emit('alert', { reason: 'restock', action: 'pause', message: why + ' om zelf bij de route te komen. Je staat op ' + p.x + ',' + p.y + ',' + p.z + '. Loop naar je hunt of het depot en druk op Doorgaan.' });
      return;
    }
    // Staan we stil of loopt er niets? Opnieuw sturen, hooguit eens per 2 seconden.
    var walking = safeCall(function () { return B.api.isWalking(); }, false);
    if (walking || now - seek.lastWalk < 2000) return;
    seek.lastWalk = now;
    var ok = safeCall(function () { return B.api.walkTo(seek.x, seek.y, seek.z); }, false);
    if (!ok) {
      // Te ver voor de pathfinder: een stuk van 7 tegels in de goede richting.
      var dx = seek.x - p.x, dy = seek.y - p.y;
      var f = 7 / Math.max(Math.abs(dx), Math.abs(dy), 1);
      var sx = p.x + Math.round(dx * Math.min(1, f)), sy = p.y + Math.round(dy * Math.min(1, f));
      safeCall(function () { return B.api.walkTo(sx, sy, p.z); }, false);
    }
  }

  // Kies de fase op basis van waar je echt staat.
  function decidePhase(p) {
    if (!restockOn()) { phase = 'hunt'; return; }
    var names = config.restock.routes || {};
    var toDepot = routes[names.toDepot];
    var toHunt = routes[names.toHunt];
    var NEAR = 15;
    var dHunt = nearestDist(p, route);
    var dToHunt = nearestDist(p, toHunt);
    var dToDepot = nearestDist(p, toDepot);
    var last = toDepot && toDepot.waypoints && toDepot.waypoints[toDepot.waypoints.length - 1];
    var atDepot = !!(B.api.depotTarget && B.api.depotTarget()) ||
      (last && last.z === p.z && Math.max(Math.abs(last.x - p.x), Math.abs(last.y - p.y)) <= 8);
    var missing = gearMissing();
    var choice;
    if (missing) {
      if (atDepot) choice = 'refill';
      else if (dToDepot <= NEAR) choice = 'toDepot';
      else choice = null;
    } else if (dHunt <= NEAR) choice = 'hunt';
    else if (atDepot) choice = 'refill';           // snel langs het depot (crystal coins wegzetten)
    else if (dToHunt <= NEAR) choice = 'toHunt';
    else if (dToDepot <= NEAR) choice = 'toDepot';
    else choice = null;

    if (!choice) {
      // Eerst zelf proberen: bij uitrusting-mis naar het depot, anders naar de hunt.
      if (missing ? startSeek(p, [toDepot]) : startSeek(p, [route, toHunt, toDepot])) return;
      pause('waar');
      emit('alert', { reason: 'restock', action: 'pause', message: missing
        ? 'Je mist uitrusting, maar staat niet bij de tempel of het depot. Breng de bot daarheen en druk op Doorgaan.'
        : 'Je staat niet in de buurt van een route. Loop naar je hunt of het depot en druk op Doorgaan.' });
      return;
    }
    log('Waar ben ik: ' + ({ hunt: 'in de hunt', refill: 'bij het depot', toHunt: 'onderweg naar de hunt', toDepot: 'bij de tempel' })[choice] + (missing ? ', uitrusting mist' : '') + '.');
    if (choice !== phase || choice !== 'hunt') setPhase(choice);
  }

  // Na een death: op OK klikken, wachten tot je weer in de wereld staat.
  function deathTick(now) {
    var api = B.api;
    var di = deathInfo;
    if (now - di.at > 180000) {
      deathInfo = null;
      setPhase('hunt');
      pause('death');
      emit('alert', { reason: 'death', action: 'pause', message: 'Na de death lukt opnieuw inloggen niet. Log zelf in en druk op Start.' });
      return;
    }
    if (safeCall(function () { return api.modalVisible('death-modal'); }, false)) {
      di.aliveSince = 0;
      if (!di.okAt || now - di.okAt > 4000) {
        di.okAt = now;
        safeCall(function () { api.clickModalButton('death-modal', 'confirm'); });
      }
      return;
    }
    var ready = safeCall(function () { return api.ready(); }, false);
    var p = ready ? safeCall(function () { return api.player(); }, null) : null;
    if (!p || p.isDead || now - di.at < 4000) { di.aliveSince = 0; return; }
    if (!di.aliveSince) di.aliveSince = now;
    // 3 seconden stabiel in de wereld: op naar het depot, of met
    // restock.skipDepot meteen vanaf de tempel naar de hunt.
    if (now - di.aliveSince > 3000) {
      deathInfo = null;
      if (!(config.restock && config.restock.skipDepot)) { setPhase('toDepot'); return; }
      // Zonder backpack niet naar de hunt: in de tempel blijven en melden.
      if (!safeCall(function () { return api.equipSlotItem(6); }, null)) {
        setPhase('hunt');
        pause('restock');
        emit('alert', { reason: 'restock', action: 'pause', message: 'Na de death heb je geen backpack. Ik blijf in de tempel en ga niet naar de huntplek.' });
        return;
      }
      setPhase('toHunt');
    }
  }

  function startRefill() {
    if (refillBusy) return;
    if (!B.depot) {
      phase = 'hunt';
      pause('restock');
      emit('alert', { reason: 'restock', action: 'pause', message: 'Refill-functie is niet geladen.' });
      return;
    }
    refillBusy = true;
    var gen = ++refillGen;
    // De refill stopt zelf zodra de bot pauzeert, stopt of de fase wisselt.
    var canContinue = function () { return gen === refillGen && state === 'running' && phase === 'refill'; };
    Promise.resolve(B.depot.refill(config.restock, canContinue)).then(function (r) {
      if (gen !== refillGen) return; // oude refill: negeren
      refillBusy = false;
      if (state !== 'running' || phase !== 'refill' || (r && r.aborted)) return;
      if (r && r.ok) {
        setPhase('toHunt');
      } else {
        var what = r && r.missing && r.missing.length ? 'Mist: ' + r.missing.join(', ') + '.' : ((r && r.error) || 'Onbekende fout.');
        pause('restock');
        emit('alert', { reason: 'restock', action: 'pause', message: 'Refill niet compleet. ' + what + ' Los het op en druk op Doorgaan.' });
      }
    }).catch(function (e) {
      if (gen !== refillGen) return;
      refillBusy = false;
      pause('restock');
      emit('alert', { reason: 'restock', action: 'pause', message: 'Fout bij refillen: ' + e.message });
    });
  }

  // Lus

  // Tijdens een pauze blijven we healen, zodat je character niet sterft
  // als de bot stilstaat (bijv. om een speler in de buurt).
  // Niet bij death of disconnect: dan valt er niets te healen.
  function healWhilePaused() {
    // Tijdens de anti-bot-controle doet de bot helemaal niets.
    if (!B.healing || pauseReason === 'death' || pauseReason === 'disconnect' || pauseReason === 'captcha') return;
    var api = B.api;
    if (!safeCall(function () { return api.ready(); }, false)) return;
    var player = safeCall(function () { return api.player(); }, null);
    if (!player || player.isDead) return;
    try {
      B.healing.tick({ now: Date.now(), player: player, creatures: [], config: config, route: route, state: state, log: log, emit: emit });
    } catch (e) { /* volgende tick weer */ }
  }

  // Quiz komt eraan (aankondiging in de chat, ~10 s vooraf): niet meer aanvallen
  // en naar het dichtstbijzijnde routepunt zonder monsters in de buurt lopen.
  // Gaat het venster open, dan pauzeert safety de bot zoals altijd.
  var QUIZ_PREP_MS = 15000;
  var QUIZ_CLEAR = 6;      // geen monster binnen zoveel tegels van de plek
  var QUIZ_REACH = 15;     // alleen plekken binnen zoveel tegels
  var quizPrep = null;     // { at, spot, checkedAt }
  function quizComing() {
    var now = Date.now();
    if (quizPrep && now - quizPrep.at < QUIZ_PREP_MS) return { ok: true };
    quizPrep = { at: now, spot: null, checkedAt: 0 };
    log('Quiz komt eraan: ik stop met aanvallen en zoek een plek zonder monsters.');
    return { ok: true };
  }
  function quizActive(now) { return !!quizPrep && now - quizPrep.at < QUIZ_PREP_MS; }
  function quizSafeSpot(player, creatures, rt) {
    var mons = creatures.filter(function (c) { return c.type === 1 && c.hpPct > 0 && c.z === player.z; });
    var spots = ((config.quiz && config.quiz.safeSpots) || []).slice();
    ((rt && rt.waypoints) || []).forEach(function (w) { if (!w.type || w.type === 'walk' || w.type === 'stand') spots.push(w); });
    var best = null, bestD = Infinity;
    spots.forEach(function (s) {
      if (s.z !== player.z) return;
      var d = Math.max(Math.abs(s.x - player.x), Math.abs(s.y - player.y));
      if (d > QUIZ_REACH || d >= bestD) return;
      for (var i = 0; i < mons.length; i++) {
        if (Math.max(Math.abs(s.x - mons[i].x), Math.abs(s.y - mons[i].y)) < QUIZ_CLEAR) return;
      }
      best = s; bestD = d;
    });
    return best;
  }
  function quizPrepTick(player, creatures, rt, now) {
    if (player.targetId) safeCall(function () { B.api.clearTarget(); });
    if (!quizPrep.spot || now - quizPrep.checkedAt > 2000) {
      quizPrep.checkedAt = now;
      var s = quizSafeSpot(player, creatures, rt);
      if (s && (!quizPrep.spot || s.x !== quizPrep.spot.x || s.y !== quizPrep.spot.y)) log('Quiz: ik loop naar ' + s.x + ',' + s.y + ',' + s.z + '.');
      quizPrep.spot = s;
    }
    var spot = quizPrep.spot;
    if (!spot) return;   // geen rustige plek binnen bereik: blijven staan en healen
    if (spot.x === player.x && spot.y === player.y) { cancelWalk(); return; }
    safeCall(function () { B.api.walkTo(spot.x, spot.y, spot.z); });
  }

  // Dood gegaan tijdens een pauze: dat ook melden (één keer per pauze).
  var deathAlerted = false;
  function deathWhilePaused() {
    var p = safeCall(function () { return B.api.player(); }, null);
    if (pauseReason === 'death') return; // die death is al gemeld
    var dead = (p && p.isDead) || safeCall(function () { return B.api.modalVisible('death-modal'); }, false);
    if (dead && !deathAlerted) {
      deathAlerted = true;
      emit('alert', { reason: 'death', action: 'pause', message: 'Je character is doodgegaan terwijl de bot op pauze stond (' + pauseReason + ').' });
    } else if (!dead) deathAlerted = false;
  }

  // Terugvechten tijdens een pauze: valt een monster ons aan en staat het
  // dichtbij, dan aanvallen zonder te lopen. Anders sterf je als de bot stilstaat.
  // Niet bij een handmatige pauze (dan speel je zelf), anti-bot-controle, GM, death of disconnect.
  var lastDefendId = null;
  var lastDefendAt = 0;
  var DEFEND_REASONS = { waar: 1, verdieping: 1, restock: 1, player: 1 };
  function defendWhilePaused() {
    if (!DEFEND_REASONS[pauseReason] || wrongCharacter()) return;
    var me = safeCall(function () { return B.api.player(); }, null);
    if (!me || me.isDead || me.targetId) return;
    var list = safeCall(function () { return B.api.creatures(); }, []) || [];
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c.type !== 1 || c.masterId || !(c.hpPct > 0) || c.z !== me.z || !c.targetsMe || c.canSee === false) continue;
      var d = B.api.distance(me, c);
      if (d <= 3 && (!best || d < best.d)) best = { c: c, d: d };
    }
    if (best && best.c.id !== lastDefendId) {
      lastDefendId = best.c.id;   // één keer per monster loggen en aanvallen
      safeCall(function () { return B.api.attack(best.c.id); }, false);
      log('Pauze, maar ' + best.c.name + ' valt aan: ik vecht terug.');
    } else if (best && Date.now() - lastDefendAt > 2000) {
      lastDefendAt = Date.now();  // zelfde monster: hooguit eens per 2 s opnieuw aanvallen, zonder log
      safeCall(function () { return B.api.attack(best.c.id); }, false);
    }
  }

  function tick() {
    if (busy || !B.api) return;
    if (state === 'paused') {
      // Storing voorbij: 5 seconden klaar, dan vanzelf verder.
      if (pauseReason === 'disconnect') {
        var ok = safeCall(function () { return B.api.ready() && !!B.api.player(); }, false);
        if (!ok) readySince = 0;
        else if (!readySince) readySince = Date.now();
        else if (Date.now() - readySince > 5000) { readySince = 0; resume(); log('Verbinding is terug. De bot gaat verder.'); }
        return;
      }
      healWhilePaused();
      deathWhilePaused();
      defendWhilePaused();
      return;
    }
    if (state !== 'running') return;
    // Ander character ingelogd terwijl de bot loopt (bijv. na opnieuw inloggen): stoppen.
    var otherChar = wrongCharacter();
    if (otherChar) {
      stop();
      emit('alert', { reason: 'character', action: 'stop', message: otherChar + ' is ingelogd, maar de instellingen zijn voor een ander character. De bot is gestopt.' });
      return;
    }
    busy = true;
    try {
      var api = B.api;
      var ready = safeCall(function () { return api.ready(); }, false);
      var player = ready ? safeCall(function () { return api.player(); }, null) : null;
      var creatures = ready ? safeCall(function () { return api.creatures(); }, []) || [] : [];

      // Route en instellingen hangen af van de fase. Onderweg (naar depot of
      // hunt) lopen we de route één keer, zonder lus.
      var activeRoute = phase === 'hunt' || !phaseRoute ? route : phaseRoute;
      var ctxConfig = phase === 'hunt' ? config : Object.assign({}, config, { cavebot: Object.assign({}, config.cavebot, { loop: false }) });
      var ctx = {
        now: Date.now(),
        player: player,
        creatures: creatures,
        config: ctxConfig,
        route: activeRoute,
        state: state,
        log: log,
        emit: function (type, payload) {
          if (type === 'routeEnd') routeEnded = true;
          emit(type, payload);
        }
      };

      // Teleport = een sprong van meer dan 10 tegels tussen twee metingen.
      // Ver van de route raken door achter monsters aan te lopen is geen teleport.
      if (player && phase !== 'death') {
        if (lastPos && ctx.now - lastPos.t < 3000 && player.z === lastPos.z &&
            Math.max(Math.abs(player.x - lastPos.x), Math.abs(player.y - lastPos.y)) > 10) {
          teleportAt = ctx.now;
          log('Sprong van ' + lastPos.x + ',' + lastPos.y + ' naar ' + player.x + ',' + player.y + ': dat lijkt een teleport.');
        }
        // Onverwacht op een andere verdieping (bijv. door een gat gevallen)?
        // Gepland is het alleen bij een trap-, touw- of use-waypoint vlakbij.
        if (lastPos && ctx.now - lastPos.t < 3000 && player.z !== lastPos.z && phase === 'hunt' && !player.isDead && player.hp > 0 &&
            !plannedFloorChange(activeRoute, lastPos)) {
          var from = lastPos;
          lastPos = null;
          pause('verdieping');
          emit('alert', { reason: 'floor', action: 'pause', message: 'Ik ben onverwacht van verdieping ' + from.z + ' naar ' + player.z + ' gegaan (bij ' + from.x + ',' + from.y + '). Misschien een gat. Breng de bot terug en druk op Doorgaan.' });
          return;
        }
        lastPos = { x: player.x, y: player.y, z: player.z, t: ctx.now };
        if (B.kite && B.kite.note) B.kite.note(player);   // voor kiten: waar kwamen we vandaan
        // 'There is no way.': melden met plek, waypoint en doel, zodat het uitgezocht kan worden.
        var nw = B.api.takeNoWay ? safeCall(function () { return B.api.takeNoWay(); }, null) : null;
        if (nw) {
          var wpNow = activeRoute && activeRoute.waypoints ? activeRoute.waypoints[safeCall(function () { return B.cavebot.getIndex(); }, -1)] : null;
          var msgNw = 'There is no way op ' + nw.x + ',' + nw.y + ',' + nw.z +
            (nw.dest ? ' (naar ' + nw.dest.x + ',' + nw.dest.y + ')' : '') +
            (wpNow ? ', waypoint ' + wpNow.x + ',' + wpNow.y : '') +
            (player.targetId ? ', doel ' + player.targetId : '') + '.';
          log(msgNw);
          emit('alert', { reason: 'noway', action: 'alert', message: msgNw });
        }
      }

      // Na een death: eerst opnieuw in de wereld komen.
      if (phase === 'death') { mode = 'action'; lastPos = null; deathTick(ctx.now); return; }

      // 1. Veiligheid
      if (B.safety) {
        var s = null;
        try { s = B.safety.check(ctx); } catch (e) { log('Fout in safety: ' + e.message); }
        if (s && s.action === 'stop') {
          stop();
          wanted = false; // ook zonder server: niet meer vanzelf inloggen
          emit('alert', { reason: s.reason, action: 'stop', from: s.from, message: s.message });
          return;
        }
        if (s && s.action === 'pause' && s.reason === 'death' && restockOn()) {
          cancelWalk();
          emit('alert', { reason: 'death', action: 'alert', message: 'Je bent dood gegaan. De bot logt opnieuw in en gaat refillen.' });
          deathInfo = { at: ctx.now, okAt: 0, aliveSince: 0 };
          setPhase('death');
          return;
        }
        if (s && s.action === 'pause') {
          pause(s.reason);
          cancelWalk();
          if (!s.silent) emit('alert', { reason: s.reason, action: 'pause', message: s.message });
          return;
        }
        if (s && s.action === 'alert') {
          emit('alert', { reason: s.reason, action: 'alert', message: s.message });
        }
      }

      if (!ready || !player) { mode = 'idle'; return; }

      // Net gestart of verder na een storing: eerst kijken waar we zijn.
      if (needDecide && configReceived && route.waypoints.length && (routesReceived || !restockOn())) {
        needDecide = false;
        decidePhase(player);
        if (state !== 'running') return;
      }

      // 2. Healing
      if (B.healing) {
        try {
          var hres = B.healing.tick(ctx);
          // Tellen hoe vaak elke soort toets is gedrukt (zichtbaar in de status).
          if (hres && hres.type) keyCount[hres.type + ' F' + hres.hotkey] = (keyCount[hres.type + ' F' + hres.hotkey] || 0) + 1;
        } catch (e) { log('Fout in healing: ' + e.message); }
      }

      // Refillen: alleen healen, niets anders.
      if (phase === 'refill') { mode = 'action'; startRefill(); return; }

      // Quiz komt eraan: alleen healen en naar een rustige plek lopen.
      if (quizActive(ctx.now)) { mode = 'walking'; quizPrepTick(player, creatures, activeRoute, ctx.now); return; }

      // 3. Targeting (niet op weg naar het depot: dan heb je niets aan)
      var fighting = false;
      var approachTo = null;
      if (B.targeting && phase !== 'toDepot') {
        try {
          // Onderweg naar de hunt of zelf terug naar de route: alleen vechten wat
          // dichtbij is, niet achter monsters aan lopen. Anders raakt de bot ver van de route.
          var tctx = ctx;
          if (phase === 'toHunt' || seek) {
            var tc = Object.assign({}, (ctx.config && ctx.config.targeting) || {});
            tc.maxDistance = Math.min(Number(tc.maxDistance) || 7, 3);
            tc.approachDistance = 0;
            tctx = Object.assign({}, ctx, { config: Object.assign({}, ctx.config, { targeting: tc }) });
          }
          var t = B.targeting.tick(tctx);
          fighting = !!(t && t.fighting);
          approachTo = t && t.approach;
          // Afstand houden (paladin): één stap weg of naar het doel toe.
          if (fighting && B.kite) B.kite.tick(ctx, t.targetId);
        } catch (e) { log('Fout in targeting: ' + e.message); }
      }

      // Uitrusting wisselen per doel (bijv. schild bij een Ghost).
      if (B.gearswap) safeCall(function () { B.gearswap.tick(ctx); });
      // Spullen naast je van de grond oppakken (bijv. bolts), ook tijdens vechten.
      if (B.pickup) safeCall(function () { B.pickup.grab(ctx); });

      if (fighting) {
        // Het lopen naar een waypoint stopt al in B.api.attack, vóór het aanvallen.
        // Hier niet nog eens stoppen: dat breekt het achtervolgen van het monster af.
        wasFighting = true;
        approachCommit = null; // bij het monster aangekomen: minimale looptijd klaar
        mode = 'fighting';
        if (seek) seek.until = Math.max(seek.until, ctx.now + 60000); // vechten telt niet mee voor de 3 minuten
        return;
      }
      if (wasFighting && B.cavebot && B.cavebot.kick) safeCall(function () { B.cavebot.kick(); });   // meteen door na een kill
      wasFighting = false;

      // Zelf op weg naar een route (stond nergens in de buurt).
      if (seek) { mode = 'walking'; seekTick(player, ctx.now); return; }

      // Rustig en er ligt iets (bijv. bolts) een paar tegels verder: even heen lopen.
      var pt = B.pickup ? safeCall(function () { return B.pickup.walkTarget(ctx); }, null) : null;
      if (pt) {
        safeCall(function () { return B.api.walkTo(pt.x, pt.y, pt.z); }, false);
        mode = 'walking';
        return;
      }

      // Monster net buiten beeld: even ernaartoe lopen in plaats van de route.
      // Hooguit één keer per seconde opnieuw sturen.
      // Minimale looptijd: is de bot net naar een monster gaan lopen, dan krijgt
      // hij minstens approachMinMs om daar te komen, ook als het monster even
      // uit de lijst valt (bijv. net uit beeld). Hij loopt dan door naar de plek
      // waar het monster het laatst stond. Vechten gaat altijd voor (zie boven).
      var minWalk = Number(((ctx.config && ctx.config.targeting) || {}).approachMinMs);
      if (!(minWalk >= 0)) minWalk = 2000;
      if (approachTo) {
        if (!approachCommit || approachCommit.id !== approachTo.id) approachCommit = { id: approachTo.id, since: ctx.now };
        approachCommit.x = approachTo.x; approachCommit.y = approachTo.y; approachCommit.z = approachTo.z; approachCommit.name = approachTo.name;
      } else if (approachCommit) {
        var reached = player.x === approachCommit.x && player.y === approachCommit.y;
        if (phase !== 'toDepot' && ctx.now - approachCommit.since < minWalk && approachCommit.z === player.z && !reached) {
          approachTo = { id: null, x: approachCommit.x, y: approachCommit.y, z: approachCommit.z, name: approachCommit.name };
        } else {
          approachCommit = null;
        }
      }
      lastApproachName = approachTo ? approachTo.name + ' op ' + approachTo.x + ',' + approachTo.y : null;
      if (approachTo) {
        if (!lastApproachAt || ctx.now - lastApproachAt > 1000) {
          lastApproachAt = ctx.now;
          var okA = safeCall(function () { return B.api.walkTo(approachTo.x, approachTo.y, approachTo.z); }, false);
          // Drie keer achter elkaar geen pad naar dit monster (bijv. achter een muur)?
          // Dan er niet meer naartoe lopen. Komt hij zelf in beeld, dan valt de bot hem gewoon aan.
          if (okA) approachFails = 0;
          else if (approachTo.id != null && ++approachFails >= 3 && B.targeting && B.targeting.skipApproach) {
            approachFails = 0;
            B.targeting.skipApproach(approachTo.id);
            log(approachTo.name + ' buiten beeld is niet te bereiken. Ik loop er even niet meer naartoe.');
            lastApproachAt = 0;
            approachCommit = null;
          }
        }
        mode = 'walking';
        return;
      }
      // Net nog naar een monster gelopen? Die loopopdracht eerst even laten
      // afmaken, anders stuurt de route hem meteen de andere kant op.
      if (lastApproachAt && ctx.now - lastApproachAt < 1500) { mode = 'walking'; return; }

      // Ineens ver van de route (meer dan 15 tegels, of geen waypoint op deze
      // verdieping)? Bijvoorbeeld naar de tempel geteleporteerd terwijl je
      // leeft. Dan niet blind verder: pauzeren en melden. Jij kijkt wat er is.
      if (phase === 'hunt' || phase === 'toHunt' || phase === 'toDepot') {
        if (nearestDist(player, activeRoute) > 15) {
          if (!farSince) farSince = ctx.now;
          else if (ctx.now - farSince > 5000 && !(ctx.now - teleportAt < 120000)) {
            // Geen sprong gezien: we zijn zelf afgedwaald (achter monsters aan).
            // Dan zelf terug naar de route lopen in plaats van pauzeren.
            farSince = 0;
            if (startSeek(player, [activeRoute])) { mode = 'walking'; return; }
            cancelWalk();
            pause('waar');
            emit('alert', { reason: 'restock', action: 'pause', message: 'Ik ben te ver van de route afgedwaald (op ' + player.x + ',' + player.y + ',' + player.z +
              ') en kan er niet zelf naartoe lopen. Breng de bot terug en druk op Doorgaan.' });
            return;
          } else if (ctx.now - farSince > 5000) {
            farSince = 0;
            cancelWalk();
            pause('waar');
            emit('alert', { reason: 'restock', action: 'pause', message: 'Je staat ineens ver van je route, op ' + player.x + ',' + player.y + ',' + player.z +
              ' (HP ' + player.hpPct + '%). Misschien ben je geteleporteerd. Kijk even in het spel en druk daarna op Doorgaan.' });
            return;
          }
        } else farSince = 0;
      }

      // Vastzit-controle zet even een stap opzij: cavebot dan niet sturen.
      if (B.stuck && B.stuck.holding(ctx.now)) { mode = 'walking'; return; }

      // 4. Cavebot
      if (B.cavebot) {
        try {
          var c = B.cavebot.tick(ctx);
          mode = (c && c.mode) || 'idle';
          // Einde van een route onderweg: door naar de volgende fase.
          if (routeEnded && phase === 'toDepot') setPhase('refill');
          else if (routeEnded && phase === 'toHunt') setPhase('hunt');
        } catch (e) {
          mode = 'idle';
          log('Fout in cavebot: ' + e.message);
        }
      } else {
        mode = 'idle';
      }
    } catch (e) {
      log('Fout in de lus: ' + e.message);
    } finally {
      busy = false;
    }
  }

  // Status

  function getStatus() {
    var now = Date.now();
    var api = B.api;
    var ready = !!(api && safeCall(function () { return api.ready(); }, false));
    var player = ready ? safeCall(function () { return api.player(); }, null) : null;
    var creatures = ready ? safeCall(function () { return api.creatures(); }, []) || [] : [];

    var target = null;
    var monstersNear = [];
    var playersNear = [];

    if (player) {
      creatures.forEach(function (c) {
        if (!c || c.id === player.id) return;
        var dist = safeCall(function () { return api.distance(player, c); }, Infinity);
        if (player.targetId && c.id === player.targetId) {
          target = { id: c.id, name: c.name, hpPct: c.hpPct, dist: dist };
        }
        if (!(dist <= NEAR)) return;
        if (c.type === 1 && c.hpPct > 0) monstersNear.push({ name: c.name, dist: dist, id: c.id, x: c.x, y: c.y, z: c.z });
        else if (c.type === 0) playersNear.push({ name: c.name, dist: dist });
      });
      var byDist = function (a, b) { return a.dist - b.dist; };
      monstersNear.sort(byDist);
      playersNear.sort(byDist);
      monstersNear = monstersNear.slice(0, 10);
    }

    var index = B.cavebot ? safeCall(function () { return B.cavebot.getIndex(); }, 0) : 0;
    var end = state === 'stopped' ? (stats.stoppedAt || now) : now;
    var runtimeMs = stats.startedAt ? Math.max(0, end - stats.startedAt) : 0;
    var hours = runtimeMs / 3600000;
    var killsPerHour = runtimeMs >= 60000 ? Math.round((stats.kills / hours) * 10) / 10 : 0;

    return {
      ready: ready,
      state: state,
      pauseReason: pauseReason,
      mode: state === 'running' ? mode : 'idle',
      player: player,
      target: target,
      waypointIndex: index,
      waypointCount: route.waypoints.length,
      routeName: route.name,
      monstersNear: monstersNear,
      playersNear: playersNear,
      stats: { kills: stats.kills, startedAt: stats.startedAt, runtimeMs: runtimeMs, killsPerHour: killsPerHour, keys: keyCount },
      version: B.version || 'onbekend',
      timerMode: B.timerMode || 'gewoon',
      hidden: document.hidden === true,
      recording: !!(B.recorder && B.recorder.active()),
      experience: player ? safeCall(function () { return api.experience(); }, null) : null,
      wallet: player ? safeCall(function () { return api.wallet(); }, null) : null,
      // Voorraad in de backpacks: life rings (3052) en UH-runes (3160, telt charges).
      supplies: player ? safeCall(function () { return { lifeRings: api.countItem(3052), uh: api.countItem(3160), manaFluids: api.countFluid(2874, 7) }; }, null) : null,
      phase: phase,
      stuck: B.stuck ? safeCall(function () { return B.stuck.info(); }, null) : null,
      time: now
    };
  }

  // Vastzit-controle: alleen als de bot speelt en jaagt of onderweg is.
  function stuckCheck(st) {
    if (!B.stuck) return;
    var active = state === 'running' && (phase === 'hunt' || phase === 'toDepot' || phase === 'toHunt');
    B.stuck.check({
      now: st.time,
      active: active && !!st.player,
      player: st.player,
      creatures: active ? safeCall(function () { return B.api.creatures(); }, []) || [] : [],
      target: st.target,
      mode: mode,
      kills: stats.kills,
      approach: lastApproachName,
      route: phase === 'hunt' || !phaseRoute ? route : phaseRoute,
      index: st.waypointIndex,
      log: log,
      emit: emit
    });
  }

  function sendStatus() {
    try {
      var st = getStatus();
      safeCall(function () { stuckCheck(st); });
      emit('status', st);
    } catch (e) { /* volgende keer weer */ }
    safeCall(tryResumeAfterReload);
    persist();
  }

  B.engine = {
    start: start,
    stop: stop,
    pause: pause,
    resume: resume,
    setConfig: setConfig,
    setRoute: setRoute,
    setRoutes: setRoutes,
    setWanted: function (v) { wanted = !!v; return { ok: true }; },
    getWanted: function () { return wanted; },
    command: command,
    getStatus: getStatus,
    emit: emit,
    getState: function () { return state; },
    getConfig: function () { return config; },
    quizComing: quizComing,
    // Hoort de bot aan te staan? (voor automatisch inloggen)
    wantsActive: function () { return state === 'running' || (state === 'paused' && pauseReason === 'disconnect') || !!pendingResume; },
    log: log
  };

  // Lus en status-timer starten direct bij laden. De bot zelf blijft 'stopped' tot Start.
  // Worker-timer (zie timer.js): loopt ook door als het tabblad op de achtergrond staat.
  if (B.every) { B.every(tick, TICK_MS); B.every(sendStatus, STATUS_MS); }
  else { setInterval(tick, TICK_MS); setInterval(sendStatus, STATUS_MS); }
  B.__loaded = true;
})(window.WJBot = window.WJBot || {});
