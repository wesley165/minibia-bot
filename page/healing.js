(function (B) {
  'use strict';

  // Healing: drukt een hotkey als HP of mana onder een drempel komt.
  // Elke regel heeft een eigen cooldown. Per tick wordt maar één hotkey gedrukt.

  var lastUsed = {}; // sleutel per regel -> tijdstip laatste druk

  // Volgorde: eerst hp, dan mana, dan aanvalsspell, dan haste, dan manaSpell.
  var RANK = { hp: 0, paralyze: 0, mana: 1, targetRune: 2, attackSpell: 2, haste: 3, manaSpell: 4 };

  // Haste (utani hur): steeds opnieuw zodra hij voorbij is.
  // De bot onthoudt wanneer hij hem gaf. Daalt je loopsnelheid, dan is de haste
  // eerder voorbij (of ben je vertraagd) en geeft hij hem meteen opnieuw.
  var hasteUntil = 0;
  var lastSpeed = 0;
  var hasteCast = null;   // { at, speed } om te zien of de cast werkte
  var hasteMisses = 0;    // casts zonder hogere snelheid achter elkaar
  function hasteFits(rule, p, now, state) {
    // Alleen als de bot speelt, niet tijdens een pauze.
    if (state && state !== 'running') return false;
    if (p.inPz) return false;
    var speed = Number(p.speed) || 0;
    // Paralyze: snelheid ver onder normaal. Dan meteen haste, ook als de
    // haste nog zou lopen en ook onder de mana-drempel (alleen de mana-kosten tellen).
    if (typeof rule.paralyzeSpeed === 'number' && speed > 0 && speed < rule.paralyzeSpeed) {
      lastSpeed = speed;
      hasteUntil = 0;
      return p.mana >= (Number(rule.manaCost) || 0);
    }
    if (lastSpeed && speed && speed < lastSpeed - 5) hasteUntil = 0;
    lastSpeed = speed;
    // 1,5 seconde na de cast: niet sneller geworden? Dan werkte de toets niet
    // (bijv. even te vroeg na een andere spell). Hooguit 2 keer opnieuw,
    // daarna niet blijven proberen (dan was haste waarschijnlijk al aan).
    if (hasteCast && speed && now - hasteCast.at >= 1500) {
      if (speed > hasteCast.speed + 5) hasteMisses = 0;
      else if (++hasteMisses <= 2) hasteUntil = 0;
      hasteCast = null;
    }
    if (now < hasteUntil) return false;
    // Alleen bij genoeg mana (bijv. 95%), zodat er mana overblijft voor exori.
    if (typeof rule.minManaPct === 'number' && !(p.manaPct >= rule.minManaPct)) return false;
    return p.mana >= (Number(rule.manaCost) || 0);
  }

  // Aantal monsters direct naast de speler. Alle monsters tellen mee, ook als
  // ze niet in de targetlijst staan: exori raakt ze allemaal. Geen spelers of summons.
  // Met name: alleen monsters met die naam tellen.
  function adjacentMonsters(ctx, p, name) {
    var n = 0;
    var want = name ? String(name).toLowerCase() : null;
    (ctx.creatures || []).forEach(function (c) {
      if (!c || c.type !== 1 || !(c.hpPct > 0) || c.masterId) return;
      if (c.z !== p.z || Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) !== 1) return;
      if (want && String(c.name).toLowerCase() !== want) return;
      n++;
    });
    return n;
  }

  function safeCount(id) {
    try { return B.api.countItem(Number(id)); } catch (e) { return 1; }
  }

  function ruleKey(rule, i) {
    return i + '|' + rule.type + '|' + rule.hotkey;
  }

  // Totaal van een item in open containers plus de uitrustingsvakken (bijv. pijlenvak).
  function totalItem(id) {
    var n = safeCount(id);
    for (var slot = 0; slot <= 9; slot++) {
      try {
        var q = B.api.equipSlotItem(slot);
        if (q && q.id === id) n += q.count;
      } catch (e) { /* volgende vak */ }
    }
    return n;
  }

  // Extra voorwaarde op een regel: item: { id, above } of item: { id, atMost }.
  // Bijv. meer dan 200 arrows: F2, anders F3.
  // Bijvullen met marge: item.resumeBelow. Bijv. { id: bolt, atMost: 200, resumeBelow: 100 }:
  // maken tot 200, daarna pas weer beginnen als je onder de 100 zit.
  var filling = {};   // sleutel -> true (bezig met bijvullen) / false (wacht tot onder resumeBelow)
  function fillOk(c, n) {
    if (typeof c.resumeBelow !== 'number') return true;
    var key = c.id + ':' + c.atMost + ':' + c.resumeBelow;
    if (!(key in filling)) filling[key] = n < c.resumeBelow;
    if (typeof c.atMost === 'number' && n >= c.atMost) filling[key] = false;
    if (n < c.resumeBelow) filling[key] = true;
    return filling[key];
  }

  function itemOk(rule) {
    // Meerdere voorwaarden: items: [ {id, above|atMost}, ... ] (alle moeten kloppen).
    if (Array.isArray(rule.items)) {
      for (var ii = 0; ii < rule.items.length; ii++) {
        if (!itemOk({ item: rule.items[ii] })) return false;
      }
    }
    var c = rule.item;
    if (!c || !(Number(c.id) > 0)) return true;
    var n = totalItem(Number(c.id));
    if (typeof c.above === 'number' && !(n > c.above)) return false;
    if (typeof c.atMost === 'number' && !(n <= c.atMost)) return false;
    if (!fillOk(c, n)) return false;
    return true;
  }

  function fits(rule, p, ctx) {
    if (!itemOk(rule)) return false;
    if (rule.type === 'haste') return hasteFits(rule, p, ctx.now, ctx.state);
    if (rule.type === 'attackSpell') {
      // Aanvalsspell (bijv. exori): genoeg mana plus reserve, en monsters naast je.
      var cost = Number(rule.manaCost) || 0;
      var reserve = Number(rule.manaReserve) || 0;
      if (!(p.mana >= cost + reserve)) return false;
      var adj = adjacentMonsters(ctx, p);
      if (adj >= (Number(rule.minAdjacent) || 3)) return true;
      // Per monster een eigen aantal, bijv. [{ name: 'Bone Beast', count: 2 }].
      var per = Array.isArray(rule.minAdjacentByName) ? rule.minAdjacentByName : [];
      for (var k = 0; k < per.length; k++) {
        var m = per[k];
        if (m && m.name && Number(m.count) > 0 && adjacentMonsters(ctx, p, m.name) >= Number(m.count)) return true;
      }
      return adj >= 1 && typeof rule.singleAbovePct === 'number' && p.manaPct >= rule.singleAbovePct;
    }
    if (rule.type === 'hp') {
      if (!(typeof rule.belowPct === 'number' && p.hpPct < rule.belowPct)) return false;
      // Rune of potion op de toets (itemId) en er is er geen meer? Dan past de regel niet.
      if (rule.itemId && !(safeCount(rule.itemId) > 0)) return false;
      // Spell met manaCost (bijv. exura vita): alleen als er genoeg mana is. Anders past
      // de volgende HP-regel (bijv. een UH-rune op F5).
      if (Number(rule.manaCost) > 0 && !(p.mana >= Number(rule.manaCost))) return false;
      return true;
    }
    if (rule.type === 'mana') {
      // Onder een vast aantal mana (bijv. 150 voor exori) of onder een percentage.
      if (typeof rule.belowMana === 'number') return p.mana < rule.belowMana;
      return typeof rule.belowPct === 'number' && p.manaPct < rule.belowPct;
    }
    if (rule.type === 'paralyze') {
      // Verlamd: meteen de toets (bijv. F9 met een haste-spell of potion).
      return !!p.paralyzed;
    }
    if (rule.type === 'targetRune') {
      // Rune op je doel (bijv. HMM op een Ghost, die is immuun voor bolts).
      // names: [ 'Ghost' ]. Doel moet in beeld zijn en binnen maxDistance (standaard 7).
      if (!p.targetId) return false;
      var names = (Array.isArray(rule.names) ? rule.names : []).map(function (n) { return String(n).toLowerCase(); });
      var list = ctx.creatures || [];
      for (var ti = 0; ti < list.length; ti++) {
        var tc = list[ti];
        if (!tc || tc.id !== p.targetId) continue;
        // finishBelowPct: elk doel met zo weinig HP krijgt ook de rune (laatste beetje HP).
        var finish = Number(rule.finishBelowPct) > 0 && tc.hpPct > 0 && tc.hpPct <= Number(rule.finishBelowPct);
        // finishBelowHp: hetzelfde, maar in echte HP (bijv. de laatste 40 HP).
        if (Number(rule.finishBelowHp) > 0 && tc.hp != null && tc.hp > 0 && tc.hp <= Number(rule.finishBelowHp)) finish = true;
        if (!finish && names.indexOf(String(tc.name).toLowerCase()) < 0) return false;
        if (tc.canSee === false || tc.los === false) return false;
        var td = Math.max(Math.abs(tc.x - p.x), Math.abs(tc.y - p.y));
        return tc.z === p.z && td <= (Number(rule.maxDistance) || 7);
      }
      return false;
    }
    if (rule.type === 'manaSpell') {
      if (!(typeof rule.abovePct === 'number' && p.manaPct >= rule.abovePct)) return false;
      // quiet: alleen als het rustig is (geen monster binnen quiet tegels, HP hoog),
      // zodat er in een gevecht mana over is om te healen.
      var q = Number(rule.quiet);
      if (q > 0) {
        if (!(p.hpPct >= (Number(rule.minHpPct) || 90))) return false;
        var cs = ctx.creatures || [];
        for (var qi = 0; qi < cs.length; qi++) {
          var qc = cs[qi];
          if (qc && qc.type === 1 && qc.hpPct > 0 && qc.z === p.z && Math.max(Math.abs(qc.x - p.x), Math.abs(qc.y - p.y)) <= q) return false;
        }
      }
      return true;
    }
    return false;
  }

  function tick(ctx) {
    var p = ctx && ctx.player;
    var cfg = (ctx && ctx.config && ctx.config.healing) || {};
    if (!p || p.isDead) return null;
    if (cfg.skipInPz !== false && p.inPz) return null;

    var rules = Array.isArray(cfg.rules) ? cfg.rules : [];

    // Lijst met index, gesorteerd op type. Binnen hetzelfde type blijft de volgorde gelijk.
    var list = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || !(r.type in RANK)) continue;
      list.push({ rule: r, i: i });
    }
    list.sort(function (a, b) {
      return (RANK[a.rule.type] - RANK[b.rule.type]) || (a.i - b.i);
    });

    for (var j = 0; j < list.length; j++) {
      var rule = list[j].rule;
      var n = Number(rule.hotkey);
      if (!(n >= 1 && n <= 12)) continue;
      if (!fits(rule, p, ctx)) continue;

      // Regel past, maar staat nog in cooldown: probeer de volgende regel.
      var key = ruleKey(rule, list[j].i);
      var cd = Number(rule.cooldownMs) || 1000;
      if (lastUsed[key] && ctx.now - lastUsed[key] < cd) {
        // first: deze regel gaat altijd voor. Wacht hij nog? Dan geen andere toets.
        if (rule.first) return null;
        continue;
      }

      var pressed = B.api.pressHotkey(n);
      lastUsed[key] = ctx.now;
      if (rule.type === 'haste' && pressed !== false) {
        hasteUntil = ctx.now + Math.max(5000, Number(rule.durationMs) || 30000);
        hasteCast = { at: ctx.now, speed: Number(p.speed) || 0 };
      }
      return { type: rule.type, hotkey: n };
    }
    return null;
  }

  function reset() {
    lastUsed = {};
    hasteUntil = 0;
    lastSpeed = 0;
    hasteCast = null;
    hasteMisses = 0;
  }

  B.healing = { tick: tick, reset: reset };
})(window.WJBot = window.WJBot || {});
