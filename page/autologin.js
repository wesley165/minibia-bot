(function (B) {
  'use strict';

  // Automatisch opnieuw inloggen zodra je bent uitgelogd (als dat aan staat
  // en de bot niet op Stop staat).
  // De bot typt nooit zelf iets in. Hij klikt alleen op knoppen van het spel:
  // Reconnect, Login (als het spel naam en wachtwoord zelf heeft ingevuld via
  // "Remember me") en daarna je character + Enter Game.
  // Instellingen: config.autoLogin = { enabled, account, character }.
  if (B.autologin) return;

  var CHECK_MS = 3000;
  var MAX_TRIES = 3;               // hooguit 3 inlogpogingen ...
  var WINDOW_MS = 10 * 60 * 1000;  // ... per 10 minuten
  var tries = [];
  var lastClick = 0;
  var waitUntil = 0;     // na 3 mislukte pogingen even wachten (2 minuten), dan opnieuw
  var WAIT_MS = 2 * 60 * 1000;
  var rcFails = 0;       // Reconnect: hoe vaak achter elkaar geprobeerd
  var lastRc = 0;
  var warned = {};
  var fetching = false; // wachtwoord wordt opgehaald

  function el(id) { return document.getElementById(id); }
  function visible(e) {
    try { return !!e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null; } catch (x) { return false; }
  }
  function log(msg) { if (B.engine && B.engine.log) B.engine.log(msg); }
  function alertOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    if (B.engine && B.engine.emit) B.engine.emit('alert', { reason: 'login', action: 'alert', message: msg });
  }
  function click(e, what) {
    lastClick = Date.now();
    log('Automatisch inloggen: ' + what + '.');
    e.click();
  }
  function countTry() {
    var now = Date.now();
    tries = tries.filter(function (t) { return now - t < WINDOW_MS; });
    if (tries.length >= MAX_TRIES) {
      // Niet opgeven (bijv. tijdens een server save): 2 minuten wachten en dan weer.
      waitUntil = now + WAIT_MS;
      tries = [];
      alertOnce('gaveup', 'Inloggen lukt even niet (3 pogingen). Misschien een server save. Ik probeer het elke 2 minuten opnieuw.');
      log('Automatisch inloggen: 3 pogingen mislukt, over 2 minuten weer.');
      return false;
    }
    tries.push(now);
    return true;
  }

  function check() {
    try {
      var cfg = B.engine && B.engine.getConfig ? B.engine.getConfig() : null;
      var al = cfg && cfg.autoLogin;
      if (!al || !al.enabled) return;

      var g = window.gameClient;
      var inGame = !!(g && g.player && g.networkManager && g.networkManager.isConnected());
      if (inGame) { waitUntil = 0; rcFails = 0; warned = {}; return; }

      // Alleen inloggen als de bot moet spelen. Staat hij op Stop (of weet de
      // server het nog niet), dan niet: ook geen Reconnect. Zo kun je zelf
      // ergens anders spelen zonder dat de bot je eruit gooit.
      if (!B.engine.getWanted || B.engine.getWanted() !== true) return;
      // Nooit tijdens de anti-bot-controle.
      if (visible(el('captcha-modal'))) return;
      var now = Date.now();
      // Rustig aan: hooguit één klik per 2 seconden.
      if (now - lastClick < 2000) return;

      // 0. Reconnect-knop van het spel gaat altijd voor. Blijven proberen,
      //    meteen, daarna met steeds iets langer wachten: 5, 10, 20, 40 en dan elke 60 seconden.
      var rc = Array.prototype.slice.call(document.querySelectorAll('button')).find(function (b) {
        return visible(b) && /^\s*reconnect\s*$/i.test(b.textContent);
      });
      if (rc) {
        var delay = rcFails === 0 ? 0 : Math.min(60000, 5000 * Math.pow(2, rcFails - 1));
        if (now - lastRc >= delay) {
          lastRc = now;
          rcFails++;
          click(rc, 'Reconnect (poging ' + rcFails + ')');
        }
        return;
      }

      // Na 3 mislukte inlogpogingen even wachten.
      if (now < waitUntil) return;

      // 1. Character kiezen en het spel in.
      var cs = el('character-select-modal');
      if (visible(cs)) {
        var want = String(al.character || '').toLowerCase();
        var rows = Array.prototype.slice.call(cs.querySelectorAll('.character-select-row'));
        var row = rows.find(function (r) {
          var n = r.querySelector('.character-select-name');
          return n && n.textContent.trim().toLowerCase() === want;
        });
        if (!row) { alertOnce('nochar', 'Character ' + al.character + ' staat niet in de lijst. Ik log niet in.'); return; }
        if (!row.classList.contains('selected')) { click(row, 'character ' + al.character + ' gekozen'); return; }
        var enter = el('char-select-enter');
        if (visible(enter)) click(enter, 'Enter Game');
        return;
      }

      // 2. Inlogvenster: account controleren, wachtwoord zo nodig invullen, Login.
      var fl = el('floater-enter');
      if (visible(fl)) {
        var u = el('user-username');
        var pw = el('user-password');
        var account = String(al.account || '').toLowerCase();
        if (!u || u.value.trim().toLowerCase() !== account) {
          alertOnce('account', 'In het inlogvenster staat een ander account dan ' + al.account + '. Ik log niet in.');
          return;
        }
        // Leeg wachtwoordveld: wachtwoord uit .env van de server invullen.
        if (!pw) return;
        if (!pw.value) {
          if (fetching) return;
          if (!B.getSecret) { alertOnce('nopw', 'Het wachtwoord staat niet op de server. Zet GAME_PASSWORD in .env.'); return; }
          fetching = true;
          B.getSecret().then(function (secret) {
            fetching = false;
            if (!secret) { alertOnce('nopw', 'Het wachtwoord staat niet op de server. Zet GAME_PASSWORD in .env.'); return; }
            // Waarde zetten zoals een gebruiker het intypt, zodat het spel het ziet.
            var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(pw, secret);
            pw.dispatchEvent(new Event('input', { bubbles: true }));
            pw.dispatchEvent(new Event('change', { bubbles: true }));
            log('Automatisch inloggen: wachtwoord ingevuld.');
          });
          return;
        }
        var btn = el('enter-game');
        if (visible(btn) && countTry()) click(btn, 'Login');
        return;
      }

      // 4. Startscherm: inlogvenster openen.
      var open = el('login-info');
      if (visible(open)) click(open, 'inlogvenster geopend');
    } catch (e) { /* volgende keer weer */ }
  }

  B.autologin = { check: check, reset: function () { waitUntil = 0; rcFails = 0; tries = []; warned = {}; } };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
