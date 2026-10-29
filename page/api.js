(function (B) {
  'use strict';

  // Veilige toegang tot het spel. Nooit gooien, bij twijfel null of false.
  function gc() {
    try {
      return (typeof gameClient !== 'undefined' && gameClient) ? gameClient : null;
    } catch (e) {
      return null;
    }
  }

  function me() {
    var g = gc();
    return (g && g.player) ? g.player : null;
  }

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }

  function pct(cur, max) {
    if (!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
  }

  // Maakt een spel-Position. Klasse komt van de positie van de speler.
  function makePos(x, y, z) {
    var p = me();
    if (!p || !p.__position) return null;
    var Pos = p.__position.constructor;
    return new Pos(x, y, z);
  }

  function getTile(x, y, z) {
    var g = gc();
    if (!g || !g.world || typeof g.world.getTileFromWorldPosition !== 'function') return null;
    var pos = makePos(x, y, z);
    if (!pos) return null;
    return g.world.getTileFromWorldPosition(pos) || null;
  }

  // Alle wezens als lijst, zonder jezelf.
  function rawCreatures() {
    var g = gc();
    var p = me();
    if (!g || !g.world || !g.world.activeCreatures) return [];
    var list = Object.values(g.world.activeCreatures);
    if (!p) return list;
    return list.filter(function (c) { return c && c.id !== p.id; });
  }

  function findCreature(id) {
    var list = rawCreatures();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function send(packet) {
    var g = gc();
    if (!g || typeof g.send !== 'function' || !packet) return false;
    g.send(packet);
    return true;
  }

  // Hoort deze container bij het depot? Het depot zelf is container 1.
  // Containers die je in het depot opent (Depot Chest, Inbox) hebben het depot
  // als ouder, of een titel met depot, inbox of locker.
  function isDepotContainer(cont) {
    if (!cont) return false;
    if (cont.__containerId === 1) return true;
    if (B.depot && B.depot.isFromDepot && B.depot.isFromDepot(cont.__containerId)) return true;
    var seen = 0;
    var parent = cont.__parentCid;
    var p = me();
    while (parent != null && seen < 10) {
      if (parent === 1) return true;
      var pc = p && typeof p.getContainer === 'function' ? p.getContainer(parent) : null;
      parent = pc ? pc.__parentCid : null;
      seen++;
    }
    return /depot|inbox|locker/i.test(String(cont.__title || ''));
  }

  // Loopt door alle open containers en slots. fn(container, slot, item).
  // Depot-containers slaan we standaard over: die zijn niet van je backpack.
  function eachItem(fn, withDepot) {
    var p = me();
    if (!p || !p.__openedContainers) return;
    var conts = Array.from(p.__openedContainers);
    for (var c = 0; c < conts.length; c++) {
      var cont = conts[c];
      if (!cont || typeof cont.getSlotItem !== 'function') continue;
      if (!withDepot && isDepotContainer(cont)) continue;
      var size = num(cont.size, 0);
      for (var s = 0; s < size; s++) {
        var item = cont.getSlotItem(s);
        if (item && fn(cont, s, item) === true) return;
      }
    }
  }

  // Kom je op deze tegel op een andere verdieping uit? (gat, trap, ladder,
  // trapdoor, teleport). Kijkt naar de grond en alle items op de tegel.
  var DANGER_NAME = /\b(hole|pitfall|trapdoor|trap door|stairs?|ladder|ramp|sewer grate|teleport|magic forcefield)\b/i;
  function isDangerItem(g, id) {
    var d = g.itemDefinitions[g.sidByCid[id]] || {};
    var pr = d.properties || {};
    for (var k in pr) {
      if (/floor.?change|teleport/i.test(k) && pr[k]) return true;
    }
    return DANGER_NAME.test(String(pr.name || ''));
  }
  function dangerTile(x, y, z) {
    try {
      var g = gc(); var p = me();
      if (!g || !p || !p.__position) return true;
      var Pos = p.__position.constructor;
      var t = g.world.getTileFromWorldPosition(new Pos(x, y, z));
      if (!t) return true;               // onbekende tegel: liever niet
      if (isDangerItem(g, t.id)) return true;
      var list = t.items || t.__items || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id && isDangerItem(g, list[i].id)) return true;
      }
      return false;
    } catch (e) {
      return true;
    }
  }

  // Vrije schietlijn: blokkeert er iets tussen a en b (muur, rots)? In de
  // itemdefinities is bit 2 van flags "blokkeert projectielen". We trekken een
  // lijn van a naar b en van b naar a; is één van beide vrij, dan kun je schieten.
  var BLOCK_PROJECTILE = 2;
  var BLOCK_SOLID = 1;
  // Ligt er een vast blokkerend item op (bijv. 'sandstone wall' op een vloertegel)?
  // tile.isWalkable() van het spel kijkt daar niet altijd naar.
  function solidItem(g, t) {
    var list = (t && (t.items || t.__items)) || [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i] && list[i].id ? g.itemDefinitions[g.sidByCid[list[i].id]] : null;
      if (d && (Number(d.flags) & BLOCK_SOLID)) return true;
    }
    return false;
  }
  function blocksShot(g, t) {
    if (!t) return true;
    var ids = [t.id];
    var list = t.items || t.__items || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) ids.push(list[i].id);
    for (var j = 0; j < ids.length; j++) {
      var d = g.itemDefinitions[g.sidByCid[ids[j]]];
      if (d && (Number(d.flags) & BLOCK_PROJECTILE)) return true;
    }
    return false;
  }
  function lineClear(g, Pos, ax, ay, bx, by, z) {
    var dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
    var sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
    var err = dx - dy, x = ax, y = ay;
    while (true) {
      if (x === bx && y === by) return true;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === bx && y === by) return true;
      if (blocksShot(g, g.world.getTileFromWorldPosition(new Pos(x, y, z)))) return false;
    }
  }
  function lineOfSight(a, b) {
    try {
      if (!a || !b || a.z !== b.z) return false;
      if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1) return true;
      var g = gc(); var p = me();
      var Pos = p.__position.constructor;
      return lineClear(g, Pos, a.x, a.y, b.x, b.y, a.z) || lineClear(g, Pos, b.x, b.y, a.x, a.y, a.z);
    } catch (e) {
      return true;   // bij twijfel niet blokkeren: de onbereikbaar-controle vangt het op
    }
  }


  // Eén stap richting (x,y) met een eigen zoektocht binnen beeld, waarbij velden
  // (fire/energy/poison field) wel mogen. Alleen als de HP hoog genoeg is.
  var FIELD_MIN_HP = 60;
  var NB8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]];
  var fieldCommit = null;
  var walkWatch = null;   // { x, y, z, px, py, pz, since }: staat de speler stil richting dit doel?   // { x, y, z, until }: even alleen eigen stappen naar dit doel
  function fieldStep(x, y, z) {
    try {
      var g = gc(); var p = me();
      if (!g || !p || !p.__position || p.__position.z !== z) return false;
      var hp = typeof p.getHealthPercentage === 'function' ? p.getHealthPercentage() : 100;
      if (hp < FIELD_MIN_HP) return false;
      var sx = p.__position.x, sy = p.__position.y, R = 8;
      var tx = Math.max(sx - R, Math.min(sx + R, x)), ty = Math.max(sy - R, Math.min(sy + R, y));
      function free(ax, ay) {
        if (ax === sx && ay === sy) return true;
        if (Math.abs(ax - sx) > R || Math.abs(ay - sy) > R) return false;
        try {
          var t = g.world.getTileFromWorldPosition(new p.__position.constructor(ax, ay, z));
          return !!(t && t.isWalkable() && !t.isOccupied() && !solidItem(g, t) && !dangerTile(ax, ay, z));
        } catch (e) { return false; }
      }
      var key = function (a, b) { return a + ',' + b; };
      var prev = {}; prev[key(sx, sy)] = null;
      var q = [[sx, sy]], best = [sx, sy], bestD = Math.max(Math.abs(sx - tx), Math.abs(sy - ty));
      while (q.length) {
        var c = q.shift();
        var d = Math.max(Math.abs(c[0] - tx), Math.abs(c[1] - ty));
        if (d < bestD) { bestD = d; best = c; if (d === 0) break; }
        for (var di = 0; di < 8; di++) {
          var dx = NB8[di][0], dy = NB8[di][1];   // rechte stappen eerst
          var nx = c[0] + dx, ny = c[1] + dy, k = key(nx, ny);
          if (k in prev || !free(nx, ny)) continue;
          if (dx && dy && !free(c[0] + dx, c[1]) && !free(c[0], c[1] + dy)) continue;
          prev[k] = c; q.push([nx, ny]);
        }
      }
      if (best[0] === sx && best[1] === sy) return false;
      var cur = best;
      while (prev[key(cur[0], cur[1])] && !(prev[key(cur[0], cur[1])][0] === sx && prev[key(cur[0], cur[1])][1] === sy)) cur = prev[key(cur[0], cur[1])];
      return B.api.step(cur[0] - sx, cur[1] - sy);
    } catch (e) {
      return false;
    }
  }

  // 'There is no way.' van het spel opvangen, zodat de bot kan melden waar het misging.
  var noWay = null;
  var lastNoWayAt = 0;   // tijd van de laatste 'There is no way' (voor walkTo)
  function hookNoWay() {
    try {
      var ui = gc() && gc().interface;
      if (!ui || ui.__wjNoWay || typeof ui.setCancelMessage !== 'function') return;
      var orig = ui.setCancelMessage;
      ui.setCancelMessage = function (msg) {
        try {
          if (/no way/i.test(String(msg))) {
            lastNoWayAt = Date.now();
            var p = me();
            noWay = { at: Date.now(), x: p && p.__position.x, y: p && p.__position.y, z: p && p.__position.z,
              dest: gc().world.pathfinder.__finalDestination ? { x: gc().world.pathfinder.__finalDestination.x, y: gc().world.pathfinder.__finalDestination.y } : null };
          }
        } catch (e) { /* niets */ }
        return orig.apply(this, arguments);
      };
      ui.__wjNoWay = true;
    } catch (e) { /* later opnieuw */ }
  }

  B.api = {
    ready: function () {
      try {
        var g = gc();
        if (!g || !g.player || !g.networkManager) return false;
        return g.networkManager.isConnected() === true;
      } catch (e) {
        return false;
      }
    },

    player: function () {
      try {
        var g = gc();
        var p = me();
        if (!p || !p.__position) return null;
        var st = (p.state && p.state.__state) ? p.state.__state : {};
        var ms = p.state || {};
        var hp = num(st.health, 0);
        var maxHp = num(ms.maxHealth, 0);
        var mana = num(st.mana, 0);
        var maxMana = num(ms.maxMana, 0);
        var walking = false;
        if (g && g.world && g.world.pathfinder) walking = g.world.pathfinder.__isAutoWalking === true;
        var inPz = false;
        // Net na een trap kan de tegel nog ontbreken: dan gewoon false.
        try { if (typeof p.isInProtectionZone === 'function') inPz = p.isInProtectionZone() === true; } catch (e) { inPz = false; }
        return {
          id: p.id,
          name: p.name,
          x: p.__position.x,
          y: p.__position.y,
          z: p.__position.z,
          hp: hp,
          maxHp: maxHp,
          hpPct: pct(hp, maxHp),
          mana: mana,
          maxMana: maxMana,
          manaPct: pct(mana, maxMana),
          cap: num(st.capacity, 0),
          maxCap: num(ms.maxCapacity, 0),
          level: num(p.level, 0),
          isDead: p.isDead === true,
          inPz: inPz,
          targetId: p.__target ? p.__target.id : null,
          isWalking: walking,
          // Verlamd (paralyze)? Conditie 16 in de ConditionManager van het spel.
          paralyzed: !!(p.conditions && typeof p.conditions.has === 'function' && p.conditions.has(16)),
          // Loopsnelheid, om te zien of haste (utani hur) nog aan staat.
          speed: num(typeof p.getSpeed === 'function' ? p.getSpeed() : p.speed, 0)
        };
      } catch (e) {
        return null;
      }
    },

    creatures: function () {
      try {
        var self = me();
        return rawCreatures().map(function (c) {
          var pos = (typeof c.getPosition === 'function') ? c.getPosition() : null;
          // Zelfde controle als het spel: alleen wat in beeld staat is aan te vallen.
          var canSee = true;
          try { if (self && typeof self.canSeeSmall === 'function') canSee = self.canSeeSmall(c) === true; } catch (e) { canSee = true; }
          var hpPct = (typeof c.getHealthPercentage === 'function') ? c.getHealthPercentage() : 0;
          // Het spel rondt af: 1 HP van 330 wordt 0%. Leeft hij nog (echte HP > 0),
          // dan minstens 1%, anders denkt de bot dat hij dood is en stopt hij.
          var rawHp = c.state && c.state.__state ? Number(c.state.__state.health) : NaN;
          if (rawHp > 0 && !(hpPct >= 1)) hpPct = 1;
          return {
            id: c.id,
            name: c.name,
            type: c.type,
            x: pos ? pos.x : null,
            y: pos ? pos.y : null,
            z: pos ? pos.z : null,
            hpPct: num(hpPct, 0),
            hp: rawHp > 0 ? rawHp : (rawHp === 0 ? 0 : null),   // echte HP (null = onbekend)
            masterId: c.masterId || 0,
            canSee: canSee,
            // Vrije schietlijn vanaf de speler (geen muur ertussen).
            los: canSee && self && self.__position && pos ? lineOfSight(self.__position, pos) : false,
            // Valt dit wezen ons aan? (het spel bewaart het doel van elk wezen)
            targetsMe: !!(self && c.__target && c.__target.id === self.id),
            ref: c
          };
        }).filter(function (c) { return c.x !== null; });
      } catch (e) {
        return [];
      }
    },

    distance: function (a, b) {
      if (!a || !b || a.z !== b.z) return Infinity;
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    },

    attack: function (id) {
      try {
        var g = gc();
        var c = findCreature(id);
        if (!g || !g.world || !c || typeof g.world.targetMonster !== 'function') return false;
        // Eerst ons eigen lopen naar een waypoint stoppen, dan pas aanvallen.
        // Andersom stopt de StopWalk ook het achtervolgen van het monster.
        var pf = g.world.pathfinder;
        if (pf && (pf.__isAutoWalking || pf.__finalDestination) && typeof pf.setPathfindCache === 'function') {
          pf.setPathfindCache(null);
        }
        // targetMonster verwacht een lijst (Set) en pakt daar het eerste wezen uit.
        g.world.targetMonster(new Set([c]));
        return true;
      } catch (e) {
        return false;
      }
    },

    clearTarget: function () {
      try {
        var g = gc();
        if (!g || !g.player) return false;
        // Doel loslaten: lokaal leegmaken en de server doel 0 sturen.
        if (typeof g.player.setTarget === 'function') g.player.setTarget(null);
        if (typeof TargetPacket !== 'undefined' && typeof g.send === 'function') g.send(new TargetPacket(0));
        return true;
      } catch (e) {
        return false;
      }
    },

    walkTo: function (x, y, z) {
      try {
        var g = gc();
        var p = me();
        if (!g || !p || !p.__position || !g.world || !g.world.pathfinder) return false;
        // Niet lopen zolang er een levend doel is: findPath zet dan het
        // achtervolgen uit. Een doel dat dood of weg is, ruimen we eerst op.
        if (p.__target) {
          var t = p.__target;
          var alive = false;
          try {
            var ac = g.world.activeCreatures || {};
            var still = ac[t.id] || Object.values(ac).find(function (c) { return c && c.id === t.id; });
            alive = !!still && ((still.state && still.state.__state && Number(still.state.__state.health) > 0) || (typeof still.getHealthPercentage === 'function' && still.getHealthPercentage() > 0));
          } catch (e) { alive = false; }
          if (alive) return false;
          if (typeof p.setTarget === 'function') p.setTarget(null);
        }
        var Pos = p.__position.constructor;
        var pf = g.world.pathfinder;
        // Eerder vastgelopen bij velden of heen en weer gelopen? Dan een paar
        // seconden alleen de eigen stappen gebruiken, zodat het spel hem niet
        // steeds terugtrekt. Zo kiest hij één richting en houdt die vast.
        if (fieldCommit && Date.now() < fieldCommit.until && fieldCommit.z === z &&
            Math.max(Math.abs(fieldCommit.x - x), Math.abs(fieldCommit.y - y)) <= 1) {
          if (fieldStep(x, y, z)) return true;
          fieldCommit = null;
        }
        hookNoWay();
        var before = lastNoWayAt;
        // Komt de speler al een paar seconden niet van zijn plek terwijl hij naar dit
        // doel wil? Dan blokkeren waarschijnlijk velden de weg, ook zonder 'There is no way'.
        var nowMs = Date.now(), pp = p.__position;
        if (!walkWatch || walkWatch.z !== z || Math.max(Math.abs(walkWatch.x - x), Math.abs(walkWatch.y - y)) > 1 ||
            walkWatch.px !== pp.x || walkWatch.py !== pp.y || walkWatch.pz !== pp.z) {
          walkWatch = { x: x, y: y, z: z, px: pp.x, py: pp.y, pz: pp.z, since: nowMs };
        }
        var standing = nowMs - walkWatch.since > 2500;
        pf.findPath(p.__position, new Pos(x, y, z));
        // Het spel zei net 'There is no way' (bijv. fire fields in de gang), of we staan stil:
        // zelf door de velden stappen.
        if (lastNoWayAt > before || nowMs - lastNoWayAt < 1500 || standing) {
          if (fieldStep(x, y, z)) { fieldCommit = { x: x, y: y, z: z, until: Date.now() + 8000 }; return true; }
        }
        // findPath geeft niets terug. Kijk daarom of er nu een bestemming is.
        if (pf.__isAutoWalking === true || !!pf.__finalDestination) return true;
        // Geen pad: het spel loopt niet door velden (bijv. energy fields van een
        // Minotaur Mage) en zegt dan 'There is no way'. Zelf een stap zetten.
        if (fieldStep(x, y, z)) { fieldCommit = { x: x, y: y, z: z, until: Date.now() + 8000 }; return true; }
        return false;
      } catch (e) {
        return false;
      }
    },

    // Vanuit de twijfel-detector: een paar seconden zelf naar dit punt stappen.
    commitWalk: function (x, y, z, ms) { fieldCommit = { x: x, y: y, z: z, until: Date.now() + (ms || 8000) }; },

    cancelWalk: function () {
      try {
        var g = gc();
        if (!g || !g.world || !g.world.pathfinder) return false;
        // setPathfindCache(null) wist de bestemming en stuurt de server een
        // StopWalkPacket. handleCancelWalk is alleen de reactie op de server
        // en laat de speler na 50 ms weer verder lopen.
        g.world.pathfinder.setPathfindCache(null);
        return true;
      } catch (e) {
        return false;
      }
    },

    isWalking: function () {
      try {
        var g = gc();
        return !!(g && g.world && g.world.pathfinder && g.world.pathfinder.__isAutoWalking === true);
      } catch (e) {
        return false;
      }
    },

    pressHotkey: function (n) {
      try {
        n = parseInt(n, 10);
        if (!(n >= 1 && n <= 12)) return false;
        var g = gc();
        var hb = g && g.interface ? g.interface.hotbarManager : null;
        if (!hb || typeof hb.handleKeyPress !== 'function') return false;
        hb.handleKeyPress(111 + n);
        return true;
      } catch (e) {
        return false;
      }
    },

    // Item op een F-toets zetten, zoals slepen naar de hotbar. slot 1 = F1.
    // mode: 'self' (op jezelf), 'target' of 'crosshair'. Het spel bewaart het zelf.
    setHotkeyItem: function (slot, itemId, mode, fluidType) {
      try {
        var g = gc();
        var hb = g && g.interface ? g.interface.hotbarManager : null;
        var idx = parseInt(slot, 10) - 1;
        var id = parseInt(itemId, 10);
        if (!hb || typeof hb.addItemSlot !== 'function' || !(idx >= 0 && idx < 12) || !(id > 0)) return false;
        var sid = (g.sidByCid && g.sidByCid[id]) || 0;
        hb.addItemSlot(idx, id, parseInt(fluidType, 10) || 0, mode || 'self', sid);
        if (typeof hb.__saveConfiguration === 'function') hb.__saveConfiguration();
        var s = hb.slots[idx];
        return !!(s && s.item && s.item.id === id);
      } catch (e) {
        return false;
      }
    },

    // cid is __containerId, want player.getContainer(cid) vergelijkt daarop.
    findItem: function (clientId) {
      try {
        var found = null;
        eachItem(function (cont, slot, item) {
          if (item.id === clientId) {
            found = { cid: cont.__containerId, slot: slot, count: num(item.count, 1) || 1 };
            return true;
          }
          return false;
        });
        return found;
      } catch (e) {
        return null;
      }
    },

    // Losse stapels van hetzelfde item samenvoegen (bijv. arrows tot 100).
    // Zet de kleinste stapel op een andere stapel die nog niet vol is.
    // Eén verplaatsing per keer. Geeft true als er iets is verplaatst.
    stackItem: function (clientId) {
      try {
        var g = gc();
        if (!g || typeof ItemMovePacket === 'undefined') return false;
        var stacks = [];
        eachItem(function (cont, slot, item) {
          // Alleen eigen tassen: nooit in een lijk (dead/slain/remains) of iets op de grond.
          var title = String(cont.__title || '').toLowerCase();
          if (!/^(main backpack|backpack|bag)\b/.test(title) && !/(backpack|bag)$/.test(title)) return false;
          if (/^(dead|slain|remains|split|lifeless)\b/.test(title)) return false;
          if (item.id === clientId) stacks.push({ cont: cont, slot: slot, count: num(item.count, 1) || 1 });
          return false;
        });
        var open = stacks.filter(function (s) { return s.count < 100; });
        if (open.length < 2) return false;
        open.sort(function (a, b) { return a.count - b.count; });
        var from = open[0];
        var to = open[open.length - 1];   // de grootste stapel die nog niet vol is
        var n = Math.min(from.count, 100 - to.count);
        if (n < 1) return false;
        g.send(new ItemMovePacket({ which: from.cont, index: from.slot }, { which: to.cont, index: to.slot }, n));
        return true;
      } catch (e) {
        return false;
      }
    },

    // Naam van de grond op een tegel (bijv. 'stone pile', 'hole'), of '' als onbekend.
    groundName: function (x, y, z) {
      try {
        var g = gc(); var p = me();
        if (!g || !p) return '';
        var Pos = p.__position.constructor;
        var t = g.world.getTileFromWorldPosition(new Pos(x, y, z));
        if (!t) return '';
        var d = g.itemDefinitions[g.sidByCid[t.id]] || {};
        return String((d.properties && d.properties.name) || '').toLowerCase();
      } catch (e) {
        return '';
      }
    },

    // Alle open containers (backpacks, lijken), zonder depot.
    openContainers: function () {
      try {
        var p = me();
        if (!p || !p.__openedContainers) return [];
        return Array.from(p.__openedContainers).filter(function (c) {
          return c && typeof c.getSlotItem === 'function' && !isDepotContainer(c);
        });
      } catch (e) {
        return [];
      }
    },

    // Rondkijken: alle bekende tegels rond (cx, cy) op verdieping z.
    // Per tegel: begaanbaar (w), grondnaam (g) en bijzondere items (i), zoals
    // een trap, gat, ladder of stone pile. Voor het maken van routes.
    scanArea: function (cx, cy, z, r) {
      try {
        var g = gc(); var p = me();
        if (!g || !p) return null;
        var Pos = p.__position.constructor;
        r = Math.max(1, Math.min(12, parseInt(r, 10) || 8));
        var out = [];
        for (var dy = -r; dy <= r; dy++) {
          for (var dx = -r; dx <= r; dx++) {
            var x = cx + dx, y = cy + dy;
            var t = g.world.getTileFromWorldPosition(new Pos(x, y, z));
            if (!t || !t.id) continue;
            var nm = function (id) {
              var d = g.itemDefinitions[g.sidByCid[id]] || {};
              var pr = d.properties || {};
              var extra = Object.keys(pr).filter(function (k) { return /floor|change|teleport/i.test(k); });
              return String(pr.name || ('#' + id)) + (extra.length ? ' [' + extra.map(function (k) { return k + '=' + pr[k]; }).join(',') + ']' : '');
            };
            var items = [];
            var list = t.items || t.__items || [];
            for (var k = 0; k < list.length; k++) { if (list[k] && list[k].id) items.push(nm(list[k].id)); }
            var walk = false;
            try { walk = !!t.isWalkable() && !solidItem(g, t); } catch (e) { walk = false; }
            out.push({ x: x, y: y, w: walk ? 1 : 0, g: nm(t.id), i: items });
          }
        }
        return { player: { x: p.__position.x, y: p.__position.y, z: p.__position.z }, tiles: out };
      } catch (e) {
        return { error: String(e && e.message) };
      }
    },

    // Eén stap zetten, net als met de pijltjestoetsen. Het doel blijft staan.
    // dx en dy zijn -1, 0 of 1. Geeft false als je al loopt of als het niet kan.
    step: function (dx, dy) {
      try {
        var g = gc(); var p = me();
        if (!g || !p || !p.__position || !g.keyboard) return false;
        if (typeof p.isMoving === 'function' && p.isMoving()) return false;
        var D = (typeof CONST !== 'undefined' && CONST.DIRECTION) || {};
        var key = (dy < 0 ? 'NORTH' : dy > 0 ? 'SOUTH' : '') + (dx < 0 ? 'WEST' : dx > 0 ? 'EAST' : '');
        var dir = D[key];
        if (dir === undefined) return false;
        // Nooit op een gat, trap of teleport stappen: dan val je een verdieping lager.
        if (dangerTile(p.__position.x + dx, p.__position.y + dy, p.__position.z)) return false;
        var Pos = p.__position.constructor;
        var to = new Pos(p.__position.x + dx, p.__position.y + dy, p.__position.z);
        g.keyboard.__handleCharacterMovementWrapper(dir, to);
        return true;
      } catch (e) {
        return false;
      }
    },

    // Bewust één stap op een trap zetten (trap-hoppen). Zelfde als step, maar
    // zonder de dangerTile-check. Alleen gebruiken als je echt van verdieping wilt.
    stairStep: function (dx, dy) {
      try {
        var g = gc(); var p = me();
        if (!g || !p || !p.__position || !g.keyboard) return false;
        if (typeof p.isMoving === 'function' && p.isMoving()) return false;
        var D = (typeof CONST !== 'undefined' && CONST.DIRECTION) || {};
        var key = (dy < 0 ? 'NORTH' : dy > 0 ? 'SOUTH' : '') + (dx < 0 ? 'WEST' : dx > 0 ? 'EAST' : '');
        var dir = D[key];
        if (dir === undefined) return false;
        var Pos = p.__position.constructor;
        var to = new Pos(p.__position.x + dx, p.__position.y + dy, p.__position.z);
        g.keyboard.__handleCharacterMovementWrapper(dir, to);
        return true;
      } catch (e) {
        return false;
      }
    },

    // Chase-stand van het spel: 0 = blijven staan, 1 = volgen, 2 = agressief volgen.
    chaseMode: function () {
      try {
        var f = gc().interface.fightModeSelector;
        return f ? f.currentChaseMode : null;
      } catch (e) {
        return null;
      }
    },

    setChaseMode: function (mode) {
      try {
        var f = gc().interface.fightModeSelector;
        if (!f || typeof f.setChaseMode !== 'function') return false;
        f.setChaseMode(mode);
        return true;
      } catch (e) {
        return false;
      }
    },

    // Hoe ver is het lopen van de speler naar een vrije tegel naast b? Gebruikt de
    // padzoeker van het spel (alleen rekenen, niet lopen). Infinity = geen pad.
    walkDistance: function (b) {
      try {
        var g = gc(); var p = me();
        var pf = g.world.pathfinder;
        if (!pf || typeof pf.search !== 'function' || !p || !p.__position) return Infinity;
        var Pos = p.__position.constructor;
        var from = g.world.getTileFromWorldPosition(p.__position);
        if (!from) return Infinity;
        var best = Infinity, tries = 0;
        var nb = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]];
        // Liefst de buurtegels aan onze kant eerst.
        nb.sort(function (u, v) {
          var du = Math.max(Math.abs(b.x + u[0] - p.__position.x), Math.abs(b.y + u[1] - p.__position.y));
          var dv = Math.max(Math.abs(b.x + v[0] - p.__position.x), Math.abs(b.y + v[1] - p.__position.y));
          return du - dv;
        });
        for (var i = 0; i < nb.length && tries < 3; i++) {
          var t = g.world.getTileFromWorldPosition(new Pos(b.x + nb[i][0], b.y + nb[i][1], b.z));
          if (!t || !t.isWalkable() || t.isOccupied()) continue;
          tries++;
          var path = pf.search(from, t);
          if (path && path.length && path.length < best) best = path.length;
        }
        return best;
      } catch (e) {
        return Infinity;
      }
    },

    // Laatste 'There is no way.' (en haakt de opvang in als dat nog niet gebeurd is).
    takeNoWay: function () { hookNoWay(); var n = noWay; noWay = null; return n; },

    // De eigen hoofdtas (geopend), om spullen in terug te leggen. Nooit een lijk of depot.
    mainBackpack: function () {
      try {
        var p = me();
        var conts = Array.from((p && p.__openedContainers) || []);
        var pick = null;
        for (var i = 0; i < conts.length; i++) {
          var c = conts[i];
          var t = String(c && c.__title || '').toLowerCase();
          if (!c || isDepotContainer(c)) continue;
          if (t === 'main backpack') return c;
          if (!pick && /^(backpack|bag)$/.test(t)) pick = c;
        }
        return pick;
      } catch (e) {
        return null;
      }
    },

    // Items op de grond rond een plek: [{x,y,z,index,id,count}] (alleen gezochte ids).
    groundItems: function (cx, cy, z, r, ids) {
      try {
        var g = gc(); var p = me();
        var Pos = p.__position.constructor;
        var out = [];
        for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
          var t = g.world.getTileFromWorldPosition(new Pos(cx + dx, cy + dy, z));
          var list = t ? (t.items || t.__items || []) : [];
          for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (it && ids.indexOf(it.id) >= 0) out.push({ x: cx + dx, y: cy + dy, z: z, index: i, id: it.id, count: num(it.count, 1) || 1 });
          }
        }
        return out;
      } catch (e) {
        return [];
      }
    },

    // Kun je van a naar b schieten (geen muur ertussen)?
    lineOfSight: function (a, b) { return lineOfSight(a, b); },
    // Strenger: de lijn moet in beide richtingen vrij zijn (geen muurhoek ertussen).
    clearShot: function (a, b) {
      try {
        if (!a || !b || a.z !== b.z) return false;
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1) return true;
        var g = gc(); var Pos = me().__position.constructor;
        return lineClear(g, Pos, a.x, a.y, b.x, b.y, a.z) && lineClear(g, Pos, b.x, b.y, a.x, a.y, a.z);
      } catch (e) { return true; }
    },

    // Gat, trap, ladder, trapdoor of teleport op deze tegel?
    dangerTile: function (x, y, z) { return dangerTile(x, y, z); },

    // Kun je op deze tegel staan (geen muur, niemand erop)?
    tileFree: function (x, y, z) {
      try {
        var g = gc(); var p = me();
        var Pos = p.__position.constructor;
        var t = g.world.getTileFromWorldPosition(new Pos(x, y, z));
        return !!(t && t.isWalkable() && !t.isOccupied() && !solidItem(g, t));
      } catch (e) {
        return false;
      }
    },

    // Is het depot open? Geeft de container waar spullen heen kunnen of null.
    // Liever een open Depot Chest dan het depot zelf.
    depotTarget: function () {
      try {
        var p = me();
        if (!p || !p.__openedContainers) return null;
        var conts = Array.from(p.__openedContainers).filter(isDepotContainer);
        if (!conts.length) return null;
        var chest = conts.find(function (c) { return /depot chest/i.test(String(c.__title || '')); });
        return chest || conts.find(function (c) { return c.__containerId === 1; }) || conts[0];
      } catch (e) {
        return null;
      }
    },

    // Item verplaatsen naar een container (bijv. het depot). from = { cid, slot }
    // voor een container, of { equip: slot } voor een uitrustingsvak.
    moveToContainer: function (from, target, count) {
      try {
        var g = gc();
        var p = me();
        if (!g || !p || !target || typeof ItemMovePacket === 'undefined') return false;
        var src;
        if (from.tile) {
          // Van de grond: { tile: {x,y,z}, index } (index = plek in tile.items).
          var Pos0 = p.__position.constructor;
          var gt = g.world.getTileFromWorldPosition(new Pos0(from.tile.x, from.tile.y, from.tile.z));
          if (!gt) return false;
          src = { which: gt, index: from.index };
        } else {
          src = from.equip != null ? { which: p.equipment, index: from.equip } : { which: p.getContainer(from.cid), index: from.slot };
        }
        if (!src.which) return false;
        var srcItem = from.tile ? ((src.which.items || src.which.__items || [])[src.index] || null)
          : (typeof src.which.getSlotItem === 'function' ? src.which.getSlotItem(src.index) : null);
        // Doelplek: bij een stapel van hetzelfde item (minder dan 100), anders de
        // eerste lege plek. Nooit op een ander item, want dan gaat het erin (bijv.
        // het zwarte depot-vak) of weigert het spel.
        var size = num(target.size, 0);
        var spot = -1;
        for (var i = 0; i < size; i++) {
          var it = target.getSlotItem(i);
          if (it && srcItem && it.id === srcItem.id && num(it.count, 1) < 100) { spot = i; break; }
        }
        if (spot < 0) {
          for (var j = 0; j < size; j++) { if (!target.getSlotItem(j)) { spot = j; break; } }
        }
        if (spot < 0) return false; // depot vol
        g.send(new ItemMovePacket(src, { which: target, index: spot }, Math.max(1, Math.min(100, count | 0))));
        return true;
      } catch (e) {
        return false;
      }
    },

    // Item in een uitrustingsvak (0 helm ... 9 pijlenvak). Geeft { id, count } of null.
    equipSlotItem: function (slot) {
      try {
        var p = me();
        var eq = p && p.equipment;
        var it = eq && typeof eq.getSlotItem === 'function' ? eq.getSlotItem(slot) : null;
        return it && it.id ? { id: it.id, count: num(it.count, 1) || 1 } : null;
      } catch (e) {
        return null;
      }
    },

    // Item verplaatsen van container (cid, slot) naar een uitrustingsvak.
    moveToEquip: function (fromCid, fromSlot, toSlot, count) {
      try {
        var g = gc();
        var p = me();
        if (!g || !p || typeof ItemMovePacket === 'undefined') return false;
        var from = p.getContainer(fromCid);
        if (!from) return false;
        g.send(new ItemMovePacket({ which: from, index: fromSlot }, { which: p.equipment, index: toSlot }, Math.max(1, Math.min(100, count | 0))));
        return true;
      } catch (e) {
        return false;
      }
    },

    // Huidige XP van je character. Het spel bewaart die in het skill-venster.
    experience: function () {
      try {
        var g = gc();
        var w = g && g.interface && g.interface.windowManager && g.interface.windowManager.getWindow('skill-window');
        if (w && typeof w.__xphLastExp === 'number') return w.__xphLastExp;
        var row = document.querySelector('div[skill=experience]');
        if (row) {
          var digits = String(row.textContent || '').replace(/[^0-9]/g, '');
          if (digits) return Number(digits);
        }
        return null;
      } catch (e) {
        return null;
      }
    },

    // Geld dat je bij je hebt: in je eigen backpacks en uitrustingsvakken
    // (niet in het depot). GP: gold 1, platinum 100, crystal 10.000.
    wallet: function () {
      var IDS = { 3031: 'gold', 3035: 'platinum', 3043: 'crystal' };
      var out = { gold: 0, platinum: 0, crystal: 0, value: 0 };
      try {
        eachItem(function (cont, slot, item) {
          var k = IDS[item.id];
          if (k) out[k] += (num(item.count, 1) || 1);
          return false;
        });
        var p = me();
        var eq = p && p.equipment;
        for (var s = 0; eq && s <= 9; s++) {
          var it = eq.getSlotItem(s);
          var k2 = it && IDS[it.id];
          if (k2) out[k2] += (num(it.count, 1) || 1);
        }
      } catch (e) { /* half is ook goed */ }
      out.value = out.gold + out.platinum * 100 + out.crystal * 10000;
      return out;
    },

    countItem: function (clientId) {
      try {
        var total = 0;
        eachItem(function (cont, slot, item) {
          if (item.id === clientId) total += (num(item.count, 1) || 1);
          return false;
        });
        return total;
      } catch (e) {
        return 0;
      }
    },

    // Aantal vloeistoffen (bijv. mana fluid: id 2874, soort 7) in open containers.
    countFluid: function (clientId, fluidType) {
      try {
        var total = 0;
        eachItem(function (cont, slot, item) {
          if (item.id !== clientId) return false;
          var ft = item.fluidType != null ? item.fluidType : item.__fluidType;
          if (ft != null && fluidType != null && Number(ft) !== Number(fluidType)) return false;
          total += (num(item.count, 1) || 1);
          return false;
        });
        return total;
      } catch (e) {
        return 0;
      }
    },

    itemName: function (clientId) {
      try {
        var g = gc();
        if (!g) return null;
        var def = null;
        if (g.itemDefinitionsByCid) def = g.itemDefinitionsByCid[clientId] || null;
        if (!def && g.sidByCid && g.itemDefinitions) {
          var sid = g.sidByCid[clientId];
          if (sid !== undefined) def = g.itemDefinitions[sid] || null;
        }
        if (!def && g.itemDefinitions) {
          // Laatste poging: sid van een item met dit id in een open container.
          eachItem(function (cont, slot, item) {
            if (item.id === clientId && item.sid !== undefined) {
              def = g.itemDefinitions[item.sid] || null;
              return true;
            }
            return false;
          });
        }
        return (def && def.properties && def.properties.name) ? def.properties.name : null;
      } catch (e) {
        return null;
      }
    },

    // Gebruikt het bovenste item op een tegel (ladder, gat, deur).
    useTile: function (x, y, z) {
      try {
        if (typeof ItemUsePacket === 'undefined') return false;
        var tile = getTile(x, y, z);
        if (!tile) return false;
        return send(new ItemUsePacket({ which: tile, index: 0xFF }));
      } catch (e) {
        return false;
      }
    },

    // Gebruikt een item uit een open container op een tegel (touw = 3003).
    useItemOnTile: function (clientId, x, y, z) {
      try {
        if (typeof ItemUseWithPacket === 'undefined') return false;
        var p = me();
        var spot = B.api.findItem(clientId);
        if (!p || !spot) return false;
        var cont = p.getContainer(spot.cid);
        var tile = getTile(x, y, z);
        if (!cont || !tile) return false;
        return send(new ItemUseWithPacket(
          { which: cont, index: spot.slot },
          { which: tile, index: 0xFF }
        ));
      } catch (e) {
        return false;
      }
    },

    modalVisible: function (id) {
      try {
        var el = document.getElementById(id);
        if (!el) return false;
        return window.getComputedStyle(el).display !== 'none';
      } catch (e) {
        return false;
      }
    },

    clickModalButton: function (id, action) {
      try {
        var el = document.getElementById(id);
        if (!el) return false;
        var btn = el.querySelector('button[action="' + String(action).replace(/["\\]/g, '') + '"]');
        if (!btn) return false;
        btn.click();
        return true;
      } catch (e) {
        return false;
      }
    }
  };
})(window.WJBot = window.WJBot || {});
