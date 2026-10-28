(function (B) {
  'use strict';

  // Depot: vrije locker zoeken en openen, en daarna refillen (uitrusting
  // aantrekken en spullen in de backpack leggen). Alles werkt op itemnaam.
  // De functies zijn async en wachten steeds op het antwoord van de server.
  if (B.depot) return;

  var EQUIP_SLOTS = { helm: 0, armor: 1, legs: 2, boots: 3, wapen: 4, schild: 5, backpack: 6, ketting: 7, ring: 8, pijlen: 9 };

  function g() { return window.gameClient; }
  function me() { return g() && g().player; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Rustig aan: tussen twee acties in het depot minstens STEP_MS pauze.
  var STEP_MS = 700;
  var lastAction = 0;
  var shouldGo = null; // functie: mag de refill doorgaan? (null = altijd)
  var busy = false;    // refill bezig: automove doet dan niets
  async function pace() {
    var wait = lastAction + STEP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    // Gepauzeerd, gestopt of dood: direct stoppen, geen acties meer naar de server.
    if (shouldGo && !shouldGo()) throw new Error('afgebroken');
    lastAction = Date.now();
  }
  async function send(packet) {
    await pace();
    g().send(packet);
  }
  function name(item) {
    try { return String(((g().itemDefinitions[g().sidByCid[item.id]] || {}).properties || {}).name || '').toLowerCase(); } catch (e) { return ''; }
  }
  function log(msg) { if (B.engine && B.engine.log) B.engine.log(msg); }
  function opened() { return Array.from(me().__openedContainers || []); }
  function depot() { return me().getContainer(1) || null; }
  function Pos() { return me().__position.constructor; }
  function tileAt(x, y, z) { var P = Pos(); return g().world.getTileFromWorldPosition(new P(x, y, z)); }
  function itemType(id) {
    try { return ((g().itemDefinitions[g().sidByCid[id]] || {}).properties || {}).type || ''; } catch (e) { return ''; }
  }

  // Wacht tot fn() iets teruggeeft, max ms.
  async function until(fn, ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      var v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  // ---------- Locker ----------

  // Vrije plekken voor lockers binnen 8 tegels, dichtstbijzijnde eerst.
  function freeLockerSpots() {
    var p = me().__position;
    var list = [];
    for (var dx = -8; dx <= 8; dx++) {
      for (var dy = -8; dy <= 8; dy++) {
        var t = tileAt(p.x + dx, p.y + dy, p.z);
        if (!t || !(t.items || []).some(function (it) { return itemType(it.id) === 'depot'; })) continue;
        [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(function (a) {
          var sx = p.x + dx + a[0];
          var sy = p.y + dy + a[1];
          var s = tileAt(sx, sy, p.z);
          var here = sx === p.x && sy === p.y;
          if (s && s.isWalkable() && (here || !s.isOccupied())) {
            list.push({ lx: p.x + dx, ly: p.y + dy, sx: sx, sy: sy, z: p.z, d: Math.max(Math.abs(sx - p.x), Math.abs(sy - p.y)) });
          }
        });
      }
    }
    list.sort(function (a, b) { return a.d - b.d; });
    return list;
  }

  // Naar een vrije locker lopen en hem openen. Probeert tot 3 plekken.
  async function openLocker() {
    if (depot()) return true;
    var tries = freeLockerSpots().slice(0, 3);
    for (var i = 0; i < tries.length; i++) {
      var c = tries[i];
      var s = tileAt(c.sx, c.sy, c.z);
      var p = me().__position;
      if (s && s.isOccupied() && !(p.x === c.sx && p.y === c.sy)) continue; // net bezet geraakt
      B.api.walkTo(c.sx, c.sy, c.z);
      var there = await until(function () { var q = me().__position; return q.x === c.sx && q.y === c.sy; }, 10000);
      if (!there) continue;
      await pace();
      B.api.useTile(c.lx, c.ly, c.z);
      if (await until(depot, 3000)) { log('Depot geopend.'); return true; }
    }
    log('Geen vrije locker gevonden of de locker ging niet open.');
    return false;
  }

  // ---------- Containers ----------

  // Een container openen die als item in een andere container ligt. Geeft de nieuwe container.
  // Containers die uit het depot komen. Het spel geeft ze geen depot-kenmerk,
  // dus we onthouden ze zelf (zie ook B.api: isDepotContainer).
  var fromDepot = new Set();

  // Het spel reageert soms niet op een klik (te snel na de vorige).
  // Daarom tot 3 keer proberen, met een korte pauze ertussen.
  async function openInside(parent, slot) {
    var before = new Set(opened().map(function (c) { return c.__containerId; }));
    var isNew = function () { return opened().find(function (c) { return !before.has(c.__containerId); }) || null; };
    var nc = null;
    for (var attempt = 0; attempt < 3 && !nc; attempt++) {
      if (attempt > 0) {
        await sleep(1000);
        nc = isNew(); // toch nog laat open gegaan?
        if (nc) break;
      }
      await send(new ItemUsePacket({ which: parent, index: slot }));
      nc = await until(isNew, 2500);
    }
    if (nc && (parent.__containerId === 1 || fromDepot.has(parent.__containerId))) fromDepot.add(nc.__containerId);
    return nc;
  }

  // Container sluiten en wachten tot hij echt dicht is.
  async function closeContainer(c) {
    if (!c) return;
    var id = c.__containerId;
    fromDepot.delete(id);
    try { await send(new ContainerClosePacket(id)); } catch (e) { /* niets */ }
    await until(function () { return !opened().some(function (x) { return x.__containerId === id; }); }, 3000);
    await sleep(150);
  }

  // Alle vensters dicht behalve het depot en je eigen backpack.
  async function closeExtras() {
    var extra = opened().filter(function (c) { return c.__containerId !== 1 && c.__title !== 'Main Backpack'; });
    for (var i = 0; i < extra.length; i++) await closeContainer(extra[i]);
  }

  // Overzicht van de depot-backpacks: welke itemnaam in welk depot-vak zit.
  // Eén keer per refill gemaakt, zodat we daarna gericht kunnen openen.
  var depotIndex = null;
  async function buildIndex() {
    depotIndex = {};
    var d = depot();
    if (!d) return;
    await closeExtras();
    for (var i = 0; i < d.size; i++) {
      var it = d.getSlotItem(i);
      if (!it || name(it) !== 'backpack') continue;
      var bp = await openInside(d, i);
      if (!bp) continue;
      for (var k = 0; k < bp.size; k++) {
        var x = bp.getSlotItem(k);
        if (x && depotIndex[name(x)] == null) depotIndex[name(x)] = i;
      }
      await closeContainer(bp);
    }
  }

  function findSlot(cont, wanted) {
    for (var i = 0; i < cont.size; i++) {
      var it = cont.getSlotItem(i);
      if (it && name(it) === wanted) return i;
    }
    return -1;
  }

  // Zoek een item: eerst los in het depot, daarna in de backpacks in het depot.
  // Geeft { cont, slot, close } (close = container die we daarna weer sluiten).
  async function findInDepot(wanted) {
    var d = depot();
    if (!d) return null;
    // Een backpack nooit los uit het depot pakken: dat zijn je voorraad-backpacks.
    var s = wanted === 'backpack' ? -1 : findSlot(d, wanted);
    if (s >= 0) return { cont: d, slot: s, close: null };
    // Twee pogingen: klopt het overzicht niet meer (vakken opgeschoven),
    // dan het depot opnieuw bekijken.
    for (var round = 0; round < 2; round++) {
      if (!depotIndex || round === 1) await buildIndex();
      var at = depotIndex[wanted];
      if (at == null) return null;
      var atItem = d.getSlotItem(at);
      if (!atItem || name(atItem) !== 'backpack') continue;
      await closeExtras();
      var bp = await openInside(d, at);
      if (!bp) continue;
      var k = findSlot(bp, wanted);
      if (k >= 0) return { cont: bp, slot: k, close: bp };
      await closeContainer(bp);
    }
    return null;
  }

  // De backpack die je draagt, open. Geeft de container of null.
  // Openen via het backpack-vak. Stond hij al open, dan sluit de eerste klik
  // hem; daarom nog één keer proberen.
  async function wornBackpack() {
    var eq = me().equipment;
    if (!eq.getSlotItem(EQUIP_SLOTS.backpack)) return null;
    // Staat hij al open? Het spel noemt dat venster "Main Backpack".
    var already = opened().find(function (c) { return c.__title === 'Main Backpack'; });
    if (already) return already;
    var bag = await openInside(eq, EQUIP_SLOTS.backpack);
    if (!bag) bag = await openInside(eq, EQUIP_SLOTS.backpack);
    return bag;
  }

  // ---------- Refill ----------

  // Alle items uit de autoMove-regels met toDepot (bijv. crystal coins) uit je
  // backpack en uitrustingsvak naar het open depot. Geeft het aantal verplaatsingen.
  async function depositValuables() {
    var cfg = B.engine && B.engine.getConfig ? B.engine.getConfig() : null;
    var rules = ((cfg && cfg.autoMove) || []).filter(function (r) { return r && r.enabled !== false && r.toDepot !== false; });
    var moves = 0;
    for (var i = 0; i < rules.length; i++) {
      var id = Number(rules[i].itemId);
      var slot = Number(rules[i].slot);
      for (var n = 0; n < 10; n++) { // hooguit 10 stapels per item
        var target = B.api.depotTarget();
        if (!target) return moves;
        var bag = B.api.findItem(id);
        var q = slot >= 0 && slot <= 9 ? B.api.equipSlotItem(slot) : null;
        var from = bag ? { cid: bag.cid, slot: bag.slot } : (q && q.id === id ? { equip: slot } : null);
        if (!from) break;
        var cnt = bag ? bag.count : q.count;
        var before = B.api.countItem(id) + (q && q.id === id ? q.count : 0);
        await pace();
        if (!B.api.moveToContainer(from, target, cnt)) break;
        var gone = await until(function () {
          var q2 = B.api.equipSlotItem(slot);
          return B.api.countItem(id) + (q2 && q2.id === id ? q2.count : 0) < before;
        }, 6000);
        if (!gone) break;
        moves++;
      }
    }
    return moves;
  }

  // plan = { equip: [{ slot: 'helm', item: 'chain helmet' }, ...], backpack: [{ item: 'rope', count: 1 }, ...] }
  async function refill(plan, canContinue) {
    shouldGo = typeof canContinue === 'function' ? canContinue : null;
    busy = true;
    // Oude depot-vensters vergeten: het spel gebruikt nummers opnieuw.
    fromDepot.forEach(function (id) { if (!opened().some(function (c) { return c.__containerId === id; })) fromDepot.delete(id); });
    try {
      return await refillInner(plan || {});
    } catch (e) {
      if (e && e.message === 'afgebroken') return { ok: false, aborted: true, error: 'Refill afgebroken.' };
      throw e;
    } finally {
      busy = false;
      shouldGo = null;
    }
  }

  async function refillInner(plan) {
    if (!depot() && !(await openLocker())) return { ok: false, error: 'Er is geen vrije locker gevonden of de locker ging niet open.' };
    var eq = me().equipment;
    var done = [];
    var missing = [];
    depotIndex = null; // depot opnieuw bekijken, de inhoud kan veranderd zijn

    // 1. Uitrusting (backpack eerst, zodat er plek is voor de rest).
    var equip = (plan.equip || []).slice().sort(function (a, b) { return (a.slot === 'backpack' ? -1 : 0) - (b.slot === 'backpack' ? -1 : 0); });
    for (var i = 0; i < equip.length; i++) {
      var e = equip[i];
      var slot = EQUIP_SLOTS[e.slot];
      if (slot == null || eq.getSlotItem(slot)) continue; // vak al gevuld
      var ok = null;
      for (var attempt = 0; attempt < 2 && !ok; attempt++) {
        var f = await findInDepot(String(e.item).toLowerCase());
        if (!f) break;
        await send(new ItemMovePacket({ which: f.cont, index: f.slot }, { which: eq, index: slot }, 1));
        ok = await until(function () { return eq.getSlotItem(slot); }, 6000);
        if (f.close) await closeContainer(f.close);
      }
      if (ok) done.push(e.item); else missing.push(e.item);
    }

    // 2. Spullen in de backpack die je draagt.
    var want = plan.backpack || [];
    if (want.length) {
      var bag = await wornBackpack();
      if (!bag) {
        want.forEach(function (w) { missing.push(w.item); });
      } else {
        for (var j = 0; j < want.length; j++) {
          var w = want[j];
          var wname = String(w.item).toLowerCase();
          var have = 0;
          for (var s = 0; s < bag.size; s++) { var it = bag.getSlotItem(s); if (it && name(it) === wname) have += (it.count || 1); }
          var need = Math.max(0, (w.count || 1) - have);
          for (var n = 0; n < need; n++) {
            var f2 = await findInDepot(wname);
            if (!f2) { missing.push(w.item); break; }
            var free = -1;
            for (var k = 0; k < bag.size; k++) { if (!bag.getSlotItem(k)) { free = k; break; } }
            if (free < 0) { missing.push(w.item + ' (backpack vol)'); break; }
            // Het spel legt een nieuw item vooraan en schuift de rest op. Daarom
            // tellen we hoeveel er van dit item in de backpack zit.
            var countIn = function () { var t = 0; for (var q = 0; q < bag.size; q++) { var y = bag.getSlotItem(q); if (y && name(y) === wname) t += (y.count || 1); } return t; };
            var beforeCount = countIn();
            await send(new ItemMovePacket({ which: f2.cont, index: f2.slot }, { which: bag, index: free }, 1));
            var put = await until(function () { return countIn() > beforeCount; }, 6000);
            if (f2.close) await closeContainer(f2.close);
            if (put) done.push(w.item); else { missing.push(w.item); break; }
          }
        }
      }
    }

    // 3. Waardevolle items (bijv. crystal coins) veilig in het depot zetten.
    // Pas nu, na het pakken: zo schuiven de depot-vakken niet op tijdens het zoeken.
    var stored = await depositValuables();
    if (stored) done.push(stored + 'x naar depot');

    log('Refill klaar. Gepakt: ' + (done.join(', ') || 'niets') + (missing.length ? '. Niet gelukt: ' + missing.join(', ') : '') + '.');
    return { ok: missing.length === 0, done: done, missing: missing };
  }

  B.depot = {
    openLocker: openLocker,
    refill: refill,
    freeLockerSpots: freeLockerSpots,
    isFromDepot: function (cid) { return fromDepot.has(cid); },
    isBusy: function () { return busy; }
  };
})(window.WJBot = window.WJBot || {});
