'use strict';
// Drukte meten en de route omdraaien.
// Elke 5 seconden: staat er een andere speler in beeld? Daarvan een percentage
// over de laatste windowMin minuten. De eerste meting per hunt is "normaal".
// Rustige metingen schuiven dat normaal een beetje bij (zelflerend).
// Is het duidelijk drukker dan normaal, dan draait de bot de route om
// (route <-> route-omgekeerd). Na een nieuwe meting: rustiger dan ervoor?
// Dan zo laten. Nog drukker? Dan weer terug.

const fs = require('fs');
const path = require('path');

const SAMPLE_MS = 5000;
const SUFFIX = '-omgekeerd';
const DEFAULTS = { enabled: true, windowMin: 10, factor: 1.5, minDiffPts: 15, cooldownMin: 10, learnRate: 0.2 };

function baseName(name) {
  name = String(name || '');
  return name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : name;
}
function partnerName(name) {
  name = String(name || '');
  return name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : name + SUFFIX;
}
function round1(n) { return Math.round(n * 10) / 10; }

function createCrowd({ root, getConfig, listRoutes, switchRoute, log }) {
  const file = path.join(root, 'data', 'crowd.json');
  // Bewaard: per hunt (basisnaam van de route) wat normaal is.
  let saved = { baselines: {}, lastSwitchAt: 0, lastReason: '' };
  try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* nog niets */ }
  function save() {
    try { fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n'); } catch (e) { /* niets */ }
  }

  let samples = [];        // { t, p } p = 1 als er iemand in beeld stond
  let lastSampleAt = 0;
  let lastLearnAt = 0;     // normaal hooguit één keer per venster bijstellen
  let judge = null;        // { prePct, since, flips } na het omdraaien
  let busy = false;
  let missingWarned = '';
  let lastRoute = '';
  let holdUntil = 0;       // na een besluit (houden) eerst weer even niets doen

  function settings() {
    const c = (getConfig() || {}).crowd || {};
    const s = Object.assign({}, DEFAULTS, c);
    s.windowMs = Math.max(1, Number(s.windowMin) || DEFAULTS.windowMin) * 60000;
    s.cooldownMs = Math.max(0, Number(s.cooldownMin) || 0) * 60000;
    return s;
  }

  function ignoreSet() {
    const list = ((getConfig() || {}).safety || {}).playerIgnore || [];
    return new Set(list.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean));
  }

  function pctNow(windowMs, now) {
    const from = now - windowMs;
    const inWin = samples.filter((s) => s.t >= from);
    if (!inWin.length) return { pct: null, full: false };
    const pct = 100 * inWin.reduce((a, s) => a + s.p, 0) / inWin.length;
    // Vol genoeg: het venster is voor minstens 80% met metingen gevuld.
    const full = inWin.length * SAMPLE_MS >= windowMs * 0.8;
    return { pct, full };
  }

  async function flip(route, reason, now) {
    const to = partnerName(route);
    busy = true;
    try {
      await switchRoute(to);
      saved.lastSwitchAt = now;
      saved.lastReason = reason;
      save();
      samples = [];
      log('Drukte: ' + reason + ' Route omgedraaid naar ' + to + '.');
      return true;
    } catch (e) {
      log('Drukte: omdraaien lukte niet: ' + (e && e.message ? e.message : e));
      return false;
    } finally {
      busy = false;
    }
  }

  function onStatus(st) {
    const s = settings();
    if (!s.enabled || busy || !st || !st.player) return;
    // Alleen meten tijdens het jagen, niet in het depot of in een veilige zone.
    if (st.state !== 'running' || (st.phase && st.phase !== 'hunt') || st.player.inPz || st.player.isDead) return;
    const route = st.routeName || (getConfig() || {}).routeName || '';
    if (!route) return;
    // Route met de hand gewisseld naar een andere hunt: opnieuw beginnen.
    if (lastRoute && baseName(lastRoute) !== baseName(route)) { samples = []; judge = null; }
    lastRoute = route;
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_MS) return;
    lastSampleAt = now;

    const ignore = ignoreSet();
    const seen = (st.playersNear || []).some((p) => p && p.name && !ignore.has(String(p.name).toLowerCase()));
    samples.push({ t: now, p: seen ? 1 : 0 });
    samples = samples.filter((x) => x.t >= now - s.windowMs);

    const { pct, full } = pctNow(s.windowMs, now);
    if (!full || pct == null) return;
    const key = baseName(route);
    const base = saved.baselines[key];

    // 1. Leren: nog geen normaal voor deze hunt.
    if (base == null) {
      saved.baselines[key] = round1(pct);
      lastLearnAt = now;
      save();
      log('Drukte: normaal geleerd voor ' + key + ': ' + round1(pct) + '% van de tijd een speler in beeld.');
      return;
    }

    const hasPartner = listRoutes().includes(partnerName(route));
    if (!hasPartner) {
      if (missingWarned !== route) { missingWarned = route; log('Drukte: route ' + partnerName(route) + ' bestaat niet, dus omdraaien kan niet.'); }
      return;
    }

    // 2. Net omgedraaid: na een vol venster vergelijken met hoe druk het ervoor was.
    if (judge) {
      if (pct < judge.prePct) {
        log('Drukte: na omdraaien ' + round1(pct) + '% (was ' + round1(judge.prePct) + '%). Deze richting houden.');
        judge = null;
        lastLearnAt = now;
        holdUntil = now + s.cooldownMs;
      } else if (judge.flips < 2) {
        const pre = judge.prePct;
        judge = null; // na terugdraaien niet nog eens: anders blijft hij heen en weer gaan
        flip(route, 'na omdraaien nog drukker (' + round1(pct) + '%, was ' + round1(pre) + '%).', now);
      } else {
        judge = null;
      }
      return;
    }

    // 3. Duidelijk drukker dan normaal (en niet net omgedraaid)? Omdraaien.
    const tooBusy = pct >= base * s.factor && pct - base >= s.minDiffPts;
    if (tooBusy && now >= holdUntil && now - (saved.lastSwitchAt || 0) >= s.cooldownMs) {
      // Hoe druk is het nu echt? Het hele venster mengt rustige en drukke minuten,
      // dus ook naar de laatste helft kijken en de hoogste nemen.
      const recent = pctNow(s.windowMs / 2, now).pct;
      const pre = Math.max(pct, recent == null ? 0 : recent);
      flip(route, 'drukker dan normaal (' + round1(pct) + '%, normaal ' + round1(base) + '%).', now).then((ok) => {
        if (ok) judge = { prePct: pre, since: now, flips: 1 };
      });
      return;
    }

    // 4. Rustig genoeg: normaal een beetje bijstellen, hooguit één keer per venster.
    if (!tooBusy && now - lastLearnAt >= s.windowMs) {
      const next = round1(base + (Number(s.learnRate) || DEFAULTS.learnRate) * (pct - base));
      saved.baselines[key] = next;
      lastLearnAt = now;
      save();
    }
  }

  function summary() {
    const s = settings();
    const route = lastRoute || (getConfig() || {}).routeName || '';
    const { pct, full } = pctNow(s.windowMs, Date.now());
    const base = saved.baselines[baseName(route)];
    let phase = 'uit';
    if (s.enabled) phase = base == null ? 'leren' : (judge ? 'meten na omdraaien' : 'normaal');
    return {
      enabled: !!s.enabled,
      pct: pct == null ? null : round1(pct),
      full,
      baseline: base == null ? null : base,
      phase,
      lastSwitchAt: saved.lastSwitchAt || 0,
      lastReason: saved.lastReason || ''
    };
  }

  return { onStatus, summary, partnerName, baseName };
}

module.exports = { createCrowd, DEFAULTS };
