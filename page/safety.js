(function (B) {
  'use strict';

  // Safety: herkent gevaar en zegt tegen de engine 'pause' of 'alert'.
  // Harde regel: de anti-bot-controle (captcha) wordt nooit opgelost of omzeild.
  // We kijken alleen of het venster open staat en pauzeren dan.

  // Afkoeltijd per reden in ms. Zo komen er geen stapels meldingen.
  var COOLDOWN = {
    captcha: 30000,
    death: 60000,
    disconnect: 60000,
    player: 120000, // per speler
    lowHp: 60000
  };

  var lastAlert = {};   // reden -> tijdstip laatste melding
  var lastPlayer = {};  // spelernaam (kleine letters) -> tijdstip laatste melding

  // Geeft true als de reden weer gemeld mag worden, en onthoudt het tijdstip.
  function allowed(map, key, ms, now) {
    if (map[key] && now - map[key] < ms) return false;
    map[key] = now;
    return true;
  }

  // Pauze-redenen moeten de bot altijd stilzetten.
  // Binnen de afkoeltijd krijgt de engine 'silent', zodat er geen nieuwe melding komt.
  function pauseResult(reason, message, now) {
    var res = { action: 'pause', reason: reason, message: message };
    if (!allowed(lastAlert, reason, COOLDOWN[reason], now)) res.silent = true;
    return res;
  }

  function check(ctx) {
    var now = ctx.now;
    var api = B.api;
    var cfg = (ctx.config && ctx.config.safety) || {};
    var p = ctx.player;

    // 1. Quiz (anti-bot-controle): alleen herkennen en pauzeren.
    if (api.modalVisible('captcha-modal')) {
      return pauseResult('captcha', 'Quiz staat open. Los hem zelf op.', now);
    }

    // 2. Dood.
    if ((p && p.isDead) || api.modalVisible('death-modal')) {
      return pauseResult('death', 'Je karakter is dood. De bot staat op pauze.', now);
    }

    // 3. Verbinding weg.
    if (!api.ready() || !p) {
      return pauseResult('disconnect', 'De verbinding met het spel is weg. De bot staat op pauze.', now);
    }

    // 4. Speler in de buurt.
    var mode = cfg.onPlayer || 'alert';
    if (mode !== 'ignore') {
      var ignore = (Array.isArray(cfg.playerIgnore) ? cfg.playerIgnore : []).map(function (n) {
        return String(n).trim().toLowerCase();
      });
      var list = ctx.creatures || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || c.type !== 0 || c.id === p.id) continue;
        var name = String(c.name || '');
        var low = name.toLowerCase();
        if (ignore.indexOf(low) !== -1) continue;
        var dist = api.distance(p, c);
        if (!(dist <= 8)) continue;
        if (!allowed(lastPlayer, low, COOLDOWN.player, now)) continue;
        return {
          action: mode === 'pause' ? 'pause' : 'alert',
          reason: 'player',
          message: 'Speler ' + name + ' staat op ' + dist + ' tegels afstand.'
        };
      }
    }

    // 5. Lage HP.
    var lowPct = Number(cfg.lowHpAlertPct);
    if (lowPct > 0 && p.hpPct < lowPct) {
      if (allowed(lastAlert, 'lowHp', COOLDOWN.lowHp, now)) {
        return {
          action: 'alert',
          reason: 'lowHp',
          message: 'HP is laag: ' + Math.round(p.hpPct) + '%.'
        };
      }
    }

    return null;
  }

  function reset() {
    lastAlert = {};
    lastPlayer = {};
  }

  B.safety = { check: check, reset: reset };
})(window.WJBot = window.WJBot || {});
