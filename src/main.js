'use strict';
// Start van de bot: config laden, dashboard en brug starten en events koppelen.
// De bot zelf draait in je eigen Chrome via de extensie (map extension/).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const notifier = require('./notify');
const { createServer } = require('./server');
const { createBridge } = require('./bridge');
const { createFarm } = require('./farm');
const { createCrowd } = require('./crowd');
const { createAiReply } = require('./ai-reply');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');

let config = store.loadConfig();
let lastStatus = null;
let server = null;
let browser = null; // de brug naar de extensie (zelfde vorm als vroeger)
let shuttingDown = false;
const farm = createFarm({ root: path.join(__dirname, '..') });
// Drukte: route vanzelf omdraaien als er veel vaker een speler in beeld is dan normaal.
const crowd = createCrowd({
  root: ROOT,
  getConfig: () => config,
  listRoutes: () => store.listRoutes(),
  switchRoute,
  log: (msg) => log(msg)
});

// Actieve route wisselen vanuit de server (zelfde als "Gebruik deze route").
async function switchRoute(name) {
  if (!store.listRoutes().includes(name)) throw new Error('Route ' + name + ' bestaat niet.');
  config.routeName = name;
  store.saveConfig(config);
  await browser.pushConfig(config);
  await browser.pushRoute(loadActiveRoute());
  if (server) server.broadcast('routeSwitched', { name });
  log('Actieve route is nu: ' + name);
}
let aiReply = null; // wordt gezet in main() zodra de brug er is

// Moet de bot spelen? Dat onthoudt de server in data/wanted.json, zodat de bot
// na een herstart van Chrome of de VPS vanzelf weer start. Start of Doorgaan
// zet het aan, alleen Stop zet het uit.
const WANTED_FILE = path.join(ROOT, 'data', 'wanted.json');
let wanted = false;
let stopAt = 0; // moment van de laatste Stop: oude statusberichten daarna niet meetellen
try { wanted = !!JSON.parse(fs.readFileSync(WANTED_FILE, 'utf8')).running; } catch (e) { /* standaard uit */ }
function setWanted(v) {
  if (wanted === v) return;
  wanted = v;
  try { fs.writeFileSync(WANTED_FILE, JSON.stringify({ running: v, time: new Date().toISOString() }) + '\n'); } catch (e) { /* niets */ }
  // De pagina moet het ook weten: bij Stop logt hij niet meer vanzelf in.
  if (browser) browser.pushWanted(v);
}

// Staat de bot stil terwijl hij zou moeten spelen? Na 15 seconden zelf starten.
// Hooguit 3 keer per 10 minuten, zodat hij niet blijft proberen als er iets mis is.
let stoppedSince = 0;
let autoStarts = [];
function checkAutoStart(st) {
  if (!wanted || !st || !st.ready || !st.player || st.state !== 'stopped' || st.recording) { stoppedSince = 0; return; }
  const now = Date.now();
  if (!stoppedSince) { stoppedSince = now; return; }
  if (now - stoppedSince < 15000) return;
  autoStarts = autoStarts.filter((t) => now - t < 600000);
  if (autoStarts.length >= 3) return;
  autoStarts.push(now);
  stoppedSince = 0;
  log('De bot stond stil na een herstart. Ik start hem weer.');
  browser.command('start').catch(() => {});
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Logregel naar het bestand logs/bot-JJJJ-MM-DD.log. Fouten negeren.
function writeLogFile(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'bot-' + today() + '.log'), line + '\n', 'utf8');
  } catch (err) { /* niet erg */ }
}

// Logregel van de Node-kant: console, bestand en dashboard.
function log(msg) {
  const time = Date.now();
  const line = '[' + new Date(time).toLocaleTimeString('nl-NL') + '] ' + msg;
  console.log(line);
  writeLogFile(line);
  if (server) server.broadcast('log', { msg: '[node] ' + msg, time });
}

function emptyRoute(name) {
  return { name: name || '', waypoints: [] };
}

