'use strict';

// Brug tussen de bot in je eigen Chrome (via de extensie) en deze server.
// De pagina haalt opdrachten op met lang wachten (long poll) en stuurt
// events en antwoorden terug. Vorm:
// { start(), command(name, args), pushConfig(cfg), pushRoute(route), close(), handle() }.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORIGIN = 'https://minibia.com';
const POLL_WAIT_MS = 20000;   // zo lang houdt de server een poll open
const CMD_TIMEOUT_MS = 10000; // zo lang wachten op antwoord van de pagina
const LOST_AFTER_MS = 45000;  // geen contact meer: verbinding weg
const MAX_BODY = 1024 * 1024;

// Vaste sleutel, zodat alleen onze extensie met de brug kan praten.
function loadToken(root) {
  const file = path.join(root, 'data', 'bridge-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  } catch (e) { /* nog geen sleutel */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

// Quiz-AI: meerkeuzevragen van de anti-bot-controle beantwoorden via Claude.
// Geen API-key = geen AI (de bot valt terug op uitloggen, zoals voorheen).
const QUIZ_SYSTEM = [
  'Je lost korte quizvragen op uit een online spel (anti-bot-verificatie).',
  'Soms is de vraag een rekensom: reken die zelf nauwkeurig uit.',
  'Antwoord ALLEEN met één cijfer: het indexnummer van het juiste antwoord.',
  'Als je het écht niet weet, kies dan de meest waarschijnlijke optie; laat nooit niets onbeantwoord.',
  'Geen toelichting, geen leestekens, geen tekst eromheen.'
].join(' ');

const QUIZ_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'];

async function quizCallClaude(model, question, options, key) {
  const list = options.map((o, i) => i + ': ' + o).join('\n');
  const userText = 'Vraag: ' + question + '\n\nOpties:\n' + list;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 8,
      system: QUIZ_SYSTEM,
      messages: [{ role: 'user', content: userText }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Anthropic HTTP ' + res.status + ': ' + body.slice(0, 120));
  }
  const data = await res.json();
  const text = (data.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
  return text;
}

async function callQuizClaude(question, options) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('geen ANTHROPIC_API_KEY');
  let lastErr = null;
  for (const model of QUIZ_MODELS) {
    let text = null;
    try {
      text = await quizCallClaude(model, question, options, key);
    } catch (e) {
      // Onbekend/geweigerd model: probeer het volgende; anders ook maar.
      lastErr = e;
      if (e.message && e.message.includes('HTTP 40')) continue;
      throw e;
    }
    // Eerst een alleenstaand cijfer; daarna elk cijfer binnen de optierange.
    const solo = /^\s*(\d+)\s*$/.exec(text);
    if (solo) {
      const idx = Number(solo[1]);
      if (idx >= 0 && idx < options.length) return idx;
    }
    const any = /(\d+)/.exec(text || '');
    if (any) {
      const idx = Number(any[1]);
      if (idx >= 0 && idx < options.length) return idx;
    }
    return -1; // antwoord onbruikbaar; nog een model helpt zelden
  }
  if (lastErr) throw lastErr;
  return -1;
}

function createBridge({ root, onEvent, log }) {
  const token = loadToken(root);
  let queue = [];            // opdrachten die nog naar de pagina moeten
  const waiting = new Map(); // id -> { resolve, timer }
  let pollers = [];          // open polls die op een opdracht wachten
  let nextId = 1;
  let lastSeen = 0;
  let connected = false;
  let latestConfig = null;
  let latestRoute = null;
  let latestRoutes = null;
  let latestWanted = null; // moet de bot spelen (Start) of niet (Stop)
  let lostTimer = null;
  let activeTab = null;      // alleen het nieuwste tabblad is de bot
  const lastSeq = new Map(); // tab -> hoogste ontvangen volgnummer
  let lastStatus = null;

  function setConnected(v) {
    if (v === connected) return;
    connected = v;
    log(v ? 'De bot in je Chrome is verbonden.' : 'Geen contact meer met de bot in je Chrome.');
  }

  function flushPollers() {
    if (!queue.length) return;
    const items = queue;
    queue = [];
    const p = pollers.shift();
    if (p) {
      clearTimeout(p.timer);
      sendJson(p.res, 200, { commands: items });
    } else {
      queue = items.concat(queue);
    }
  }

  function enqueue(name, args, wantAnswer) {
    // Config en route: alleen de nieuwste telt.
    if (name === '__setConfig' || name === '__setRoute' || name === '__setRoutes' || name === '__setWanted') {
      queue = queue.filter((c) => c.name !== name);
    }
    const id = nextId++;
    queue.push({ id, name, args });
    flushPollers();
    if (!wantAnswer) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        queue = queue.filter((c) => c.id !== id);
        resolve({ ok: false, error: 'Geen antwoord van de bot in Chrome. Staat Minibia open en ben je ingelogd?' });
      }, CMD_TIMEOUT_MS);
      waiting.set(id, { resolve, timer });
    });
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WJ-Token, X-WJ-Tab');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
  }

  function sendJson(res, code, body) {
    if (res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('Te groot')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject(new Error('Geen geldige JSON')); }
      });
      req.on('error', reject);
    });
  }

  // Contact gehad. Was de verbinding weg (bijv. server herstart), dan
  // config en route opnieuw meegeven.
  function seen() {
    lastSeen = Date.now();
    if (!connected) {
      if (latestConfig) enqueue('__setConfig', latestConfig, false);
      if (latestRoute) enqueue('__setRoute', latestRoute, false);
      if (latestRoutes) enqueue('__setRoutes', latestRoutes, false);
      if (latestWanted !== null) enqueue('__setWanted', latestWanted, false);
    }
    setConnected(true);
    clearTimeout(lostTimer);
    lostTimer = setTimeout(lost, LOST_AFTER_MS);
  }

  // Lang niets gehoord: dashboard bijwerken en een melding sturen.
  function lost() {
    setConnected(false);
    const st = Object.assign({}, lastStatus || {}, { ready: false, time: Date.now() });
    try { onEvent('status', st); } catch (e) { /* niets */ }
    try {
      onEvent('alert', {
        reason: 'disconnect', action: 'pause', time: Date.now(),
        message: 'Geen contact meer met de bot in Chrome. Is het Minibia-tabblad dicht, of slaapt je Mac?'
      });
    } catch (e) { /* niets */ }
  }

  function tabOf(req) { return String(req.headers['x-wj-tab'] || ''); }
  const tabSeen = new Map(); // tab -> laatste contact
  const TAKEOVER_MS = 30000;
  // Het actieve tabblad mag praten. Is dat tabblad al 30 s stil (bijv. gesloten),
  // dan neemt het tabblad dat zich nu meldt het over.
  function isActive(req) {
    const tab = tabOf(req);
    if (tab) tabSeen.set(tab, Date.now());
    if (!activeTab || tab === activeTab) return true;
    if (Date.now() - (tabSeen.get(activeTab) || 0) > TAKEOVER_MS) {
      log('Het vorige Minibia-tabblad reageert niet meer. Een ander tabblad neemt het over.');
      activeTab = tab;
      if (latestConfig) enqueue('__setConfig', latestConfig, false);
      if (latestRoute) enqueue('__setRoute', latestRoute, false);
      if (latestRoutes) enqueue('__setRoutes', latestRoutes, false);
      if (latestWanted !== null) enqueue('__setWanted', latestWanted, false);
      return true;
    }
    return false;
  }

  // Afhandeling van /bridge/* (aangeroepen door server.js).
  async function handle(req, res, pathname) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.headers.origin && req.headers.origin !== ORIGIN) return sendJson(res, 403, { ok: false });
    if (req.headers['x-wj-token'] !== token) return sendJson(res, 403, { ok: false, error: 'Verkeerde sleutel' });

    // Pagina is (opnieuw) geladen: config en route meteen meegeven.
    if (pathname === '/bridge/hello' && req.method === 'POST') {
      // Het nieuwste tabblad wordt de bot. Oude polls sluiten.
      const tab = tabOf(req);
      if (tab) tabSeen.set(tab, Date.now());
      if (tab && tab !== activeTab) {
        if (activeTab) log('Een nieuw Minibia-tabblad bestuurt nu de bot.');
        activeTab = tab;
        for (const p of pollers) { clearTimeout(p.timer); sendJson(p.res, 409, { ok: false }); }
        pollers = [];
      }
      const wasConnected = connected;
      seen();
      if (!wasConnected) return sendJson(res, 200, { ok: true });
      if (latestConfig) enqueue('__setConfig', latestConfig, false);
      if (latestRoute) enqueue('__setRoute', latestRoute, false);
      if (latestRoutes) enqueue('__setRoutes', latestRoutes, false);
      if (latestWanted !== null) enqueue('__setWanted', latestWanted, false);
      return sendJson(res, 200, { ok: true });
    }

    if (!isActive(req)) return sendJson(res, 409, { ok: false, error: 'Ander tabblad is actief' });

    // Wachtwoord voor automatisch inloggen, uit .env (GAME_PASSWORD).
    // Alleen voor de extensie (sleutel + herkomst gecontroleerd hierboven) en
    // nooit via de proxy bereikbaar. Wordt nergens gelogd of bewaard.
    if (pathname === '/bridge/secret' && req.method === 'GET') {
      seen();
      return sendJson(res, 200, { password: process.env.GAME_PASSWORD || '' });
    }

    // AI-oplosser voor de quiz: de extensie stuurt vraag + opties, wij
    // vragen Claude en sturen het indexnummer van de gekozen optie terug.
    // Alleen bereikbaar met de bridge-sleutel (hierboven gecontroleerd).
    if (pathname === '/bridge/quiz' && req.method === 'POST') {
      seen();
      const body = await readBody(req);
      const question = String((body && body.question) || '').slice(0, 800);
      const options = Array.isArray(body && body.options) ? body.options.slice(0, 12).map((o) => String(o || '').slice(0, 160)) : [];
      if (!question || options.length < 2) return sendJson(res, 200, { choice: -1 });
      try {
        const choice = await callQuizClaude(question, options);
        return sendJson(res, 200, { choice: choice });
      } catch (e) {
        log('Quiz-AI mislukt: ' + (e && e.message ? e.message : e));
        return sendJson(res, 200, { choice: -1 });
      }
    }

    if (pathname === '/bridge/poll' && req.method === 'GET') {
      seen();
      if (queue.length) {
        const items = queue;
        queue = [];
        return sendJson(res, 200, { commands: items });
      }
      const p = { res, timer: null };
      p.timer = setTimeout(() => {
        pollers = pollers.filter((x) => x !== p);
        sendJson(res, 200, { commands: [] });
      }, POLL_WAIT_MS);
      req.on('close', () => {
        clearTimeout(p.timer);
        pollers = pollers.filter((x) => x !== p);
      });
      pollers.push(p);
      return undefined;
    }

    if (pathname === '/bridge/result' && req.method === 'POST') {
      seen();
      const body = await readBody(req);
      const w = waiting.get(body && body.id);
      if (w) {
        clearTimeout(w.timer);
        waiting.delete(body.id);
        w.resolve(body.result === undefined ? { ok: true } : body.result);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/bridge/events' && req.method === 'POST') {
      seen();
      const body = await readBody(req);
      const events = Array.isArray(body && body.events) ? body.events : [];
      const tab = tabOf(req);
      for (const e of events) {
        // Dubbel binnengekomen (na een mislukte verzending)? Overslaan.
        if (e && typeof e.seq === 'number') {
          if (e.seq <= (lastSeq.get(tab) || 0)) continue;
          lastSeq.set(tab, e.seq);
        }
        if (e && e.type === 'status') lastStatus = e.payload;
        if (e && typeof e.type === 'string') {
          try { onEvent(e.type, e.payload); } catch (err) { log('Fout bij event ' + e.type + ': ' + err.message); }
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false });
  }

  return {
    token,
    handle,
    isConnected: () => connected && Date.now() - lastSeen < LOST_AFTER_MS,
    async start() { /* niets te starten: de extensie meldt zich zelf */ },
    command(name, args) {
      if (!connected) return Promise.resolve({ ok: false, error: 'De bot in Chrome is niet verbonden. Open Minibia in je Chrome met de extensie aan.' });
      return enqueue(name, args, true);
    },
    pushConfig(cfg) {
      latestConfig = cfg;
      if (connected) enqueue('__setConfig', cfg, false);
      return Promise.resolve();
    },
    pushRoutes(map) {
      latestRoutes = map;
      if (connected) enqueue('__setRoutes', map, false);
      return Promise.resolve();
    },
    pushWanted(v) {
      latestWanted = !!v;
      if (connected) enqueue('__setWanted', latestWanted, false);
      return Promise.resolve();
    },
    pushRoute(route) {
      latestRoute = route;
      if (connected) enqueue('__setRoute', route, false);
      return Promise.resolve();
    },
    async close() {
      for (const p of pollers) { clearTimeout(p.timer); sendJson(p.res, 200, { commands: [] }); }
      pollers = [];
      clearTimeout(lostTimer);
    }
  };
}

module.exports = { createBridge, loadToken };
