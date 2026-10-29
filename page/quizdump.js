(function (B) {
  'use strict';

  // Quiz-dumper: omdat we de quiz niet kunnen triggeren, leggen we hiermee
  // ALLES vast wat een quiz momenteel van ons verborgen houdt:
  //   - de ruwe HTML en tekst van het quizvenster (DOM-stijl),
  //   - de pixels van het game-canvas in de buurt van de quiz (canvas-stijl),
  //     als losse base64-PNG's.
  // Alles gaat naar data/quizdumps/ op de server via de bridge. Zo zien we
  // bij de eerstvolgende echte quiz exact hoe die opgebouwd is en kunnen we
  // de detectie en het oplossen daar maatwerk op maken.
  if (B.quizdump) return;

  // Wordt door scripts/build-extension.js vervangen (zelfde waarden als de
  // bridge-client gebruikt).
  var URL_BASE = '__WJ_URL__';
  var TOKEN = '__WJ_TOKEN__';

  var CHECK_MS = 1000;
  var DUMP_GAP_MS = 20000;    // maximaal één dump per 20 s zolang de quiz open is
  var CANVAS_SCALE = 2;        // canvas 2x groter opslaan: kleine letters leesbaar
  var lastDumpAt = 0;
  var roots = [];
  var seenSignatures = {};     // signature -> aantal keren gezien (nieuwe dumps alleen bij wijziging)

  function esc(n) { return String(n == null ? '' : n).replace(/[^a-z0-9\-]/gi, '_').slice(0, 40); }

  // Dezelfde herkenning als captchawatch: modal, .captcha-element of een
  // quiz-achtige toplaag. Gebruikt direct de gedeelde quizElement van
  // captchawatch als die bestaat, zodat beide altijd hetzelfde zien.
  function quizElement() {
    try {
      if (B.captchawatch && B.captchawatch.quizElement) return B.captchawatch.quizElement();
    } catch (e) { /* niets */ }
    try {
      if (B.api && B.api.modalVisible && B.api.modalVisible('captcha-modal')) {
        return document.getElementById('captcha-modal');
      }
    } catch (e) { /* niets */ }
    try {
      var els = document.querySelectorAll('.captcha, [id*="captcha" i], [class*="captcha" i]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) return el;
      }
    } catch (e) { /* niets */ }
    return null;
  }

  function outerHtml(el) {
    try {
      var h = String(el.outerHTML || '');
      return h.length > 300000 ? h.slice(0, 300000) : h;
    } catch (e) { return ''; }
  }

  // Ruwe structuur van het quizvak: per element de tag/id/klasse/tekst/en
  // positie. Dit is goud waard om later de selectors op af te stemmen.
  function structure(el) {
    var out = [];
    try {
      var all = el.querySelectorAll('*');
      for (var i = 0; i < all.length && out.length < 400; i++) {
        var n = all[i];
        var r = n.getBoundingClientRect();
        if (r.width < 2 && r.height < 2) continue;
        out.push({
          tag: n.tagName,
          id: n.id || '',
          cls: String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || '').slice(0, 120),
          role: (n.getAttribute && n.getAttribute('role')) || '',
          action: (n.getAttribute && n.getAttribute('action')) || '',
          text: String(n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
        });
      }
    } catch (e) { /* niets */ }
    return out;
  }

  // Canvas-snippet rondom het quizvenster, als base64-PNG. De WebGL-canvas
  // is meestal leeg na een frame (preserveDrawingBuffer:false), dus we
  // proberen ook de achtergrond van de pagina mee te nemen via de DOM-canvas
  // fallback. Lukt drawImage niet, dan slaan we dit onderdeel over.
  function canvasSnippets(rect) {
    var shots = [];
    try {
      var canvases = document.querySelectorAll('canvas');
      for (var i = 0; i < canvases.length && shots.length < 4; i++) {
        var c = canvases[i];
        var cr = c.getBoundingClientRect();
        if (cr.width < 4 || cr.height < 4) continue;
        try {
          var data = c.toDataURL('image/png');
          if (data && data.length > 1000) {
            shots.push({ name: 'canvas-' + i, url: data, x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) });
            continue;
          }
        } catch (e) /* WebGL zonder preserve buffer */ { /* probeer hijs-aanpak */ }
        // WebGL: forceren door het spel zelf een screenshot te vragen als
        // die API bestaat; anders overslaan.
        try {
          if (typeof gameClient !== 'undefined' && gameClient && typeof gameClient.screenshot === 'function') {
            var d2 = gameClient.screenshot();
            if (d2) shots.push({ name: 'canvas-' + i + '-game', url: d2, x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) });
          }
        } catch (e2) { /* niets */ }
      }
    } catch (e) { /* niets */ }
    // Extra: uitsnede rond het quizvak uit elk canvas, vergroot voor leesbaarheid.
    var extra = [];
    try {
      for (var j = 0; j < shots.length; j++) {
        var s = shots[j];
        if (!s.url || s.url.indexOf('base64') === -1) continue;
        var img = new Image();
        // Synchrone verwerking kan niet; laad async en voeg toe wanneer klaar.
        (function (shot) {
          img.onload = function () {
            try {
              var sx = Math.max(0, rect.x - shot.x - 20);
              var sy = Math.max(0, rect.y - shot.y - 20);
              var sw = Math.min(shot.w, rect.w + 40);
              var sh = Math.min(shot.h, rect.h + 40);
              if (sw < 8 || sh < 8) return;
              var cv = document.createElement('canvas');
              cv.width = Math.min(2000, Math.round(sw * CANVAS_SCALE));
              cv.height = Math.min(2000, Math.round(sh * CANVAS_SCALE));
              var ctx = cv.getContext('2d');
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
              var d3 = cv.toDataURL('image/png');
              if (d3 && d3.length > 500) {
                extra.push({ name: shot.name + '-crop', url: d3, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) });
              }
            } catch (e) { /* niets */ }
          };
          img.src = shot.url;
        })(s);
      }
    } catch (e) { /* niets */ }
    return { shots: shots, pending: extra };
  }

  // Alle modals/lagen bovenop de pagina — soms staat de quiz in een laag
  // die geen "captcha" heet.
  function topLayers() {
    var out = [];
    try {
      var els = document.querySelectorAll('body > *, body > div > *');
      for (var i = 0; i < els.length && out.length < 30; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        if (r.width < 60 || r.height < 40) continue;
        var st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
        var z = parseInt(st.zIndex, 10);
        if (!(z >= 100 || st.position === 'fixed')) continue;
        out.push({
          tag: el.tagName, id: el.id || '',
          cls: String(el.className || '').slice(0, 100),
          z: st.zIndex,
          text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
        });
      }
    } catch (e) { /* niets */ }
    return out;
  }

  function send(payload) {
    // Direct naar de bridge-server (dezelfde poort en sleutel als de
    // bridge-client gebruikt); geen omweg via commando's nodig.
    try {
      var body = JSON.stringify(payload);
      if (body.length > 7000000) return false;
      fetch(URL_BASE + '/bridge/quizdump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WJ-Token': TOKEN },
        body: body
      }).catch(function () { /* server niet bereikbaar: lokaal bewaren */ });
      return true;
    } catch (e) { /* niets */ }
    // Bewaar lokaal zodat je hem handmatig kunt ophalen via de console:
    // copy(JSON.stringify(WJBot.quizdump.pending()))
    try {
      window.__WJ_QUIZDUMPS = window.__WJ_QUIZDUMPS || [];
      window.__WJ_QUIZDUMPS.push(payload);
      if (window.__WJ_QUIZDUMPS.length > 10) window.__WJ_QUIZDUMPS.shift();
    } catch (e) { /* niets */ }
    return false;
  }

  function check() {
    try {
      var el = quizElement();
      if (!el) return;
      var now = Date.now();
      if (now - lastDumpAt < DUMP_GAP_MS) return;
      var html = outerHtml(el);
      if (!html) return;
      var sig = html.length + ':' + html.slice(0, 200);
      // Alleen opnieuw dumpen als de quiz veranderd is (nieuwe vraag/fase).
      var seen = seenSignatures[sig] || 0;
      if (seen >= 2) return;
      seenSignatures[sig] = seen + 1;
      lastDumpAt = now;
      var r = el.getBoundingClientRect();
      var rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      var cs = canvasSnippets(rect);
      var payload = {
        at: new Date().toISOString(),
        url: location.href.slice(0, 200),
        kind: (B.captchawatch && B.captchawatch.quizKind) ? B.captchawatch.quizKind() : 'onbekend',
        rect: rect,
        html: html,
        text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 4000),
        structure: structure(el),
        layers: topLayers(),
        canvases: cs.shots
      };
      send(payload);
      // Canvas-crops komen async binnen; stuur ze na 1,5 s in een tweede dump.
      setTimeout(function () {
        try {
          if (cs.pending.length) {
            send({ at: new Date().toISOString(), crops: cs.pending, followUpOf: payload.at });
          }
        } catch (e) { /* niets */ }
      }, 1500);
    } catch (e) { /* volgende keer weer */ }
  }

  B.quizdump = {
    check: check,
    pending: function () { return window.__WJ_QUIZDUMPS || []; },
    clear: function () { window.__WJ_QUIZDUMPS = []; }
  };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
