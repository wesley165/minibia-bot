(function (B) {
  'use strict';

  // Brug in de pagina: praat met de bot-server op je Mac.
  // __WJ_URL__ en __WJ_TOKEN__ vult het bouwscript in.
  if (B.__bridge) return;
  B.__bridge = true;

  var URL_BASE = '__WJ_URL__';
  var TOKEN = '__WJ_TOKEN__';
  var outbox = [];
  var lastStatus = null;
  var seq = 0;          // volgnummer per event, zodat de server dubbele overslaat
  var sending = false;  // nooit twee verzendingen tegelijk
  var warned = false;
  var inactive = false; // ander tabblad is de actieve bot
  // Eigen id per tabblad: alleen het nieuwste tabblad is de actieve bot.
  var TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Elk bericht krijgt een wachttijd. Hangt een verbinding (bijvoorbeeld als de
  // VPS even hapert), dan breekt de bot hem af en probeert het opnieuw.
  // Zo blijven er nooit verbindingen hangen die alles blokkeren.
  var POST_MS = 10000;
  var POLL_MS = 30000; // de server houdt een poll hooguit 20 s open
  function timedFetch(url, opts, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms);
    opts = opts || {};
    opts.signal = ctl.signal;
    // De timer loopt door tot na het lezen van het antwoord. Afbreken van een
    // fetch die al klaar is doet niets, dus dat is veilig.
    return fetch(url, opts).catch(function (e) { clearTimeout(t); throw e; });
  }

  function post(path, body) {
    return timedFetch(URL_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WJ-Token': TOKEN, 'X-WJ-Tab': TAB },
      body: JSON.stringify(body)
    }, POST_MS).then(function (res) {
      if (res.status === 403 && !warned) {
        warned = true;
        console.warn('[WJBot] De server weigert de sleutel. Bouw de extensie opnieuw (npm run build) en vernieuw hem.');
      }
      return res;
    });
  }

  // Events verzamelen en elke 400 ms in één keer versturen.
  // Van de status telt alleen de nieuwste.
  window.wjEmit = function (type, payload) {
    if (type === 'status') lastStatus = payload;
    else outbox.push({ type: type, payload: payload, seq: ++seq });
    return Promise.resolve();
  };

  function flush() {
    if (sending || inactive) return;
    var events = outbox;
    outbox = [];
    if (lastStatus) { events.push({ type: 'status', payload: lastStatus }); lastStatus = null; }
    if (!events.length) return;
    sending = true;
    function keep() {
      // Server even weg: belangrijke events bewaren (max 200), in dezelfde volgorde.
      outbox = events.filter(function (e) { return e.type !== 'status'; }).concat(outbox).slice(-200);
    }
    Promise.resolve().then(function () { return post('/bridge/events', { events: events }); })
      .then(function (res) { if (!res.ok) keep(); })
      .catch(keep)
      .then(function () { sending = false; });
  }
  // Via de worker-timer, zodat het ook op de achtergrond doorloopt.
  if (B.every) B.every(flush, 400); else setInterval(flush, 400);

  // Wachtwoord voor automatisch inloggen ophalen (alleen van de eigen server).
  B.getSecret = function () {
    return timedFetch(URL_BASE + '/bridge/secret', { headers: { 'X-WJ-Token': TOKEN, 'X-WJ-Tab': TAB }, cache: 'no-store' }, POST_MS)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { return (d && d.password) || ''; })
      .catch(function () { return ''; });
  };

  // Eén opdracht uitvoeren in de bot.
  function run(cmd) {
    var E = B.engine;
    if (!E) return { ok: false, error: 'Bot is nog niet geladen.' };
    try {
      if (cmd.name === '__setConfig') return E.setConfig(cmd.args);
      if (cmd.name === '__setRoute') return E.setRoute(cmd.args);
      if (cmd.name === '__setRoutes') return E.setRoutes ? E.setRoutes(cmd.args) : { ok: false };
      if (cmd.name === '__setWanted') return E.setWanted ? E.setWanted(cmd.args) : { ok: false };
      return E.command(cmd.name, cmd.args);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function loop() {
    // Aanmelden, daarna steeds opdrachten ophalen.
    for (;;) {
      try {
        var hello = await post('/bridge/hello', { loaded: true });
        if (hello.ok) break;
      } catch (e) { /* server nog niet gestart */ }
      await sleep(3000);
    }
    for (;;) {
      try {
        var res = await timedFetch(URL_BASE + '/bridge/poll', { headers: { 'X-WJ-Token': TOKEN, 'X-WJ-Tab': TAB } }, POLL_MS);
        if (res.status === 409) {
          // Een ander (nieuwer) Minibia-tabblad is nu de bot. Deze stopt.
          if (!inactive) {
            inactive = true;
            try { if (B.engine) { B.engine.stop(); if (B.engine.setWanted) B.engine.setWanted(false); } } catch (e) { /* niets */ }
            console.warn('[WJBot] Een ander Minibia-tabblad bestuurt de bot. Herlaad dit tabblad om het weer over te nemen.');
          }
          await sleep(30000);
          continue;
        }
        if (!res.ok) { await sleep(3000); continue; }
        if (inactive) {
          // Dit tabblad is weer de actieve bot geworden.
          inactive = false;
          console.warn('[WJBot] Dit tabblad bestuurt de bot weer. Druk op Start in het dashboard.');
        }
        var data = await res.json();
        B.lastContact = Date.now();
        var cmds = (data && data.commands) || [];
        for (var i = 0; i < cmds.length; i++) {
          var result = run(cmds[i]);
          post('/bridge/result', { id: cmds[i].id, result: result }).catch(function () {});
        }
      } catch (e) {
        // Server weg of herstart: opnieuw aanmelden zodat config en route terugkomen.
        await sleep(3000);
        try { await post('/bridge/hello', { loaded: true }); } catch (e2) { /* later weer */ }
      }
    }
  }

  loop();
})(window.WJBot = window.WJBot || {});
