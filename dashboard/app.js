// Dashboard Minibia-bot. Gewone browser-JS, geen bibliotheken.
(function () {
  'use strict';

  // ---------- Kleine hulpjes ----------

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k in e && k !== 'list') e[k] = v;
      else e.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  // Invoerveld met een klein label dat alleen op mobiel zichtbaar is.
  function cell(label, input, extraClass) {
    return el('label', { class: 'cell' + (extraClass ? ' ' + extraClass : '') }, [
      el('span', { class: 'cell-label', text: label }),
      input
    ]);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function toInt(v, fallback) {
    var n = parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtDuration(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return h + ':' + pad(m) + ':' + pad(s % 60);
  }

  function fmtTime(t) {
    var d = t ? new Date(t) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  var ROUTE_NAME_RE = /^[a-z0-9_-]+$/;

  var STATE_TEXT = { stopped: 'Gestopt', running: 'Actief', paused: 'Gepauzeerd' };
  var STATE_CLASS = { stopped: 'badge-muted', running: 'badge-ok', paused: 'badge-warn' };
  var MODE_TEXT = { idle: 'Wacht', walking: 'Loopt', fighting: 'Vecht', action: 'Actie (touw, ladder)' };
  var REASON_TEXT = {
    captcha: 'anti-bot-controle',
    death: 'je karakter is dood',
    player: 'speler in de buurt',
    lowHp: 'weinig HP',
    disconnect: 'verbinding met het spel is weg',
    manual: 'met de hand',
    user: 'met de hand',
    routeEnd: 'einde van de route',
    waar: 'te ver van de route, breng de bot terug',
    verdieping: 'onverwacht op een andere verdieping',
    handmatig: 'met de hand',
    restock: 'bijvullen',
    character: 'verkeerd karakter ingelogd'
  };

  function reasonText(r) {
    if (!r) return '';
    if (typeof r === 'object') r = r.reason || r.message || '';
    return REASON_TEXT[r] || String(r);
  }

  function reasonKey(r) {
    if (!r) return '';
    if (typeof r === 'object') return r.reason || '';
    return String(r);
  }

  // ---------- Toestand van het dashboard ----------

  var S = {
    status: null,
    config: null,             // laatst opgeslagen config van de server
    targeting: null,          // concept (nog niet opgeslagen)
    healing: null,
    safety: null,             // { safety, notify }
    routeNames: [],
    route: null,              // concept van de route in de editor
    routeIsNew: false,
    lastIndexShown: null,
    log: [],
    seen: {},
    seenOrder: [],
    captchaOpen: false,
    captchaDismissed: false,
    audio: null,
    beepTimer: null,
    es: null,
    reconnectTimer: null
  };

  // ---------- Server ----------

  function api(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      // Niet (meer) ingelogd: naar de inlogpagina.
      if (res.status === 401) { location.replace('/login.html'); throw new Error('Log eerst in.'); }
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!res.ok) {
          var msg = (data && typeof data === 'object' && (data.error || data.message)) ||
            (typeof data === 'string' && data.length < 200 && data) ||
            ('De server gaf fout ' + res.status + '.');
          throw new Error(msg);
        }
        if (data && typeof data === 'object' && data.ok === false) {
          throw new Error(data.error || data.message || 'Dat lukte niet.');
        }
        return data;
      });
    }, function () {
      throw new Error('De server is niet bereikbaar. Draait de bot nog?');
    });
  }

  var globalTimer = null;
  function showGlobalError(msg) {
    var box = $('globalMsg');
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(globalTimer);
    globalTimer = setTimeout(function () { box.hidden = true; }, 8000);
  }

  var msgTimers = {};
  function setMsg(id, text, kind) {
    var m = $(id);
    m.textContent = text || '';
    m.className = 'save-msg' + (kind ? ' is-' + kind : '');
    clearTimeout(msgTimers[id]);
    if (kind === 'ok') {
      msgTimers[id] = setTimeout(function () {
        if (m.textContent === text) { m.textContent = ''; m.className = 'save-msg'; }
      }, 3000);
    }
  }

  function markDirty(id) { setMsg(id, 'Nog niet opgeslagen', 'dirty'); }

  function command(name, args) {
    return api('POST', '/api/command', { name: name, args: args || {} });
  }

  function runCommand(name, args) {
    return command(name, args).catch(function (err) {
      showGlobalError('Opdracht "' + name + '" lukte niet: ' + err.message);
      throw err;
    });
  }

  // ---------- Geluid (Web Audio) ----------

  // Browsers spelen pas geluid af na een klik. Daarom maken we de audio pas aan bij de eerste klik.
  function unlockAudio() {
    if (S.audio) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      S.audio = new Ctx();
      if (S.audio.state === 'suspended') S.audio.resume();
    } catch (e) { S.audio = null; }
    updateSoundHint();
  }
  document.addEventListener('click', unlockAudio, true);
  document.addEventListener('keydown', unlockAudio, true);

  function beep() {
    if (!S.audio) return;
    try {
      var ctx = S.audio;
      if (ctx.state === 'suspended') ctx.resume();
      var t = ctx.currentTime;
      [0, 0.35, 0.7].forEach(function (offset) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t + offset);
        osc.stop(t + offset + 0.3);
      });
    } catch (e) { /* geluid is niet belangrijk genoeg om te stoppen */ }
  }

  function updateSoundHint() {
    $('captchaSound').textContent = S.audio ? '' : 'Geluid staat uit. Klik één keer op de pagina om geluid aan te zetten.';
  }

  // ---------- Captcha-balk ----------

  function openCaptcha() {
    if (S.captchaOpen) return;
    S.captchaOpen = true;
    S.captchaDismissed = false;
    $('captchaError').textContent = '';
    $('captchaBar').hidden = false;
    updateSoundHint();
    beep();
    clearInterval(S.beepTimer);
    S.beepTimer = setInterval(beep, 15000);
    window.scrollTo(0, 0);
  }

  function closeCaptcha() {
    S.captchaOpen = false;
    S.captchaDismissed = true;
    clearInterval(S.beepTimer);
    $('captchaBar').hidden = true;
  }

  $('captchaResume').addEventListener('click', function () {
    var btn = $('captchaResume');
    btn.disabled = true;
    $('captchaError').textContent = '';
    command('resume').then(function () {
      closeCaptcha();
    }).catch(function (err) {
      $('captchaError').textContent = 'Doorgaan lukte niet: ' + err.message;
    }).then(function () { btn.disabled = false; });
  });

  function isCaptchaPause(st) {
    return st && st.state === 'paused' && reasonKey(st.pauseReason) === 'captcha';
  }

  // ---------- Log ----------

  function remember(key) {
    if (S.seen[key]) return false;
    S.seen[key] = true;
    S.seenOrder.push(key);
    if (S.seenOrder.length > 500) delete S.seen[S.seenOrder.shift()];
    return true;
  }

  function addLog(kind, text, time, extraClass) {
    var key = kind + '|' + (time || '') + '|' + text;
    if (time && !remember(key)) return false;
    S.log.unshift({ kind: kind, text: text, time: time || Date.now(), cls: extraClass || '' });
    if (S.log.length > 100) S.log.length = 100;
    renderLog();
    return true;
  }

  // Log tonen. Filter: alles, alleen meldingen of alleen kills.
  // Dezelfde regel meerdere keren achter elkaar wordt één regel met (3x).
  var logFilter = 'all';
  function renderLog() {
    var list = $('logList');
    list.textContent = '';
    var shown = S.log.filter(function (item) {
      if (logFilter === 'alert') return item.kind === 'alert';
      if (logFilter === 'kill') return item.kind === 'kill';
      return true;
    });
    var groups = [];
    shown.forEach(function (item) {
      var last = groups[groups.length - 1];
      if (last && last.item.text === item.text && last.item.kind === item.kind) last.n++;
      else groups.push({ item: item, n: 1 });
    });
    groups.forEach(function (g) {
      var item = g.item;
      var cls = item.cls || (item.kind === 'kill' ? 'is-kill' : '');
      list.appendChild(el('li', { class: cls }, [
        el('span', { class: 'log-time', text: fmtTime(item.time) }),
        el('span', { class: 'log-msg', text: item.text + (g.n > 1 ? ' (' + g.n + 'x)' : '') })
      ]));
    });
    $('logEmpty').hidden = shown.length > 0;
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-logfilter]'), function (b) {
    b.addEventListener('click', function () {
      logFilter = b.getAttribute('data-logfilter');
      Array.prototype.forEach.call(document.querySelectorAll('[data-logfilter]'), function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      renderLog();
    });
  });

  function setConn(kind, text) {
    var c = $('connBadge');
    c.className = 'conn conn-' + kind;
    c.textContent = text;
  }

  function parse(ev) {
    try { return JSON.parse(ev.data); } catch (e) { return null; }
  }

  function connect() {
    clearTimeout(S.reconnectTimer);
    if (S.es) { try { S.es.close(); } catch (e) { /* niets */ } }
    setConn('wait', 'Verbinden...');
    var es = new EventSource('/events');
    S.es = es;

    es.onopen = function () { setConn('on', 'Verbonden'); loadChat(); };
    es.onerror = function () {
      // Misschien is de sessie verlopen: dan naar de inlogpagina.
      fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (s) {
        if (s && s.required && !s.loggedIn) location.replace('/login.html');
      }).catch(function () {});
      if (es.readyState === EventSource.CLOSED) {
        setConn('off', 'Verbinding weg. Opnieuw proberen over 3 seconden.');
        S.reconnectTimer = setTimeout(connect, 3000);
      } else {
        setConn('wait', 'Verbinding weg. Opnieuw verbinden...');
      }
    };

    es.addEventListener('status', function (ev) {
      var d = parse(ev);
      if (d) onStatus(d);
    });
    es.addEventListener('alert', function (ev) {
      var d = parse(ev);
      if (d) onAlert(d);
    });
    es.addEventListener('log', function (ev) {
      var d = parse(ev);
      if (d) addLog('log', String(d.msg || ''), d.time);
    });
    es.addEventListener('chat', function (ev) {
      var d = parse(ev);
      if (d) addChat(d);
    });
    es.addEventListener('kill', function (ev) {
      var d = parse(ev);
      if (d) { addLog('kill', 'Gedood: ' + (d.name || 'onbekend monster'), d.time); emitDash('kill', d); }
    });
    // De server heeft de route omgedraaid (drukte). Zelf de actieve route bijwerken,
    // anders zet een volgende Opslaan de oude route terug.
    es.addEventListener('routeSwitched', function (ev) {
      var d = parse(ev) || {};
      if (!d.name) return;
      if (S.config) S.config.routeName = d.name;
      addLog('log', 'Route omgedraaid: ' + d.name + ' is nu actief.', Date.now(), 'is-alert');
      if (!routeDirty) loadRouteList(d.name);
    });
    es.addEventListener('routeEnd', function (ev) {
      var d = parse(ev) || {};
      addLog('routeEnd', 'Einde van de route bereikt.', d.time, 'is-alert');
    });
    // Tijdens opnemen komt elk nieuw waypoint binnen. Config en route opnieuw
    // ophalen, want er kan ook een nieuwe route zijn gemaakt.
    es.addEventListener('routeUpdated', function (ev) {
      var d = parse(ev) || {};
      var w = d.waypoint || {};
      addLog('log', 'Opgenomen: ' + (w.type || 'walk') + ' op ' + w.x + ', ' + w.y + ', ' + w.z, Date.now());
      // Alleen de route bijwerken. Niet opgeslagen wijzigingen in andere blokken
      // blijven staan. Wordt er net aan de route gewerkt, dan niets overschrijven.
      if (S.config && d.name) S.config.routeName = d.name;
      if (routeDirty) return;
      if (S.route && S.route.name === d.name) {
        S.route.waypoints.push(w);
        renderRoute();
      } else {
        loadRouteList(d.name);
      }
    });
  }

  function onAlert(a) {
    emitDash('alert', a);
    var reason = a.reason || '';
    // GM gezien of bericht van een GM: chatvenster openen (alleen bij een nieuwe melding).
    if (reason === 'gm' && a.from && gmFresh(a.time)) openGmChat(a.from);
    var text = (a.message || reasonText(reason) || 'Melding') + (a.action === 'pause' ? ' (bot gepauzeerd)' : '');
    var isNew = addLog('alert', 'Melding: ' + text, a.time, a.action === 'pause' ? 'is-alert-pause' : 'is-alert');
    if (reason !== 'captcha' || !isNew) return;
    // Bij opnieuw verbinden stuurt de server oude meldingen mee. Een oude captcha toont de balk alleen
    // als de bot nu nog door de captcha gepauzeerd staat.
    var fresh = !a.time || (Date.now() - Number(a.time)) < 2 * 60 * 1000;
    if (fresh || isCaptchaPause(S.status)) openCaptcha();
  }

  // ---------- Status tonen ----------

  // Losse onderdelen (kaart, grafiek, gebeurtenissen) luisteren mee via deze events.
  function emitDash(name, detail) {
    try { document.dispatchEvent(new CustomEvent('wj:' + name, { detail: detail })); } catch (e) { /* oude browser */ }
  }

  function onStatus(st) {
    emitDash('status', st);
    var prevCaptcha = isCaptchaPause(S.status);
    S.status = st;
    var nowCaptcha = isCaptchaPause(st);
    if (nowCaptcha && !S.captchaOpen && !S.captchaDismissed) openCaptcha();
    if (!nowCaptcha && prevCaptcha) S.captchaDismissed = false;
    renderStatus();
  }

  function renderRecording() {
    var rec = !!(S.status && S.status.recording);
    $('recStart').disabled = rec;
    $('recStop').disabled = !rec;
    $('recState').textContent = rec ? 'Opname loopt' : 'Geen opname';
    $('recState').className = 'badge ' + (rec ? 'badge-danger' : 'badge-muted');
  }

  function renderStatus() {
    try { renderRecording(); } catch (e) { /* element nog niet klaar */ }
    var st = S.status || {};
    var state = st.state || '';

    var badge = $('stateBadge');
    badge.textContent = STATE_TEXT[state] || 'Onbekend';
    var cls = STATE_CLASS[state] || 'badge-muted';
    if (state === 'paused' && reasonKey(st.pauseReason) === 'captcha') cls = 'badge-danger';
    badge.className = 'badge ' + cls;

    var reasonParts = [];
    if (state === 'paused' && st.pauseReason) reasonParts.push('Reden: ' + reasonText(st.pauseReason));
    if (S.status && st.ready === false) reasonParts.push('Spel is nog niet klaar (inlogscherm of laden).');
    $('stateReason').textContent = reasonParts.join(' ');

    var known = !!S.status;
    $('btnStart').disabled = known && state !== 'stopped';
    $('btnPause').disabled = known && state !== 'running';
    $('btnResume').disabled = known && state !== 'paused';
    $('btnStop').disabled = known && state === 'stopped';

    renderPlayer(st);
    renderStats(st);
    renderNear(st);
    renderAttention(st);
    renderRings(st);
    updateRouteHighlight();
    updateWpHereInfo();
  }

  // Hoe lang kun je nog jagen? Dat bepalen de life rings: één ring gaat 20 minuten mee.
  var RING_MIN = 20;
  function ringMinutes(st) {
    var n = st && st.supplies ? Number(st.supplies.lifeRings) : NaN;
    return n >= 0 ? n * RING_MIN : null;
  }
  function fmtHoursMin(min) {
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? h + ' u ' + (m < 10 ? '0' : '') + m + ' m' : m + ' min';
  }
  function renderRings(st) {
    var box = $('ovRings');
    if (!box) return;
    var min = ringMinutes(st);
    box.className = '';
    if (min == null) { box.textContent = '-'; return; }
    box.textContent = st.supplies.lifeRings + ' (' + fmtHoursMin(min) + ')';
    if (min < 60) box.className = 'is-low';
    else if (min < 120) box.className = 'is-warn';
  }

  // Bovenaan het overzicht: alleen wat nu aandacht nodig heeft, in korte zinnen.
  function renderAttention(st) {
    var box = $('ovAttention');
    if (!box) return;
    var items = [];
    var p = st.player || {};
    if (st.state === 'paused') items.push({ hot: true, text: 'Bot staat op pauze' + (st.pauseReason ? ': ' + reasonText(st.pauseReason) : '') + '.' });
    if (st.state === 'stopped') items.push({ hot: false, text: 'Bot staat uit.' });
    if (p.isDead) items.push({ hot: true, text: 'Je karakter is dood.' });
    var players = st.playersNear || [];
    if (players.length) {
      items.push({ hot: true, text: 'Speler in de buurt: ' + players.map(function (x) { return x.name + ' (' + x.dist + ' tegels)'; }).join(', ') + '.' });
    }
    if (p.hpPct != null && Number(p.hpPct) < 50 && !p.isDead) items.push({ hot: true, text: 'HP is laag: ' + Math.round(Number(p.hpPct)) + '%.' });
    if (st.stuck && st.stuck.reason) items.push({ hot: true, text: 'Vast sinds ' + st.stuck.seconds + ' seconden.' });
    var rm = ringMinutes(st);
    if (rm != null && rm < 60) items.push({ hot: true, text: 'Bijna geen life rings meer: nog ' + st.supplies.lifeRings + ' (' + fmtHoursMin(rm) + ').' });
    box.textContent = '';
    box.hidden = !items.length;
    box.className = 'ov-attention' + (items.some(function (x) { return x.hot; }) ? ' is-hot' : '');
    items.forEach(function (x) { box.appendChild(el('p', { text: x.text })); });
  }

  function renderPlayer(st) {
    var p = st.player;
    $('playerEmpty').hidden = !!p;
    $('playerBox').hidden = !p;
    if (!p) return;
    $('pName').textContent = p.name || 'Onbekend';
    $('pLevel').textContent = p.level != null ? p.level : '?';
    var hpPct = Math.max(0, Math.min(100, Number(p.hpPct) || 0));
    var manaPct = Math.max(0, Math.min(100, Number(p.manaPct) || 0));
    $('pHpBar').style.width = hpPct + '%';
    $('pManaBar').style.width = manaPct + '%';
    $('pHpText').textContent = (p.hp != null ? p.hp : '?') + ' / ' + (p.maxHp != null ? p.maxHp : '?') + ' (' + Math.round(hpPct) + '%)';
    $('pManaText').textContent = (p.mana != null ? p.mana : '?') + ' / ' + (p.maxMana != null ? p.maxMana : '?') + ' (' + Math.round(manaPct) + '%)';
    $('pCap').textContent = (p.cap != null ? p.cap : '?') + (p.maxCap ? ' / ' + p.maxCap : '');
    var sup = st.supplies || {};
    $('pLifeRings').textContent = sup.lifeRings != null ? sup.lifeRings : '?';
    $('pUh').textContent = sup.uh != null ? sup.uh : '?';
    $('pMf').textContent = sup.manaFluids != null ? sup.manaFluids : '?';
    $('pPos').textContent = p.x + ', ' + p.y + ', ' + p.z + (p.inPz ? ' (veilige zone)' : '');
    var mode = MODE_TEXT[st.mode] || st.mode || 'Wacht';
    if (p.isDead) mode = 'Dood';
    // Vastzit-controle: laat zien hoe lang en waarom.
    if (st.stuck && st.stuck.reason) mode = 'Vast (' + st.stuck.seconds + ' s, stap ' + st.stuck.step + '): ' + st.stuck.reason;
    $('pMode').textContent = mode;
    var t = st.target;
    $('pTarget').textContent = t
      ? t.name + ' (' + Math.round(Number(t.hpPct) || 0) + '% HP, ' + (t.dist != null ? t.dist : '?') + ' tegels)'
      : 'Geen doel';
  }

  // Getal met punten per duizend, zoals 12.345.
  function fmtNum(n) {
    n = Math.round(Number(n) || 0);
    return n.toLocaleString('nl-NL');
  }

  function renderFarm(st) {
    var f = st.farm;
    if (f) {
      $('fGph').textContent = fmtNum(f.perHour.gold);
      $('fXph').textContent = fmtNum(f.perHour.xp);
      $('fKph').textContent = fmtNum(f.perHour.kills);
      if ($('fXph2')) $('fXph2').textContent = fmtNum(f.perHour.xp);
      if ($('fGph2')) $('fGph2').textContent = fmtNum(f.perHour.gold);
      $('fGold').textContent = fmtNum(f.totals.gold) + ' GP';
      $('fXp').textContent = fmtNum(f.totals.xp);
      $('fKills').textContent = fmtNum(f.totals.kills);
      // Achter het verbruik: hoeveel uur de voorraad nog genoeg is.
      var sup = st.supplies || {};
      var left = function (have, perHour) {
        if (!(perHour > 0) || typeof have !== 'number') return '';
        return ' (' + (have / perHour).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + ' uur)';
      };
      $('fUhph').textContent = fmtNum(f.perHour.uh || 0) + left(sup.uh, f.perHour.uh);
      $('fMfph').textContent = fmtNum(f.perHour.mf || 0) + left(sup.manaFluids, f.perHour.mf);
      $('fUh').textContent = fmtNum(f.totals.uh || 0);
      $('fMf').textContent = fmtNum(f.totals.mf || 0);
      var since = new Date(f.since);
      $('fSince').textContent = 'Per uur: gemeten over de laatste ' + Math.min(60, f.measuredMinutes) + ' minuten. Totaal: sinds ' +
        since.toLocaleDateString('nl-NL') + ' ' + since.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) + '.';
    }
    var w = st.wallet;
    if (w) {
      $('wValue').textContent = fmtNum(w.value) + ' GP';
      $('wCrystal').textContent = fmtNum(w.crystal);
      $('wPlatinum').textContent = fmtNum(w.platinum);
      $('wGold').textContent = fmtNum(w.gold);
    }
  }

  function renderStats(st) {
    var s = st.stats || {};
    $('sRuntime').textContent = fmtDuration(s.runtimeMs);
    $('sKills').textContent = s.kills || 0;
    // Kills per uur komt van de server (laatste uur), zodat het na een herlading blijft kloppen.
    var kph = st.farm && st.farm.perHour ? Number(st.farm.perHour.kills) || 0 : (Number(s.killsPerHour) || 0);
    $('sKph').textContent = fmtNum(kph);
    renderFarm(st);
    var r = st.routeName
      ? 'Route ' + st.routeName + ', waypoint ' + ((st.waypointIndex || 0) + 1) + ' van ' + (st.waypointCount || 0)
      : '';
    $('sRoute').textContent = r;
    renderCrowd(st.crowd);
  }

  function renderCrowd(c) {
    if (!$('crowdPct')) return;
    c = c || {};
    $('crowdPct').textContent = c.pct == null ? '-' : c.pct + '%' + (c.full ? '' : ' (nog aan het meten)');
    $('crowdBase').textContent = c.baseline == null ? 'nog niet geleerd' : c.baseline + '%';
    $('crowdPhase').textContent = c.phase || '-';
    $('crowdLast').textContent = c.lastSwitchAt ? fmtTime(c.lastSwitchAt) + (c.lastReason ? ': ' + c.lastReason : '') : 'nog niet';
  }

  function renderNearList(listId, items, emptyText) {
    var list = $(listId);
    list.textContent = '';
    if (!items || !items.length) {
      list.appendChild(el('li', { class: 'is-empty', text: emptyText }));
      return;
    }
    items.forEach(function (it) {
      list.appendChild(el('li', {}, [
        el('span', { text: it.name || '?' }),
        el('span', { text: (it.dist != null ? it.dist : '?') + ' tegels' })
      ]));
    });
  }

  function renderNear(st) {
    renderNearList('nearMonsters', st.monstersNear, 'Geen monsters in de buurt');
    renderNearList('nearPlayers', st.playersNear, 'Geen spelers in de buurt');
  }

  // ---------- Knoppen bovenbalk ----------

  $('btnStart').addEventListener('click', function () { runCommand('start').catch(function () {}); });
  $('btnPause').addEventListener('click', function () { runCommand('pause', { reason: 'manual' }).catch(function () {}); });
  $('btnResume').addEventListener('click', function () {
    runCommand('resume').then(function () { if (S.captchaOpen) closeCaptcha(); }).catch(function () {});
  });
  $('btnStop').addEventListener('click', function () { runCommand('stop').catch(function () {}); });

  // Opbrengst opnieuw tellen vanaf nu.
  $('farmReset').addEventListener('click', function () {
    if (!window.confirm('Wil je de opbrengst opnieuw gaan tellen vanaf nu?')) return;
    runCommand('farmReset').then(function () { setMsg('farmMsg', 'Teller staat weer op 0.', 'ok'); }).catch(function () {});
  });

  // Uitloggen: sessie weg, terug naar de inlogpagina.
  $('btnLogout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .catch(function () {})
      .then(function () { location.replace('/login.html'); });
  });

  // Route opnemen: jij loopt, de bot zet waypoints neer.
  $('recStart').addEventListener('click', function () {
    var step = toInt($('recStep').value, 4);
    var name = String($('recName').value || '').trim().toLowerCase();
    if (name && !/^[a-z0-9_-]+$/.test(name)) {
      setMsg('recMsg', 'Gebruik voor de naam alleen kleine letters, cijfers, - en _.', 'error');
      return;
    }
    runCommand('recordStart', { step: step, routeName: name }).then(function (res) {
      if (res && res.ok === false) { setMsg('recMsg', res.error || 'Opnemen lukt niet.', 'error'); return; }
      setMsg('recMsg', 'Opname loopt in route ' + (res && res.routeName ? res.routeName : name) + '. Loop nu zelf je route.', 'ok');
      if (res && res.routeName) {
        if (S.config) S.config.routeName = res.routeName;
        routeDirty = false;
        loadRouteList(res.routeName);
      }
    }).catch(function () {});
  });
  $('recStop').addEventListener('click', function () {
    runCommand('recordStop').then(function () {
      setMsg('recMsg', 'Opname gestopt. Controleer de waypoints hieronder.', 'ok');
    }).catch(function () {});
  });

  // ---------- Config laden ----------

  function loadConfig() {
    return api('GET', '/api/config').then(function (cfg) {
      S.config = cfg || {};
      resetConfigDrafts();
    }).catch(function (err) {
      showGlobalError('Instellingen laden lukte niet: ' + err.message);
    });
  }

  function resetConfigDrafts() {
    var c = S.config || {};
    S.targeting = clone(c.targeting || { monsters: [], attackAll: false, maxDistance: 7, switchIfAdjacent: true });
    if (!Array.isArray(S.targeting.monsters)) S.targeting.monsters = [];
    S.healing = clone(c.healing || { skipInPz: true, rules: [] });
    if (!Array.isArray(S.healing.rules)) S.healing.rules = [];
    S.safety = {
      safety: clone(c.safety || { onPlayer: 'alert', playerIgnore: [], lowHpAlertPct: 30 }),
      notify: clone(c.notify || { ntfyTopic: '', desktop: true })
    };
    renderTargeting();
    renderHealing();
    renderSafety();
    renderCrowdSettings();
  }

  var CROWD_DEFAULTS = { enabled: true, windowMin: 10, factor: 1.5, minDiffPts: 15, cooldownMin: 10 };
  function renderCrowdSettings() {
    if (!$('crowdEnabled')) return;
    var c = Object.assign({}, CROWD_DEFAULTS, (S.config && S.config.crowd) || {});
    $('crowdEnabled').checked = c.enabled !== false;
    $('crowdWindow').value = c.windowMin;
    $('crowdFactor').value = c.factor;
    $('crowdDiff').value = c.minDiffPts;
    $('crowdCooldown').value = c.cooldownMin;
  }

  // Slaat één blok op. De andere blokken blijven zoals ze op de server staan.
  function saveConfigPart(msgId, btnId, apply) {
    if (!S.config) {
      setMsg(msgId, 'De instellingen zijn nog niet geladen.', 'error');
      return Promise.resolve(false);
    }
    var btn = $(btnId);
    btn.disabled = true;
    setMsg(msgId, 'Bezig met opslaan...', '');
    // Opslaan na elkaar, zodat twee blokken elkaars wijziging niet overschrijven.
    var job = saveQueue.then(function () {
      var next = clone(S.config);
      apply(next);
      return api('PUT', '/api/config', next).then(function (res) {
        S.config = (res && typeof res === 'object' && res.targeting) ? res : next;
        setMsg(msgId, 'Opgeslagen', 'ok');
        return true;
      });
    }).catch(function (err) {
      setMsg(msgId, 'Opslaan lukte niet: ' + err.message, 'error');
      return false;
    }).then(function (ok) { btn.disabled = false; return ok; });
    saveQueue = job;
    return job;
  }
  var saveQueue = Promise.resolve();

  // ---------- Targeting ----------

  function renderTargeting() {
    var t = S.targeting;
    var list = $('monsterList');
    list.textContent = '';
    // Per prioriteit een groepje: Prio 1 eerst. Elk monster is een klein label
    // met een keuzelijst voor de prioriteit en een kruisje om te verwijderen.
    var prios = [];
    t.monsters.forEach(function (m) {
      var p = toInt(m.priority, 1);
      if (prios.indexOf(p) < 0) prios.push(p);
    });
    prios.sort(function (x, y) { return x - y; });
    var maxPrio = Math.max(5, prios.length ? prios[prios.length - 1] : 1);
    prios.forEach(function (p) {
      var chips = el('div', { class: 'prio-chips' });
      t.monsters.forEach(function (m, i) {
        if (toInt(m.priority, 1) !== p) return;
        var sel = el('select', {
          'aria-label': 'Prioriteit van ' + (m.name || 'monster'),
          onchange: function (e) { m.priority = toInt(e.target.value, 1); markDirty('targetingMsg'); renderTargeting(); }
        });
        for (var n = 1; n <= maxPrio; n++) sel.appendChild(el('option', { value: String(n), text: 'prio ' + n }));
        sel.value = String(p);
        chips.appendChild(el('span', { class: 'chip' }, [
          el('span', { text: m.name || '?' }),
          sel,
          el('button', {
            class: 'chip-x', type: 'button', text: '\u00d7', title: (m.name || 'Monster') + ' verwijderen', 'aria-label': (m.name || 'Monster') + ' verwijderen',
            onclick: function () { t.monsters.splice(i, 1); markDirty('targetingMsg'); renderTargeting(); }
          })
        ]));
      });
      list.appendChild(el('div', { class: 'prio-group' }, [
        el('p', { class: 'prio-title', text: 'Prioriteit ' + p + (p === 1 ? ' (eerst aanvallen)' : '') }),
        chips
      ]));
    });
    $('monsterEmpty').hidden = t.monsters.length > 0;
    $('tAttackAll').checked = !!t.attackAll;
    $('tSwitch').checked = t.switchIfAdjacent !== false;
    $('tMaxDist').value = t.maxDistance != null ? t.maxDistance : 7;
    $('tApproachMin').value = t.approachMinMs != null ? t.approachMinMs / 1000 : 2;
    $('tKeep').value = t.keepDistance != null ? t.keepDistance : 0;
  }

  function nextPriority() {
    var max = 0;
    S.targeting.monsters.forEach(function (m) { max = Math.max(max, toInt(m.priority, 0)); });
    return max + 1;
  }

  function hasMonster(name) {
    var n = name.trim().toLowerCase();
    return S.targeting.monsters.some(function (m) { return String(m.name || '').trim().toLowerCase() === n; });
  }

  $('monsterAdd').addEventListener('click', function () {
    if (!S.targeting) return;
    var input = $('monsterNewName');
    var name = input.value.trim();
    if (!name) { setMsg('targetingMsg', 'Vul eerst een naam in.', 'error'); return; }
    if (hasMonster(name)) { setMsg('targetingMsg', name + ' staat al in de lijst.', 'error'); return; }
    S.targeting.monsters.push({ name: name, priority: nextPriority() });
    input.value = '';
    markDirty('targetingMsg');
    renderTargeting();
  });
  $('monsterNewName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('monsterAdd').click();
  });

  $('monsterNear').addEventListener('click', function () {
    if (!S.targeting) return;
    var near = (S.status && S.status.monstersNear) || [];
    var added = [];
    near.forEach(function (m) {
      var name = String(m.name || '').trim();
      if (!name || hasMonster(name)) return;
      S.targeting.monsters.push({ name: name, priority: nextPriority() });
      added.push(name);
    });
    if (!added.length) {
      setMsg('targetingMsg', near.length ? 'Deze monsters staan al in de lijst.' : 'Er zijn nu geen monsters in de buurt.', 'error');
      return;
    }
    markDirty('targetingMsg');
    renderTargeting();
    setMsg('targetingMsg', 'Toegevoegd: ' + added.join(', ') + '. Nog niet opgeslagen.', 'dirty');
  });

  $('tAttackAll').addEventListener('change', function (e) { S.targeting.attackAll = e.target.checked; markDirty('targetingMsg'); });
  $('tSwitch').addEventListener('change', function (e) { S.targeting.switchIfAdjacent = e.target.checked; markDirty('targetingMsg'); });
  $('tMaxDist').addEventListener('input', function (e) { S.targeting.maxDistance = toInt(e.target.value, 7); markDirty('targetingMsg'); });
  $('tApproachMin').addEventListener('input', function (e) {
    var sec = parseFloat(String(e.target.value).replace(',', '.'));
    S.targeting.approachMinMs = sec >= 0 ? Math.round(Math.min(sec, 10) * 1000) : 2000;
    markDirty('targetingMsg');
  });

  $('tKeep').addEventListener('input', function (e) {
    S.targeting.keepDistance = Math.max(0, Math.min(5, toInt(e.target.value, 0)));
    markDirty('targetingMsg');
  });

  $('targetingSave').addEventListener('click', function () {
    if (!S.targeting) return;
    var empty = S.targeting.monsters.some(function (m) { return !String(m.name || '').trim(); });
    if (empty) { setMsg('targetingMsg', 'Er is een monster zonder naam. Vul die in of verwijder hem.', 'error'); return; }
    var t = clone(S.targeting);
    t.monsters.forEach(function (m) { m.name = m.name.trim(); m.priority = toInt(m.priority, 1); });
    saveConfigPart('targetingMsg', 'targetingSave', function (cfg) {
      cfg.targeting = Object.assign({}, cfg.targeting || {}, t);
    });
  });

  // ---------- Chatvenster met een GM ----------

  var GM_RE = /^(gm|cm|god|tutor)\b/i;
  var gmName = '';
  var gmShown = {};      // berichten die al in het venster staan (geen dubbele)
  var gmClosedAt = 0;    // venster gesloten: oudere meldingen openen het niet opnieuw
  var gmTitle = document.title;
  var gmBlink = null;

  function gmKey(m) { return [m.time, m.kind, m.from, m.to, m.text].join('|'); }

  // Mag een melding of bericht het venster (opnieuw) openen? Alleen als hij nieuw is.
  function gmFresh(time) {
    var t = Number(time) || Date.now();
    return Date.now() - t < 2 * 60 * 1000 && t > gmClosedAt;
  }

  function gmLine(m) {
    var key = gmKey(m);
    if (gmShown[key]) return;
    gmShown[key] = true;
    var mine = m.kind === 'sent';
    var t = new Date(m.time || Date.now()).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var li = el('li', { class: 'gm-chat-msg' + (mine ? ' is-me' : '') }, [
      el('span', { class: 'muted', text: t + ' ' + (mine ? 'Jij' : 'Chatter') }),
      el('span', { text: m.text || '' })
    ]);
    $('gmChatList').appendChild(li);
    $('gmChatList').scrollTop = $('gmChatList').scrollHeight;
  }

  function openGmChat(name) {
    if (!name) return;
    var fresh = $('gmChat').hidden || gmName.toLowerCase() !== String(name).toLowerCase();
    gmName = String(name);
    if (fresh) {
      $('gmChatList').textContent = '';
      gmShown = {};
      $('gmChatNote').hidden = true;
      // Eerdere berichten van en aan deze GM erbij zetten.
      api('GET', '/api/chat').then(function (items) {
        (items || []).forEach(function (m) {
          var who = String(m.kind === 'sent' ? m.to : m.from || '').toLowerCase();
          if (who === gmName.toLowerCase()) gmLine(m);
        });
      }).catch(function () { /* dan alleen nieuwe berichten */ });
    }
    $('gmChat').hidden = false;
    $('gmChatText').focus();
    // Tabbladtitel laten knipperen tot je het venster gebruikt.
    if (!gmBlink) {
      var on = false;
      gmBlink = setInterval(function () { on = !on; document.title = on ? "Let's Chat!" : gmTitle; }, 1000);
    }
  }

  function stopGmBlink() {
    if (gmBlink) { clearInterval(gmBlink); gmBlink = null; document.title = gmTitle; }
  }

  function sendGmChat() {
    var text = $('gmChatText').value.trim();
    if (!gmName || !text) return;
    stopGmBlink();
    $('gmChatSend').disabled = true;
    command('sendPm', { to: gmName, text: text }).then(function () {
      $('gmChatText').value = '';
      $('gmChatNote').hidden = true;
    }).catch(function (err) {
      $('gmChatNote').textContent = 'Versturen lukte niet: ' + err.message;
      $('gmChatNote').hidden = false;
    }).then(function () { $('gmChatSend').disabled = false; $('gmChatText').focus(); });
  }

  $('gmChatSend').addEventListener('click', sendGmChat);
  $('gmChatText').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendGmChat(); });
  $('gmChatText').addEventListener('focus', stopGmBlink);
  $('gmChatClose').addEventListener('click', function () { $('gmChat').hidden = true; gmClosedAt = Date.now(); stopGmBlink(); });

  // ---------- Berichten in het spel ----------

  function addChat(m) {
    // Bericht van of aan de GM van het open chatvenster: ook daar tonen.
    var other = String(m.kind === 'sent' ? m.to : m.from || '');
    if (gmName && !$('gmChat').hidden && other.toLowerCase() === gmName.toLowerCase()) gmLine(m);
    else if (m.kind !== 'sent' && (m.kind === 'staff' || GM_RE.test(other)) && gmFresh(m.time)) openGmChat(other);
    var list = $('chatList');
    var t = new Date(m.time || Date.now()).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    var who = m.kind === 'sent' ? 'Jij aan ' + (m.to || '') : (m.kind === 'staff' ? 'Mogelijk GM ' : '') + (m.from || '');
    var li = el('li', { class: 'chat-item' + (m.kind === 'sent' ? ' chat-sent' : '') }, [
      el('span', { class: 'muted small', text: t }),
      el('strong', { text: who }),
      el('span', { text: m.text || '' })
    ]);
    if (m.kind !== 'sent') {
      li.appendChild(el('button', { class: 'btn btn-small', type: 'button', text: 'Antwoord', onclick: function () {
        $('chatTo').value = m.from || '';
        $('chatText').focus();
      } }));
      if (!$('chatTo').value) $('chatTo').value = m.from || '';
    }
    list.appendChild(li);
    while (list.children.length > 50) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    $('chatEmpty').hidden = true;
  }

  function loadChat() {
    return api('GET', '/api/chat').then(function (items) {
      $('chatList').textContent = '';
      (Array.isArray(items) ? items : []).forEach(addChat);
      $('chatEmpty').hidden = $('chatList').children.length > 0;
    }).catch(function () { /* later weer */ });
  }

  function sendChat() {
    var to = $('chatTo').value.trim();
    var text = $('chatText').value.trim();
    if (!to || !text) { setMsg('chatMsg', 'Vul een naam en een bericht in.', 'error'); return; }
    $('chatSend').disabled = true;
    command('sendPm', { to: to, text: text }).then(function () {
      $('chatText').value = '';
      setMsg('chatMsg', 'Verstuurd', 'ok');
    }).catch(function (err) {
      setMsg('chatMsg', err.message, 'error');
    }).then(function () { $('chatSend').disabled = false; });
  }
  $('chatSend').addEventListener('click', sendChat);
  $('chatText').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });

  // ---------- Sets ----------

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function loadSets() {
    return api('GET', '/api/sets').then(function (list) {
      var box = $('setList');
      box.textContent = '';
      list = Array.isArray(list) ? list : [];
      list.forEach(function (s) {
        box.appendChild(el('div', { class: 'set-row' }, [
          el('div', { class: 'set-info' }, [
            el('strong', { text: s.name }),
            el('span', { class: 'muted small', text: 'Route ' + s.routeName + ' + ' + Math.max(0, (s.routes || []).length - 1) + ' refill-routes' +
              ((s.monsters || []).length ? ', monsters: ' + s.monsters.join(', ') : '') +
              (s.healingRules ? ', ' + s.healingRules + ' healing-regels' : '') +
              (s.savedAt ? ', opgeslagen ' + fmtDate(s.savedAt) : '') })
          ]),
          el('button', { class: 'btn btn-ok', type: 'button', text: 'Laden', onclick: function () { loadSet(s); } }),
          el('button', { class: 'btn btn-danger-soft', type: 'button', text: 'Verwijderen', onclick: function () { deleteSet(s); } })
        ]));
      });
      $('setEmpty').hidden = list.length > 0;
    }).catch(function (err) { setMsg('setMsg', 'Sets laden lukte niet: ' + err.message, 'error'); });
  }

  function loadSet(s) {
    if (!window.confirm('Set ' + s.name + ' laden? De route, refill, monsterlijst en healing worden dan teruggezet zoals ze in de set staan.')) return;
    setMsg('setMsg', 'Bezig met laden...', '');
    api('POST', '/api/sets/' + encodeURIComponent(s.id) + '/load').then(function () {
      setMsg('setMsg', 'Set ' + s.name + ' geladen', 'ok');
      return loadConfig().then(function () { return loadRouteList(s.routeName); });
    }).catch(function (err) { setMsg('setMsg', 'Laden lukte niet: ' + err.message, 'error'); });
  }

  function deleteSet(s) {
    if (!window.confirm('Set ' + s.name + ' verwijderen? De routes zelf blijven bestaan.')) return;
    api('DELETE', '/api/sets/' + encodeURIComponent(s.id)).then(function () {
      setMsg('setMsg', 'Set verwijderd', 'ok');
      loadSets();
  loadChat();
    }).catch(function (err) { setMsg('setMsg', 'Verwijderen lukte niet: ' + err.message, 'error'); });
  }

  $('setSave').addEventListener('click', function () {
    var name = $('setNewName').value.trim();
    if (!name) { setMsg('setMsg', 'Geef de set een naam.', 'error'); return; }
    api('GET', '/api/sets').then(function (list) {
      var id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      var exists = (list || []).some(function (s) { return s.id === id; });
      if (exists && !window.confirm('Er is al een set ' + name + '. Overschrijven met de huidige route, refill, monsterlijst en healing?')) return null;
      return api('POST', '/api/sets', { name: name }).then(function (r) {
        $('setNewName').value = '';
        setMsg('setMsg', 'Set ' + name + ' opgeslagen (' + r.routes.join(', ') + ')', 'ok');
        loadSets();
      });
    }).catch(function (err) { setMsg('setMsg', 'Opslaan lukte niet: ' + err.message, 'error'); });
  });

  // ---------- Healing ----------

  var HEAL_TYPES = [
    { v: 'hp', t: 'HP lager dan' },
    { v: 'mana', t: 'Mana lager dan (potion)' },
    { v: 'manaSpell', t: 'Mana hoger dan (spell)' },
    { v: 'attackSpell', t: 'Aanvalsspell (bijv. exori)' },
    { v: 'haste', t: 'Haste (bijv. utani hur), altijd aan' },
    { v: 'targetRune', t: 'Rune op je doel (bijv. HMM)' },
    { v: 'paralyze', t: 'Bij paralyze (verlamd)' }
  ];

  // Bekende items, voor de uitleg in gewone woorden.
  var ITEM_NAMES = { 3446: 'bolts', 3450: 'power bolts', 3447: 'arrows', 3198: 'HMM' };
  function itemName(id) { return ITEM_NAMES[id] || ('item ' + id); }

  function itemWords(c) {
    if (!c || !(Number(c.id) > 0)) return '';
    var n = itemName(Number(c.id));
    if (typeof c.above === 'number') return c.above === 0 ? 'alleen als je ' + n + ' hebt' : 'als je meer dan ' + c.above + ' ' + n + ' hebt';
    if (typeof c.atMost === 'number') {
      return 'tot je ' + c.atMost + ' ' + n + ' hebt' + (typeof c.resumeBelow === 'number' ? (c.resumeBelow <= 1 ? '. Daarna pas weer als ze op zijn' : '. Daarna pas weer als je minder dan ' + c.resumeBelow + ' hebt') : '');
    }
    return '';
  }

  // Eén zin per regel: wat doet de bot en wanneer.
  function ruleWords(rule) {
    var k = 'F' + toInt(rule.hotkey, 1);
    var conds = [].concat(rule.item ? [itemWords(rule.item)] : [])
      .concat(Array.isArray(rule.items) ? rule.items.map(itemWords) : [])
      .filter(function (x) { return x; });
    var extra = conds.length ? ' (' + conds.join(', ') + ')' : '';
    if (rule.type === 'hp') return k + ' als je HP onder ' + rule.belowPct + '% komt.';
    if (rule.type === 'mana') return k + ' als je mana onder ' + (rule.belowMana != null ? rule.belowMana + ' punten' : rule.belowPct + '%') + ' komt.';
    if (rule.type === 'manaSpell') {
      return k + ' als je mana boven ' + rule.abovePct + '% is' + extra +
        (Number(rule.quiet) > 0 ? '. Alleen als er geen monster naast je staat' : '') + '.';
    }
    if (rule.type === 'targetRune') {
      var parts = [];
      if (Array.isArray(rule.names) && rule.names.length) parts.push(rule.names.join(', ') + ': de hele tijd');
      if (Number(rule.finishBelowHp) > 0) parts.push('Elk monster: bij de laatste ' + rule.finishBelowHp + ' HP');
      if (Number(rule.finishBelowPct) > 0) parts.push('Elk monster: onder ' + rule.finishBelowPct + '% HP');
      return k + ' op je doel. ' + (parts.length ? parts.join('. ') : 'Nog geen monsters ingesteld') + '.' +
        (conds.length ? ' Alleen ' + conds.join(', ').replace(/^alleen /, '') + '.' : '');
    }
    if (rule.type === 'paralyze') return k + ' zodra je verlamd bent (paralyze).';
    if (rule.type === 'attackSpell') return k + ' als er genoeg monsters naast je staan.';
    if (rule.type === 'haste') return k + ' steeds opnieuw, zodat haste aan blijft.';
    return k;
  }

  // Bij een aanvalsspell is de drempel: bij 1 monster alleen als mana hoger is dan dit %.
  function threshold(rule) {
    if (rule.type === 'attackSpell') return rule.singleAbovePct;
    return rule.type === 'manaSpell' ? rule.abovePct : rule.belowPct;
  }

  function setThreshold(rule, v) {
    if (rule.type === 'attackSpell') rule.singleAbovePct = v;
    else if (rule.type === 'manaSpell') rule.abovePct = v;
    else rule.belowPct = v;
  }

  function numCell(label, rule, key, def) {
    return cell(label, el('input', {
      type: 'number', min: 0, step: 1, value: rule[key] != null ? rule[key] : def, 'aria-label': label,
      oninput: function (e) { rule[key] = toInt(e.target.value, def); markDirty('healingMsg'); }
    }));
  }

  function hotkeySelect(rule) {
    var s = el('select', {
      'aria-label': 'Hotkey',
      onchange: function (e) { rule.hotkey = toInt(e.target.value, 1); markDirty('healingMsg'); }
    });
    for (var n = 1; n <= 12; n++) s.appendChild(el('option', { value: String(n), text: 'F' + n }));
    s.value = String(toInt(rule.hotkey, 1));
    return s;
  }

  function renderHealing() {
    var h = S.healing;
    var list = $('healList');
    list.textContent = '';
    h.rules.forEach(function (rule, i) {
      var typeSel = el('select', {
        'aria-label': 'Soort regel',
        onchange: function (e) {
          var old = threshold(rule);
          if (old == null) old = 50;
          rule.type = e.target.value;
          delete rule.belowPct;
          delete rule.abovePct;
          delete rule.singleAbovePct;
          // Exori neemt geen drempel over: alleen bij genoeg monsters.
          if (rule.type !== 'attackSpell') setThreshold(rule, old);
          if (rule.type === 'haste') {
            delete rule.belowPct;
            if (rule.manaCost == null) rule.manaCost = 60;
            if (rule.durationMs == null) rule.durationMs = 30000;
            if (rule.minManaPct == null) rule.minManaPct = 95;
          }
          if (rule.type === 'attackSpell') {
            if (rule.manaCost == null) rule.manaCost = 150;
            if (rule.manaReserve == null) rule.manaReserve = 100;
            if (rule.minAdjacent == null) rule.minAdjacent = 3;
          }
          markDirty('healingMsg');
          renderHealing();
        }
      }, HEAL_TYPES.map(function (o) { return el('option', { value: o.v, text: o.t }); }));
      typeSel.value = rule.type || 'hp';

      var isAttack = rule.type === 'attackSpell';
      var isHaste = rule.type === 'haste';
      var isRune = rule.type === 'targetRune';
      var isPara = rule.type === 'paralyze';
      // Mana-potion op een vast aantal mana (bijv. 150 voor exori) in plaats van %.
      var isManaPts = rule.type === 'mana' && rule.belowMana != null;
      list.appendChild(el('div', { class: 'heal-row' }, [
        cell('Soort', typeSel, 'heal-type'),
        isRune ? numCell('Laatste HP (0 = uit)', rule, 'finishBelowHp', 0) :
        isPara ? cell('Drempel', el('span', { class: 'muted small', text: 'geen' })) :
        isHaste ? numCell('Duur (ms)', rule, 'durationMs', 30000) : isManaPts ? numCell('Mana lager dan (punten)', rule, 'belowMana', 150) : cell(isAttack ? 'Minder monsters: mana boven % (leeg = uit)' : 'Drempel %', el('input', {
          type: 'number', min: 0, max: 100, step: 1, 'aria-label': 'Drempel in procent',
          value: threshold(rule) != null ? threshold(rule) : (isAttack ? '' : 50),
          placeholder: isAttack ? 'uit' : '',
          oninput: function (e) {
            if (isAttack && e.target.value === '') delete rule.singleAbovePct;
            else setThreshold(rule, toInt(e.target.value, 0));
            markDirty('healingMsg');
          }
        })),
        cell('Hotkey', hotkeySelect(rule)),
        cell('Wachttijd (ms)', el('input', {
          type: 'number', min: 0, step: 100, value: rule.cooldownMs != null ? rule.cooldownMs : 1000, 'aria-label': 'Wachttijd in milliseconden',
          oninput: function (e) { rule.cooldownMs = toInt(e.target.value, 1000); markDirty('healingMsg'); }
        })),
      ].concat(isHaste ? [
        numCell('Mana-kosten', rule, 'manaCost', 60),
        numCell('Alleen bij mana boven %', rule, 'minManaPct', 95)
      ] : []).concat(isAttack ? [
        numCell('Mana-kosten', rule, 'manaCost', 150),
        numCell('Mana achterhouden', rule, 'manaReserve', 100),
        numCell('Altijd bij zoveel monsters naast je', rule, 'minAdjacent', 3)
      ] : []).concat(isRune ? [
        cell('Altijd op deze monsters (komma ertussen)', el('input', {
          type: 'text', value: (rule.names || []).join(', '), 'aria-label': 'Monsters voor de rune',
          oninput: function (e) {
            rule.names = e.target.value.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
            markDirty('healingMsg');
            var p = e.target.closest('.heal-row');
            if (p && p.nextSibling && p.nextSibling.classList) p.nextSibling.textContent = ruleWords(rule);
          }
        }), 'heal-names')
      ] : []).concat([
        el('button', {
          class: 'btn btn-danger-soft btn-icon heal-remove', type: 'button', text: 'Verwijderen',
          onclick: function () { h.rules.splice(i, 1); markDirty('healingMsg'); renderHealing(); }
        })
      ])));
      list.appendChild(el('p', { class: 'heal-summary', text: ruleWords(rule) }));
    });
    $('healEmpty').hidden = h.rules.length > 0;
    $('hSkipPz').checked = h.skipInPz !== false;
  }

  // Uitleg per regel meteen bijwerken als je iets aanpast.
  function refreshHealSummaries() {
    var lines = $('healList').querySelectorAll('.heal-summary');
    (S.healing && S.healing.rules || []).forEach(function (rule, i) { if (lines[i]) lines[i].textContent = ruleWords(rule); });
  }
  $('healList').addEventListener('input', refreshHealSummaries);
  $('healList').addEventListener('change', refreshHealSummaries);

  $('healAdd').addEventListener('click', function () {
    if (!S.healing) return;
    S.healing.rules.push({ type: 'hp', belowPct: 50, hotkey: 1, cooldownMs: 1000 });
    markDirty('healingMsg');
    renderHealing();
  });
  $('hSkipPz').addEventListener('change', function (e) { S.healing.skipInPz = e.target.checked; markDirty('healingMsg'); });

  $('healingSave').addEventListener('click', function () {
    if (!S.healing) return;
    var h = clone(S.healing);
    saveConfigPart('healingMsg', 'healingSave', function (cfg) { cfg.healing = h; });
  });

  // ---------- Veiligheid en meldingen ----------

  function renderSafety() {
    var s = S.safety.safety;
    var n = S.safety.notify;
    $('sOnPlayer').value = s.onPlayer || 'alert';
    $('sIgnore').value = (s.playerIgnore || []).join('\n');
    $('sLowHp').value = s.lowHpAlertPct != null ? s.lowHpAlertPct : 30;
    $('sNtfy').value = n.ntfyTopic || '';
    $('sDesktop').checked = n.desktop !== false;
    $('sAutoLogin').checked = !!(S.config && S.config.autoLogin && S.config.autoLogin.enabled);
    $('sChatPause').checked = !!(S.config && S.config.chat && S.config.chat.pause);
    renderAiReplyToggle();
  }

  function aiReplyEnabled() {
    return !!(S.config && S.config.chat && S.config.chat.aiReply && S.config.chat.aiReply.enabled);
  }

  function renderAiReplyToggle() {
    var on = aiReplyEnabled();
    var main = $('sAiReply');
    var safety = $('sAiReplySafety');
    if (main) main.checked = on;
    if (safety) safety.checked = on;
    var label = $('aiReplyState');
    if (label) {
      label.textContent = on ? ' (aan)' : ' (uit)';
      label.style.color = on ? '#2a9d4a' : '';
    }
  }

  function setAiReplyEnabled(on, msgId) {
    return saveConfigPart(msgId || 'chatMsg', msgId === 'safetyMsg' ? 'safetySave' : 'chatSend', function (cfg) {
      cfg.chat = Object.assign({}, cfg.chat || {});
      cfg.chat.aiReply = Object.assign({}, cfg.chat.aiReply || {}, { enabled: !!on });
    }).then(function (ok) {
      if (ok) {
        if (!S.config.chat) S.config.chat = {};
        if (!S.config.chat.aiReply) S.config.chat.aiReply = {};
        S.config.chat.aiReply.enabled = !!on;
        renderAiReplyToggle();
      }
      return ok;
    });
  }

  // Pauzeren bij een privébericht aan of uit: direct opslaan.
  $('sChatPause').addEventListener('change', function (e) {
    var on = e.target.checked;
    saveConfigPart('safetyMsg', 'safetySave', function (cfg) {
      cfg.chat = Object.assign({}, cfg.chat || {}, { pause: on });
    });
  });

  // AI auto-reply: toggle bij berichten én bij veiligheid (blijven synchroon).
  function onAiReplyToggle(e) {
    var on = e.target.checked;
    var msgId = e.target.id === 'sAiReplySafety' ? 'safetyMsg' : 'chatMsg';
    setAiReplyEnabled(on, msgId).catch(function () {
      e.target.checked = !on;
      renderAiReplyToggle();
    });
  }
  if ($('sAiReply')) $('sAiReply').addEventListener('change', onAiReplyToggle);
  if ($('sAiReplySafety')) $('sAiReplySafety').addEventListener('change', onAiReplyToggle);

  // Automatisch inloggen aan of uit: direct opslaan.
  $('sAutoLogin').addEventListener('change', function (e) {
    var on = e.target.checked;
    saveConfigPart('safetyMsg', 'safetySave', function (cfg) {
      cfg.autoLogin = Object.assign({ account: 'wess', character: 'Wess' }, cfg.autoLogin || {}, { enabled: on });
    });
  });

  $('sOnPlayer').addEventListener('change', function (e) { S.safety.safety.onPlayer = e.target.value; markDirty('safetyMsg'); });
  $('sIgnore').addEventListener('input', function (e) {
    S.safety.safety.playerIgnore = e.target.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    markDirty('safetyMsg');
  });
  $('sLowHp').addEventListener('input', function (e) { S.safety.safety.lowHpAlertPct = toInt(e.target.value, 30); markDirty('safetyMsg'); });
  $('sNtfy').addEventListener('input', function (e) { S.safety.notify.ntfyTopic = e.target.value.trim(); markDirty('safetyMsg'); });
  $('sDesktop').addEventListener('change', function (e) { S.safety.notify.desktop = e.target.checked; markDirty('safetyMsg'); });

  $('safetySave').addEventListener('click', function () {
    if (!S.safety) return;
    var part = clone(S.safety);
    saveConfigPart('safetyMsg', 'safetySave', function (cfg) {
      cfg.safety = Object.assign({}, cfg.safety || {}, part.safety);
      cfg.notify = Object.assign({}, cfg.notify || {}, part.notify);
    });
  });

  // ---------- Drukte ----------

  function readCrowdForm() {
    var num = function (id, def) { var v = parseFloat(String($(id).value).replace(',', '.')); return isFinite(v) ? v : def; };
    return {
      enabled: $('crowdEnabled').checked,
      windowMin: Math.max(2, Math.round(num('crowdWindow', 10))),
      factor: Math.max(1.1, num('crowdFactor', 1.5)),
      minDiffPts: Math.max(0, Math.round(num('crowdDiff', 15))),
      cooldownMin: Math.max(0, Math.round(num('crowdCooldown', 10)))
    };
  }
  ['crowdWindow', 'crowdFactor', 'crowdDiff', 'crowdCooldown'].forEach(function (id) {
    $(id).addEventListener('input', function () { markDirty('crowdMsg'); });
  });
  // Aan of uit: direct opslaan.
  $('crowdEnabled').addEventListener('change', function () {
    var part = readCrowdForm();
    saveConfigPart('crowdMsg', 'crowdSave', function (cfg) { cfg.crowd = Object.assign({}, cfg.crowd || {}, { enabled: part.enabled }); });
  });
  $('crowdSave').addEventListener('click', function () {
    var part = readCrowdForm();
    saveConfigPart('crowdMsg', 'crowdSave', function (cfg) { cfg.crowd = Object.assign({}, cfg.crowd || {}, part); }).then(function (ok) {
      if (ok) renderCrowdSettings();
    });
  });

  // ---------- Route ----------

  var routeDirty = false;

  function setRouteDirty(v) {
    routeDirty = v;
    if (v) markDirty('routeMsg');
  }

  function activeRouteName() {
    return (S.config && S.config.routeName) || (S.status && S.status.routeName) || '';
  }

  function normalizeRouteList(data) {
    var arr = Array.isArray(data) ? data : (data && (data.routes || data.names)) || [];
    return arr.map(function (r) { return typeof r === 'string' ? r : (r && r.name) || ''; }).filter(Boolean);
  }

  function loadRouteList(selectName) {
    return api('GET', '/api/routes').then(function (data) {
      S.routeNames = normalizeRouteList(data);
      var pick = selectName || (S.route && S.route.name) || activeRouteName() || S.routeNames[0] || '';
      if (pick && S.routeNames.indexOf(pick) === -1) pick = S.routeNames[0] || '';
      renderRouteSelect(pick);
      if (pick) return loadRoute(pick);
      S.route = null;
      renderRoute();
    }).catch(function (err) {
      showGlobalError('Routes laden lukte niet: ' + err.message);
    });
  }

  function renderRouteSelect(selected) {
    var sel = $('routeSelect');
    sel.textContent = '';
    var names = S.routeNames.slice();
    if (S.routeIsNew && S.route && names.indexOf(S.route.name) === -1) names.push(S.route.name);
    if (!names.length) sel.appendChild(el('option', { value: '', text: 'Nog geen routes' }));
    names.forEach(function (n) {
      var label = n + (n === activeRouteName() ? ' (actief)' : '') + (S.routeIsNew && S.route && n === S.route.name ? ' (nieuw)' : '');
      sel.appendChild(el('option', { value: n, text: label }));
    });
    sel.value = selected || '';
  }

  function loadRoute(name) {
    return api('GET', '/api/routes/' + encodeURIComponent(name)).then(function (r) {
      r = r || {};
      S.route = { name: r.name || name, waypoints: Array.isArray(r.waypoints) ? r.waypoints : [] };
      Object.keys(r).forEach(function (k) { if (!(k in S.route)) S.route[k] = r[k]; });
      S.routeIsNew = false;
      routeDirty = false;
      setMsg('routeMsg', '', '');
      renderRoute();
    }).catch(function (err) {
      setMsg('routeMsg', 'Route laden lukte niet: ' + err.message, 'error');
    });
  }

  function confirmLoseRoute() {
    return !routeDirty || window.confirm('Je hebt wijzigingen in de route die nog niet zijn opgeslagen. Wil je die weggooien?');
  }

  $('routeSelect').addEventListener('change', function (e) {
    var name = e.target.value;
    if (!confirmLoseRoute()) {
      e.target.value = S.route ? S.route.name : '';
      return;
    }
    if (S.routeIsNew) { S.routeIsNew = false; renderRouteSelect(name); }
    if (name) loadRoute(name);
  });

  $('routeNew').addEventListener('click', function () {
    var input = $('routeNewName');
    var name = input.value.trim();
    if (!ROUTE_NAME_RE.test(name)) {
      setMsg('routeMsg', 'Gebruik alleen kleine letters, cijfers, - en _.', 'error');
      return;
    }
    if (S.routeNames.indexOf(name) !== -1) {
      setMsg('routeMsg', 'Er is al een route met deze naam.', 'error');
      return;
    }
    if (!confirmLoseRoute()) return;
    S.route = { name: name, waypoints: [] };
    S.routeIsNew = true;
    input.value = '';
    renderRouteSelect(name);
    renderRoute();
    setRouteDirty(true);
    setMsg('routeMsg', 'Nieuwe route. Voeg waypoints toe en klik op Opslaan.', 'dirty');
  });

  $('routeDelete').addEventListener('click', function () {
    if (!S.route) return;
    var name = S.route.name;
    if (S.routeIsNew) {
      S.route = null;
      S.routeIsNew = false;
      routeDirty = false;
      loadRouteList();
      return;
    }
    var extra = name === activeRouteName() ? ' Dit is de actieve route.' : '';
    if (!window.confirm('Route ' + name + ' echt verwijderen?' + extra)) return;
    api('DELETE', '/api/routes/' + encodeURIComponent(name)).then(function () {
      S.route = null;
      routeDirty = false;
      return loadRouteList();
    }).then(function () {
      setMsg('routeMsg', 'Route ' + name + ' is verwijderd.', 'ok');
    }).catch(function (err) {
      setMsg('routeMsg', 'Verwijderen lukte niet: ' + err.message, 'error');
    });
  });

  $('routeUse').addEventListener('click', function () {
    if (!S.route) return;
    if (S.routeIsNew || routeDirty) {
      setMsg('routeMsg', 'Sla de route eerst op.', 'error');
      return;
    }
    var name = S.route.name;
    saveConfigPart('routeMsg', 'routeUse', function (cfg) { cfg.routeName = name; }).then(function (ok) {
      if (ok) {
        setMsg('routeMsg', 'Opgeslagen. ' + name + ' is nu de actieve route.', 'ok');
        renderRouteSelect(name);
        renderRoute();
      }
    });
  });

  $('routeSave').addEventListener('click', function () {
    // Tijdens een opname niet opslaan: dan raken opgenomen waypoints kwijt.
    if (S.status && S.status.recording) {
      setMsg('routeMsg', 'Er loopt een opname. Stop eerst de opname en sla daarna op.', 'error');
      return;
    }
    if (!S.route) { setMsg('routeMsg', 'Kies of maak eerst een route.', 'error'); return; }
    var bad = S.route.waypoints.some(function (w) {
      return !isFinite(w.x) || !isFinite(w.y) || !isFinite(w.z) || w.x === null || w.y === null || w.z === null;
    });
    if (bad) { setMsg('routeMsg', 'Elk waypoint heeft een x, y en z nodig.', 'error'); return; }
    var body = clone(S.route);
    body.waypoints.forEach(function (w) {
      if (!w.label) delete w.label;
    });
    var btn = $('routeSave');
    btn.disabled = true;
    setMsg('routeMsg', 'Bezig met opslaan...', '');
    api('PUT', '/api/routes/' + encodeURIComponent(body.name), body).then(function () {
      var wasNew = S.routeIsNew;
      S.routeIsNew = false;
      routeDirty = false;
      if (wasNew && S.routeNames.indexOf(body.name) === -1) S.routeNames.push(body.name);
      renderRouteSelect(body.name);
      setMsg('routeMsg', 'Opgeslagen', 'ok');
    }).catch(function (err) {
      setMsg('routeMsg', 'Opslaan lukte niet: ' + err.message, 'error');
    }).then(function () { btn.disabled = false; });
  });

  function updateWpHereInfo() {
    var p = S.status && S.status.player;
    $('wpHere').disabled = !p || !S.route;
    $('wpHereInfo').textContent = p
      ? 'Jouw positie nu: ' + p.x + ', ' + p.y + ', ' + p.z
      : 'Positie onbekend. Log eerst in het spel in.';
  }

  $('wpHere').addEventListener('click', function () {
    var p = S.status && S.status.player;
    if (!S.route) { setMsg('routeMsg', 'Kies of maak eerst een route.', 'error'); return; }
    if (!p) { setMsg('routeMsg', 'Er is nog geen positie bekend.', 'error'); return; }
    var wp = { type: $('wpType').value, x: p.x, y: p.y, z: p.z, label: '' };
    S.route.waypoints.push(wp);
    setRouteDirty(true);
    renderRoute();
    var list = $('wpList');
    list.scrollTop = list.scrollHeight;
  });

  function isActiveRouteInEditor() {
    return S.route && !S.routeIsNew && S.status && S.status.routeName === S.route.name;
  }

  function updateRouteHighlight() {
    var idx = isActiveRouteInEditor() ? S.status.waypointIndex : -1;
    if (idx === S.lastIndexShown) return;
    S.lastIndexShown = idx;
    var rows = $('wpList').children;
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-current', i === idx);
    }
  }

  function moveWp(i, dir) {
    var w = S.route.waypoints;
    var j = i + dir;
    if (j < 0 || j >= w.length) return;
    var tmp = w[i]; w[i] = w[j]; w[j] = tmp;
    setRouteDirty(true);
    renderRoute();
  }

  function numInput(w, key, label, cls) {
    return cell(label, el('input', {
      type: 'number', step: 1, value: w[key] != null ? w[key] : '', 'aria-label': label,
      oninput: function (e) {
        var v = parseInt(e.target.value, 10);
        w[key] = isNaN(v) ? null : v;
        setRouteDirty(true);
      }
    }), cls);
  }

  function renderRoute() {
    var list = $('wpList');
    list.textContent = '';
    S.lastIndexShown = null;
    var r = S.route;
    var active = activeRouteName();
    $('routeActive').textContent = r
      ? (r.name === active ? 'Dit is de actieve route.' : 'Actieve route: ' + (active || 'nog niet gekozen') + '. Klik op "Gebruik deze route" om te wisselen.')
      : 'Kies een route of maak een nieuwe.';
    $('routeUse').disabled = !r || r.name === active;
    $('routeDelete').disabled = !r;
    $('routeSave').disabled = !r;

    var wps = r ? r.waypoints : [];
    $('wpEmpty').hidden = !r || wps.length > 0;
    wps.forEach(function (w, i) {
      var typeSel = el('select', {
        'aria-label': 'Soort waypoint',
        onchange: function (e) {
          var t = e.target.value;
          // Een opgenomen trap (floor) omzetten naar ladder (use) of touw (rope):
          // de ladder of het gat ligt één tegel verder, richting waar je uitkwam.
          if (w.type === 'floor' && (t === 'use' || t === 'rope') && w.toX != null && w.toY != null) {
            w.x += Math.sign(w.toX - w.x);
            w.y += Math.sign(w.toY - w.y);
            w.type = t;
            setRouteDirty(true);
            renderRoute();
            return;
          }
          w.type = t;
          setRouteDirty(true);
        }
      }, ['walk', 'stand', 'rope', 'use', 'floor'].map(function (t) { return el('option', { value: t, text: t }); }));
      typeSel.value = w.type || 'walk';

      list.appendChild(el('div', { class: 'wp-row' }, [
        el('span', { class: 'wp-index', text: String(i + 1) }),
        cell('Soort', typeSel, 'wp-type'),
        numInput(w, 'x', 'x', 'wp-x'),
        numInput(w, 'y', 'y'),
        numInput(w, 'z', 'z'),
        cell('Label', el('input', {
          type: 'text', value: w.label || '', placeholder: 'label', 'aria-label': 'Label',
          oninput: function (e) { w.label = e.target.value; setRouteDirty(true); }
        }), 'wp-label'),
        el('div', { class: 'wp-actions' }, [
          el('button', { class: 'btn btn-icon', type: 'button', text: '↑', title: 'Omhoog', 'aria-label': 'Omhoog', disabled: i === 0, onclick: function () { moveWp(i, -1); } }),
          el('button', { class: 'btn btn-icon', type: 'button', text: '↓', title: 'Omlaag', 'aria-label': 'Omlaag', disabled: i === wps.length - 1, onclick: function () { moveWp(i, 1); } }),
          el('button', { class: 'btn btn-small', type: 'button', text: 'Ga naar deze', onclick: function () { goToWp(i); } }),
          el('button', {
            class: 'btn btn-danger-soft btn-icon', type: 'button', text: '×', title: 'Verwijderen', 'aria-label': 'Verwijderen',
            onclick: function () { wps.splice(i, 1); setRouteDirty(true); renderRoute(); }
          })
        ])
      ]));
    });
    updateRouteHighlight();
    updateWpHereInfo();
  }

  function goToWp(i) {
    if (!S.route || S.routeIsNew || S.route.name !== activeRouteName()) {
      setMsg('routeMsg', 'Dit werkt alleen bij de actieve route.', 'error');
      return;
    }
    if (routeDirty) {
      setMsg('routeMsg', 'Sla de route eerst op. Anders klopt het nummer niet.', 'error');
      return;
    }
    command('setIndex', { i: i }).then(function () {
      setMsg('routeMsg', 'De bot gaat nu naar waypoint ' + (i + 1) + '.', 'ok');
    }).catch(function (err) {
      setMsg('routeMsg', 'Lukte niet: ' + err.message, 'error');
    });
  }

  // Waarschuwen bij weggaan met wijzigingen die nog niet zijn opgeslagen.
  window.addEventListener('beforeunload', function (e) {
    var dirty = routeDirty || ['targetingMsg', 'healingMsg', 'safetyMsg'].some(function (id) {
      return $(id).classList.contains('is-dirty');
    });
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Starten ----------

  renderLog();
  renderStatus();
  renderRoute();
  updateSoundHint();
  api('GET', '/api/status').then(function (st) { if (st && !S.status) onStatus(st); }).catch(function () { /* SSE stuurt de status ook */ });
  loadConfig().then(function () { return loadRouteList(); });
  loadSets();
  connect();
})();
