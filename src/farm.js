'use strict';

// Opbrengst bijhouden: GP, XP en kills, totaal en per uur.
// Werkt op de server, zodat het blijft kloppen na een herlading van de pagina.
// - GP: elke stijging van het geld dat je bij je hebt telt als gefarmd.
//   Dalingen (geld naar het depot, iets kopen) tellen niet mee.
// - XP: elke stijging van je XP.
// - Kills: elk kill-event van de bot.
// - UH's en mana fluids: elke kleine daling van de voorraad telt als gebruikt.
//   Bijvullen en grote sprongen (bag dicht, depot) tellen niet mee.
// Per uur = wat er in het laatste uur binnenkwam (of sinds de start als dat korter is).

const fs = require('fs');
const path = require('path');

const HOUR = 3600000;
const MAX_GOLD_JUMP = 500000; // grotere sprong = geen loot (bijv. geld uit depot)
const MAX_USE_JUMP = 10;      // grotere daling in één keer = niet gebruikt (bag dicht, depot)
const USE = { uh: 'uh', manaFluids: 'mf' };

function createFarm({ root }) {
  const file = path.join(root, 'data', 'farm.json');
  let s = load();
  let prev = { value: null, exp: null, uh: null, manaFluids: null };
  let dirty = false;

  function fresh() {
    return { since: Date.now(), totals: { gold: 0, xp: 0, kills: 0 }, events: [] };
  }

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.totals && Array.isArray(d.events)) return d;
    } catch (e) { /* nieuw */ }
    return fresh();
  }

  function save() {
    if (!dirty) return;
    dirty = false;
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, file);
    } catch (e) { /* volgende keer */ }
  }
  setInterval(save, 15000).unref();

  function add(type, v) {
    const now = Date.now();
    s.totals[type] = (s.totals[type] || 0) + v;
    s.events.push([now, type, v]);
    s.events = s.events.filter((e) => now - e[0] < HOUR);
    dirty = true;
  }

  // Elke status van de bot: geld en XP vergelijken met de vorige keer.
  function onStatus(st) {
    if (!st || !st.ready || !st.player) { prev = { value: null, exp: null, uh: null, manaFluids: null }; return; }
    const sup = st.supplies || {};
    for (const k of Object.keys(USE)) {
      if (typeof sup[k] !== 'number') continue;
      if (prev[k] !== null) {
        const d = prev[k] - sup[k];
        if (d > 0 && d <= MAX_USE_JUMP) add(USE[k], d);
      }
      prev[k] = sup[k];
    }
    const w = st.wallet;
    if (w && typeof w.value === 'number') {
      if (prev.value !== null) {
        const d = w.value - prev.value;
        if (d > 0 && d < MAX_GOLD_JUMP) add('gold', d);
      }
      prev.value = w.value;
    }
    if (typeof st.experience === 'number') {
      if (prev.exp !== null) {
        const d = st.experience - prev.exp;
        if (d > 0 && d < 10000000) add('xp', d);
      }
      prev.exp = st.experience;
    }
  }

  function onKill() { add('kills', 1); }

  function summary() {
    const now = Date.now();
    const span = Math.max(60000, Math.min(HOUR, now - s.since));
    const lastHour = { gold: 0, xp: 0, kills: 0, uh: 0, mf: 0 };
    for (const e of s.events) if (now - e[0] < HOUR) lastHour[e[1]] += e[2];
    const perHour = (v) => Math.round(v * HOUR / span);
    return {
      since: s.since,
      totals: s.totals,
      perHour: { gold: perHour(lastHour.gold), xp: perHour(lastHour.xp), kills: perHour(lastHour.kills), uh: perHour(lastHour.uh), mf: perHour(lastHour.mf) },
      measuredMinutes: Math.round(span / 60000)
    };
  }

  function reset() {
    s = fresh();
    prev = { value: null, exp: null, uh: null, manaFluids: null };
    dirty = true;
    save();
  }

  return { onStatus, onKill, summary, reset, save };
}

module.exports = { createFarm };