function loadActiveRoute() {
  const name = config && config.routeName;
  if (!name || !store.isValidName(name)) return emptyRoute(name);
  try {
    return store.loadRoute(name) || emptyRoute(name);
  } catch (err) {
    log('Route ' + name + ' is niet te lezen: ' + err.message);
    return emptyRoute(name);
  }
}

function fallbackStatus() {
  return {
    ready: false,
    state: 'stopped',
    pauseReason: null,
    mode: 'idle',
    player: null,
    target: null,
    waypointIndex: 0,
    waypointCount: 0,
    routeName: config.routeName || '',
    monstersNear: [],
    playersNear: [],
    stats: { kills: 0, startedAt: null, runtimeMs: 0, killsPerHour: 0 },
    time: Date.now()
  };
}

const ALERT_TITLES = {
  captcha: 'Quiz',
  death: 'Je karakter is dood',
  floor: 'Onverwacht andere verdieping',
  noway: 'There is no way',
  player: 'Speler in de buurt',
  lowHp: 'Lage HP',
  disconnect: 'Verbinding weg',
  stuck: 'Bot zit vast',
  pm: 'Privebericht in het spel',
  gm: 'Game master!'
};

function handleAlert(payload) {
  const p = payload || {};
  const line = 'MELDING (' + (p.reason || 'onbekend') + ', ' + (p.action || '-') + '): ' + (p.message || '');
  console.log(line);
  writeLogFile(line);
  server.broadcast('alert', p);
  // GM gezien of bericht van een GM: niet vanzelf weer starten of inloggen.
  if (p.reason === 'gm') { stopAt = Date.now(); setWanted(false); }
  const urgent = p.reason === 'captcha' || p.reason === 'death' || p.reason === 'pm' || p.reason === 'gm';
  notifier.notify({
    title: 'Minibia-bot: ' + (ALERT_TITLES[p.reason] || p.reason || 'melding'),
    message: p.message || 'Er is iets aan de hand. Kijk in het dashboard.',
    priority: urgent ? 'urgent' : 'high'
  });
}

// Routes voor na een death (tempel-depot, depot-hunt) naar de bot sturen.
function pushRestockRoutes() {
  const names = Object.values((config.restock && config.restock.routes) || {});
  const map = {};
  for (const n of names) {
    try { const r = store.isValidName(n) && store.loadRoute(n); if (r) map[n] = r; } catch (e) { /* ontbrekende route */ }
  }
  if (browser) browser.pushRoutes(map).catch(() => {});
}

// Opgenomen waypoint toevoegen aan de actieve route. Is er nog geen actieve
// route, dan maken we er een met de datum in de naam.
function addRecordedWaypoint(wp) {
  if (!wp || !isFinite(wp.x) || !isFinite(wp.y) || !isFinite(wp.z)) return;
  try {
    if (!config.routeName || !store.isValidName(config.routeName)) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      config.routeName = 'opname-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
      store.saveConfig(config);
      log('Nieuwe route aangemaakt voor de opname: ' + config.routeName);
    }
    const route = loadActiveRoute();
    route.name = config.routeName;
    route.waypoints.push(wp);
    store.saveRoute(route);
    if (browser) browser.pushRoute(route).catch(() => {});
    server.broadcast('routeUpdated', { name: route.name, count: route.waypoints.length, waypoint: wp });
  } catch (err) {
    log('Waypoint opslaan mislukt: ' + err.message);
  }
}

// Elke kill bewaren met route, waypoint en plek. Zo zien we over langere
// tijd bij welke waypoints de meeste kills vallen (hotspots).
function recordKill(payload) {
  try {
    const s = lastStatus || {};
    const p = s.player || {};
    const row = {
      time: (payload && payload.time) || Date.now(),
      name: payload && payload.name,
      route: s.routeName || config.routeName || '',
      wp: s.waypointIndex,
      x: p.x, y: p.y, z: p.z,
      hp: p.hpPct,
      players: (s.playersNear || []).length
    };
    fs.appendFileSync(path.join(ROOT, 'data', 'kills.jsonl'), JSON.stringify(row) + '\n');
  } catch (err) {
    log('Kill opslaan mislukt: ' + err.message);
  }
}

// Events uit de pagina.
function onEvent(type, payload) {
  switch (type) {
    case 'status':
      // Opbrengst bijwerken en meesturen (GP, XP en kills per uur).
      farm.onStatus(payload);
      if (payload && typeof payload === 'object') payload.farm = farm.summary();
      try { crowd.onStatus(payload); } catch (e) { /* drukte-meting mag nooit de status breken */ }
      if (payload && typeof payload === 'object') payload.crowd = crowd.summary();
      lastStatus = payload;
      if (payload && payload.state === 'running' && Date.now() - stopAt > 5000) setWanted(true);
      checkAutoStart(payload);
      server.broadcast('status', payload);
      break;
    case 'alert':
      handleAlert(payload);
      break;
    case 'log':
      if (payload && payload.msg) writeLogFile('[pagina ' + new Date().toTimeString().slice(0, 8) + '] ' + payload.msg);
      server.broadcast('log', payload);
      break;
    case 'kill':
      recordKill(payload);
      farm.onKill();
      server.broadcast('kill', payload);
      break;
    case 'chat':
      // Privéberichten bewaren (data/chat.jsonl) en in het dashboard tonen.
      // Optioneel: AI (Claude) formuleert na een korte delay een antwoord.
      if (payload && typeof payload === 'object') {
        try {
          const chatFile = path.join(ROOT, 'data', 'chat.jsonl');
          fs.appendFileSync(chatFile, JSON.stringify(payload) + '\n');
          // Klein houden: boven 500 KB alleen de laatste 500 berichten bewaren.
          if (fs.statSync(chatFile).size > 500000) {
            const keep = fs.readFileSync(chatFile, 'utf8').trim().split('\n').slice(-500).join('\n') + '\n';
            fs.writeFileSync(chatFile, keep);
          }
        } catch (e) { /* niets */ }
        writeLogFile('[chat] ' + (payload.kind === 'sent' ? 'Jij aan ' + payload.to : payload.from) + ': ' + payload.text);
        server.broadcast('chat', payload);
        if (aiReply) {
          try { aiReply.onChat(payload); } catch (e) { /* nooit de event-loop breken */ }
        }
      }
      break;
    case 'routeEnd':
      writeLogFile('Einde van de route bereikt.');
      server.broadcast('routeEnd', payload || {});
      break;
    case 'recordWaypoint':
      addRecordedWaypoint(payload && payload.waypoint);
      break;
    default:
      // Onbekende events gewoon doorgeven.
      server.broadcast(type, payload);
  }
}

async function main() {
  notifier.configure(config.notify);

  // De bot draait in je eigen Chrome (extensie) en praat via deze brug.
  browser = createBridge({ root: ROOT, onEvent, log });
  browser.pushWanted(wanted);

  // AI-antwoorden op (staff-)PM's via Claude.
  aiReply = createAiReply({
    root: ROOT,
    getConfig: () => config,
    command: (name, args) => browser.command(name, args),
    log: writeLogFile
  });
  if (config.chat && config.chat.aiReply && config.chat.aiReply.enabled) {
    log('AI-chatantwoorden staan aan (Claude).');
  }

  server = createServer({
    bridge: browser,
    root: ROOT,
    store,
    port: process.env.PORT || 3100,
    host: process.env.HOST || '127.0.0.1',
    password: process.env.DASHBOARD_PASSWORD || '',
    getStatus: () => lastStatus || fallbackStatus(),
    onCommand: (name, args, meta) => {
      if (meta && meta.viaServer) log('Opdracht "' + name + '" via de server (minibia-commando).');
      // Opbrengst opnieuw tellen: alleen op de server, niet naar de pagina.
      if (name === 'start' || name === 'resume') setWanted(true);
      if (name === 'stop') { stopAt = Date.now(); setWanted(false); }
      if (name === 'farmReset') { farm.reset(); log('Opbrengst opnieuw geteld vanaf nu.'); return { ok: true }; }
      // Opname altijd in een eigen, nieuwe route, zodat een bestaande route
      // niet wordt aangevuld.
      if (name === 'recordStart') {
        // Alleen opnemen als de bot echt stilstaat en het spel klaar is.
        if (!lastStatus || !lastStatus.ready) {
          return { ok: false, error: 'Het spel is nog niet klaar. Log eerst in.' };
        }
        if (lastStatus.state !== 'stopped') {
          return { ok: false, error: 'Stop eerst de bot voordat je gaat opnemen.' };
        }
        if (lastStatus.recording) {
          return { ok: false, error: 'Er loopt al een opname.' };
        }
        const oldRouteName = config.routeName;
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        let rn = args && typeof args.routeName === 'string' ? args.routeName.trim().toLowerCase() : '';
        if (!rn || !store.isValidName(rn)) {
          rn = 'opname-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
        }
        if (store.listRoutes().includes(rn)) {
          return { ok: false, error: 'Route ' + rn + ' bestaat al. Kies een andere naam.' };
        }
        store.saveRoute({ name: rn, waypoints: [] });
        config.routeName = rn;
        store.saveConfig(config);
        // Lukt het starten niet, dan alles terugzetten zoals het was.
        const undo = (error) => {
          config.routeName = oldRouteName;
          store.saveConfig(config);
          try { store.deleteRoute(rn); } catch (e) { /* niets */ }
          browser.pushConfig(config).then(() => browser.pushRoute(loadActiveRoute())).catch(() => {});
          return { ok: false, error: error || 'Opnemen lukt niet.' };
        };
        return browser.pushConfig(config)
          .then(() => browser.pushRoute({ name: rn, waypoints: [] }))
          .then(() => browser.command(name, args))
          .then((res) => (res && res.ok === false) ? undo(res.error) : Object.assign({ routeName: rn }, res || {}))
          .catch((err) => undo(err && err.message));
      }
      return browser.command(name, args);
    },
    onConfigSaved: async (cfg, before) => {
      config = cfg;
      pushRestockRoutes();
      notifier.configure(cfg.notify);
      await browser.pushConfig(cfg);
      if (!before || before.routeName !== cfg.routeName) {
        await browser.pushRoute(loadActiveRoute());
        log('Actieve route is nu: ' + (cfg.routeName || '(geen)'));
      }
    },
    onRouteSaved: async (route) => {
      pushRestockRoutes();
      if (route.name === config.routeName) {
        await browser.pushRoute(route);
        log('Actieve route ' + route.name + ' is bijgewerkt in de pagina.');
      }
    },
    onRouteDeleted: async (name) => {
      if (name === config.routeName) {
        await browser.pushRoute(emptyRoute(name));
        log('Actieve route ' + name + ' is verwijderd.');
      }
    }
  });

  const addr = await server.listen();
  log('Dashboard staat op http://' + addr.host + ':' + addr.port);

  // Config en route klaarzetten. Ze gaan mee zodra de extensie zich meldt.
  await browser.pushConfig(config);
  await browser.pushRoute(loadActiveRoute());
  pushRestockRoutes();
  await browser.start();
  log('Open Minibia in je eigen Chrome (met de extensie WJ Minibia-bot aan) en log in.');
}

async function shutdown(signal) {
  if (shuttingDown) {
    console.log('Nu meteen stoppen.');
    process.exit(1);
  }
  shuttingDown = true;
  try { farm.save(); } catch (e) { /* niets */ }
  console.log('\n' + signal + ' ontvangen. De bot sluit netjes af...');
  try {
    if (browser) {
      // Op de VPS (KEEP_RUNNING=1) speelt de bot door tijdens een update van de server.
      if (process.env.KEEP_RUNNING !== '1') {
        await Promise.race([browser.command('stop'), new Promise((r) => setTimeout(r, 2000))]);
      }
      await browser.close();
    }
  } catch (err) { /* negeren */ }
  try {
    if (server) await Promise.race([server.close(), new Promise((r) => setTimeout(r, 2000))]);
  } catch (err) { /* negeren */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log('Onverwachte fout: ' + (err && err.message ? err.message : String(err)));
});

main().catch((err) => {
  console.error('Starten mislukt:', err && err.message ? err.message : err);
  if (err && err.code === 'EADDRINUSE') {
    console.error('Poort 3100 is al bezet. Draait de bot misschien al?');
  }
  process.exit(1);
});
