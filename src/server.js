'use strict';
// Dashboard en API. Alleen de ingebouwde http-module van Node.

const http = require('http');
const net = require('net');
const { createAuth } = require('./auth');
const fs = require('fs');
const path = require('path');

const MAX_BODY = 1024 * 1024; // 1 MB
const BACKLOG_PER_TYPE = 50;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Verzoek is te groot.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(Object.assign(new Error('Ongeldige JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * createServer({ root, store, port, host, password, getStatus, onCommand, onConfigSaved, onRouteSaved, onRouteDeleted })
 * Geeft { listen(), broadcast(type, payload), close() } terug.
 */
function createServer(opts) {
  const dashboardDir = path.resolve(opts.root, 'dashboard');
  const store = opts.store;
  const port = Number(opts.port || process.env.PORT || 3100);
  const host = opts.host || '127.0.0.1';
  const password = opts.password !== undefined ? opts.password : process.env.DASHBOARD_PASSWORD;
  // Eigen wachtwoord + sessies. DASHBOARD_PASSWORD is alleen nog de eenmalige aanmaakcode.
  const auth = createAuth({ root: opts.root, setupCode: password || '' });

  // Servertoegang voor het minibia-commando: een sleutel in data/admin-token
  // (alleen leesbaar voor de server), en alleen geldig vanaf 127.0.0.1 zelf.
  // Via de proxy (minibia.wjdigital.nl) werkt hij nooit: die komt van een ander
  // adres en zet altijd X-Forwarded-For.
  const adminFile = path.join(opts.root, 'data', 'admin-token');
  let adminToken = '';
  try { adminToken = fs.readFileSync(adminFile, 'utf8').trim(); } catch (e) { /* nog niet */ }
  if (!/^[a-f0-9]{48}$/.test(adminToken)) {
    adminToken = require('crypto').randomBytes(24).toString('hex');
    try { fs.mkdirSync(path.dirname(adminFile), { recursive: true }); fs.writeFileSync(adminFile, adminToken + '\n', { mode: 0o600 }); } catch (e) { adminToken = ''; }
  }
  function isAdmin(req) {
    const addr = String(req.socket.remoteAddress || '');
    const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const given = String(req.headers['x-wj-admin'] || '');
    return !!adminToken && local && !req.headers['x-forwarded-for'] && given.length === adminToken.length &&
      require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(adminToken));
  }

  const clients = new Set();
  let lastStatus = null;
  let seq = 0;
  const backlog = []; // { seq, type, payload } voor log en alert

  function writeEvent(res, type, payload) {
    res.write('event: ' + type + '\ndata: ' + JSON.stringify(payload === undefined ? null : payload) + '\n\n');
  }

  function remember(type, payload) {
    backlog.push({ seq: ++seq, type, payload });
    const sameType = backlog.filter((e) => e.type === type);
    if (sameType.length > BACKLOG_PER_TYPE) {
      const oldest = sameType[0];
      backlog.splice(backlog.indexOf(oldest), 1);
    }
  }

  function broadcast(type, payload) {
    if (type === 'status') lastStatus = payload;
    if (type === 'log' || type === 'alert') remember(type, payload);
    for (const res of clients) {
      try {
        writeEvent(res, type, payload);
      } catch (err) {
        clients.delete(res);
      }
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const status = lastStatus || (typeof opts.getStatus === 'function' ? opts.getStatus() : null);
    if (status) writeEvent(res, 'status', status);
    for (const e of backlog) writeEvent(res, e.type, e.payload);
    clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (err) { /* verbinding is weg */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch (err) {
      res.writeHead(400); return res.end('Ongeldig pad');
    }
    if (rel.includes('\0')) { res.writeHead(400); return res.end('Ongeldig pad'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.resolve(dashboardDir, '.' + rel);
    // Path-traversal-check: het bestand moet binnen dashboard/ liggen.
    if (full !== dashboardDir && !full.startsWith(dashboardDir + path.sep)) {
      res.writeHead(403); return res.end('Geen toegang');
    }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Niet gevonden');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(full).pipe(res);
    });
  }

  async function handleApi(req, res, pathname) {
    const method = req.method;

    if (pathname === '/api/status' && method === 'GET') {
      const status = lastStatus || (typeof opts.getStatus === 'function' ? opts.getStatus() : null);
      return sendJson(res, 200, status);
    }

    // Browser opnieuw opstarten, inloggen en de bot starten. De server zelf mag dat
    // niet (geen root): hij legt een verzoekbestand neer en een systemd-dienst
    // (minibia-herstart.path) voert /root/herstart.sh uit. Hooguit eens per 2 minuten.
    // Live beeld aan of uit. Aanzetten mag de server niet zelf (geen root): een
    // verzoekbestand voor minibia-vnc.path, net als bij de herstart.
    // Kaart voor de routekaart in het dashboard: begaanbare tegels en trappen/gaten
    // uit de verken-kaarten (data/verken-*-<z>.json), alleen binnen het gevraagde vak.
    if (pathname === '/api/map' && method === 'GET') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const z = Number(q.get('z'));
      const box = ['x0', 'y0', 'x1', 'y1'].map((k) => Number(q.get(k)));
      if (!Number.isFinite(z) || box.some((v) => !Number.isFinite(v)) || box[2] - box[0] > 300 || box[3] - box[1] > 300) {
        return sendJson(res, 400, { ok: false, error: 'Geef z, x0, y0, x1 en y1 (vak van hooguit 300 tegels).' });
      }
      const inBox = (k) => k[0] >= box[0] && k[0] <= box[2] && k[1] >= box[1] && k[1] <= box[3];
      const walk = new Set();
      const blocked = new Set();
      let files = [];
      try { files = fs.readdirSync(path.join(opts.root, 'data')).filter((n) => /^verken-\d+-\d+-(\d+)\.json$/.test(n) && Number(n.match(/-(\d+)\.json$/)[1]) === z); } catch (e) { files = []; }
      for (const n of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(opts.root, 'data', n), 'utf8'));
          (d.walk || []).forEach((k) => { if (inBox(k)) walk.add(k[0] + ',' + k[1]); });
          (d.blocked || []).forEach((k) => { if (inBox(k)) blocked.add(k[0] + ',' + k[1]); });
        } catch (e) { /* kapotte kaart overslaan */ }
      }
      const toList = (set) => Array.from(set).map((t) => t.split(',').map(Number));
      return sendJson(res, 200, { ok: true, z, walk: toList(walk), blocked: toList(blocked) });
    }

    if (pathname === '/api/vnc') {
      if (method === 'GET') return sendJson(res, 200, { ok: true, aan: await opts.vncOpen() });
      if (method === 'POST') {
        const body = await readBody(req);
        const aan = !!(body && body.aan);
        fs.writeFileSync(path.join(opts.root, 'data', 'vnc-verzoek'), aan ? 'aan\n' : 'uit\n');
        return sendJson(res, 200, { ok: true, aan: aan });
      }
    }

    if (pathname === '/api/restart-browser') {
      const reqFile = path.join(opts.root, 'data', 'herstart-verzoek');
      const stateFile = path.join(opts.root, 'data', 'herstart-status.json');
      if (method === 'GET') {
        let st = null;
        try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { st = null; }
        return sendJson(res, 200, { ok: true, pending: fs.existsSync(reqFile), status: st });
      }
      if (method === 'POST') {
        try {
          const last = fs.statSync(stateFile).mtimeMs;
          const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (st && st.stap !== 'klaar' && st.stap !== 'mislukt' && Date.now() - last < 2 * 60 * 1000) {
            return sendJson(res, 409, { ok: false, error: 'Er loopt al een herstart.' });
          }
        } catch (e) { /* nog nooit gedaan */ }
        if (fs.existsSync(reqFile)) return sendJson(res, 409, { ok: false, error: 'Er staat al een herstart klaar.' });
        fs.writeFileSync(reqFile, String(Date.now()) + '\n');
        return sendJson(res, 200, { ok: true });
      }
    }

    // Nieuwste versie van GitHub installeren. Net als bij de herstart: de server legt
    // een verzoekbestand neer en minibia-bijwerken.path voert scripts/bijwerken-knop.sh uit.
    if (pathname === '/api/update-github') {
      const reqFile = path.join(opts.root, 'data', 'bijwerken-verzoek');
      const stateFile = path.join(opts.root, 'data', 'bijwerken-status.json');
      if (method === 'GET') {
        let st = null;
        try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { st = null; }
        return sendJson(res, 200, { ok: true, pending: fs.existsSync(reqFile), status: st });
      }
      if (method === 'POST') {
        try {
          const last = fs.statSync(stateFile).mtimeMs;
          const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (st && st.stap !== 'klaar' && st.stap !== 'mislukt' && Date.now() - last < 5 * 60 * 1000) {
            return sendJson(res, 409, { ok: false, error: 'Er loopt al een update.' });
          }
        } catch (e) { /* nog nooit gedaan */ }
        if (fs.existsSync(reqFile)) return sendJson(res, 409, { ok: false, error: 'Er staat al een update klaar.' });
        fs.writeFileSync(reqFile, String(Date.now()) + '\n');
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/command' && method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.name !== 'string' || !body.name) {
        return sendJson(res, 400, { ok: false, error: 'Veld name ontbreekt.' });
      }
      const result = await opts.onCommand(body.name, body.args, { viaServer: !!req.viaServer });
      return sendJson(res, 200, result === undefined ? { ok: true } : result);
    }

    if (pathname === '/api/config') {
      if (method === 'GET') return sendJson(res, 200, store.loadConfig());
      if (method === 'PUT') {
        const cfg = await readBody(req);
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
          return sendJson(res, 400, { ok: false, error: 'Config moet een object zijn.' });
        }
        const before = store.loadConfig();
        store.saveConfig(cfg);
        if (typeof opts.onConfigSaved === 'function') await opts.onConfigSaved(cfg, before);
        return sendJson(res, 200, { ok: true, config: cfg });
      }
    }

    // Laatste 50 privéberichten (ontvangen en zelf verstuurd).
    if (pathname === '/api/chat' && method === 'GET') {
      let lines = [];
      try { lines = require('fs').readFileSync(require('path').join(opts.root, 'data', 'chat.jsonl'), 'utf8').trim().split('\n'); } catch (e) { lines = []; }
      const list = lines.filter(Boolean).slice(-50).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      return sendJson(res, 200, list);
    }

    // Sets: route plus refill onder één naam.
    if (pathname === '/api/sets' && method === 'GET') {
      return sendJson(res, 200, store.listSets());
    }
    if (pathname === '/api/sets' && method === 'POST') {
      const body = await readBody(req);
      const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
      if (!store.setId(name)) return sendJson(res, 400, { ok: false, error: 'Geef de set een naam.' });
      const cfg = store.loadConfig();
      if (!cfg.routeName || !store.loadRoute(cfg.routeName)) {
        return sendJson(res, 400, { ok: false, error: 'Er is geen actieve route om op te slaan.' });
      }
      const restock = cfg.restock ? JSON.parse(JSON.stringify(cfg.restock)) : null;
      const names = [cfg.routeName];
      if (restock && restock.routes) {
        ['toDepot', 'toHunt'].forEach((k) => { if (restock.routes[k] && !names.includes(restock.routes[k])) names.push(restock.routes[k]); });
      }
      const routes = {};
      for (const n of names) {
        const r = store.loadRoute(n);
        if (!r) return sendJson(res, 400, { ok: false, error: 'Route ' + n + ' bestaat niet. De set is niet opgeslagen.' });
        routes[n] = r.waypoints;
      }
      const copy = (v) => (v ? JSON.parse(JSON.stringify(v)) : null);
      const id = store.saveSet({
        name, savedAt: new Date().toISOString(), routeName: cfg.routeName, restock, routes,
        targeting: copy(cfg.targeting), healing: copy(cfg.healing)
      });
      return sendJson(res, 200, { ok: true, id, routes: names });
    }
    const sm = pathname.match(/^\/api\/sets\/([^/]+)(\/load)?$/);
    if (sm) {
      let id;
      try { id = decodeURIComponent(sm[1]); } catch (err) { id = ''; }
      if (!store.isValidName(id)) return sendJson(res, 400, { ok: false, error: 'Ongeldige setnaam.' });
      if (sm[2] && method === 'POST') {
        const set = store.loadSet(id);
        if (!set) return sendJson(res, 404, { ok: false, error: 'Set niet gevonden.' });
        // Routes terugzetten zoals ze in de set staan.
        for (const n of Object.keys(set.routes || {})) {
          if (!store.isValidName(n)) continue;
          const route = store.saveRoute({ name: n, waypoints: set.routes[n] });
          if (typeof opts.onRouteSaved === 'function') await opts.onRouteSaved(route);
        }
        const before = store.loadConfig();
        const cfg = Object.assign({}, before, { routeName: set.routeName });
        if (set.restock) cfg.restock = set.restock;
        else delete cfg.restock;
        // Monsterlijst en healing (oudere sets hebben die nog niet: dan blijven ze staan).
        if (set.targeting) cfg.targeting = set.targeting;
        if (set.healing) cfg.healing = set.healing;
        store.saveConfig(cfg);
        if (typeof opts.onConfigSaved === 'function') await opts.onConfigSaved(cfg, before);
        return sendJson(res, 200, { ok: true, config: cfg });
      }
      if (!sm[2] && method === 'DELETE') {
        if (!store.deleteSet(id)) return sendJson(res, 404, { ok: false, error: 'Set niet gevonden.' });
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/routes' && method === 'GET') {
      return sendJson(res, 200, store.listRoutes());
    }

    const m = pathname.match(/^\/api\/routes\/([^/]+)$/);
    if (m) {
      let name;
      try { name = decodeURIComponent(m[1]); } catch (err) { name = ''; }
      if (!store.isValidName(name)) {
        return sendJson(res, 400, { ok: false, error: 'Ongeldige routenaam. Gebruik alleen a-z, 0-9, - en _.' });
      }
      if (method === 'GET') {
        const route = store.loadRoute(name);
        if (!route) return sendJson(res, 404, { ok: false, error: 'Route niet gevonden.' });
        return sendJson(res, 200, route);
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const route = store.saveRoute({ name, waypoints: body && body.waypoints });
        if (typeof opts.onRouteSaved === 'function') await opts.onRouteSaved(route);
        return sendJson(res, 200, { ok: true, route });
      }
      if (method === 'DELETE') {
        const removed = store.deleteRoute(name);
        if (!removed) return sendJson(res, 404, { ok: false, error: 'Route niet gevonden.' });
        if (typeof opts.onRouteDeleted === 'function') await opts.onRouteDeleted(name);
        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { ok: false, error: 'Onbekend adres.' });
  }

  // Alleen verzoeken aan ons eigen adres. Dat houdt andere websites buiten
  // (DNS rebinding) en schrijfacties moeten JSON zijn (geen stiekeme formulieren).
  // Elk poortnummer op 127.0.0.1 of localhost: via een SSH-tunnel kan de poort anders zijn.
  // Plus het eigen domein uit PUBLIC_HOST (bijv. minibia.wjdigital.nl).
  const publicHost = String(process.env.PUBLIC_HOST || '').toLowerCase();
  const allowedHosts = { has: (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) || (!!publicHost && h === publicHost) };

  // Te vaak een fout wachtwoord vanaf hetzelfde adres: een uur blokkeren.
  const failed = new Map(); // ip -> { count, until }
  function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.socket.remoteAddress || '?';
  }

  // ---- Live beeld (noVNC op 127.0.0.1:6080) via het dashboard, alleen na inloggen ----
  const VNC_PORT = 6080;
  function proxyVnc(req, res) {
    const target = req.url.replace(/^\/vnc/, '') || '/';
    const up = http.request({ host: '127.0.0.1', port: VNC_PORT, path: target, method: req.method,
      headers: { host: '127.0.0.1:' + VNC_PORT } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Live beeld staat uit. Zet het aan met de knop in het dashboard.');
    });
    req.pipe(up);
  }
  function vncOpen() {
    return new Promise((resolve) => {
      const c = net.connect(VNC_PORT, '127.0.0.1');
      const done = (v) => { c.destroy(); resolve(v); };
      c.setTimeout(800, () => done(false));
      c.once('connect', () => done(true));
      c.once('error', () => done(false));
    });
  }
  opts.vncOpen = vncOpen;

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Niet toegestaan');
      }
      // Brug met de extensie: eigen controle (sleutel en herkomst), zie bridge.js.
      if (opts.bridge && req.url.startsWith('/bridge/')) {
        return await opts.bridge.handle(req, res, new URL(req.url, 'http://localhost').pathname);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' &&
          !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(res, 415, { ok: false, error: 'Stuur JSON.' });
      }
      const ip = clientIp(req);
      const f = failed.get(ip);
      if (f && f.until > Date.now()) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Te veel pogingen. Probeer het over een uur opnieuw.');
      }
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const secure = !!publicHost && String(req.headers.host || '').toLowerCase() === publicHost;

      // Foute poging tellen: na 5 keer een uur blokkeren.
      const countFail = () => {
        const prev = f && !(f.until && f.until <= Date.now()) ? f.count : 0;
        const n = prev + 1;
        failed.set(ip, { count: n, until: n >= 5 ? Date.now() + 60 * 60 * 1000 : 0 });
      };

      // ---- Inloggen (altijd bereikbaar) ----
      if (pathname === '/api/auth/status' && req.method === 'GET') {
        return sendJson(res, 200, { required: auth.required(), setup: auth.isSetup(), loggedIn: auth.check(req) });
      }
      if ((pathname === '/api/auth/setup' || pathname === '/api/auth/login') && req.method === 'POST') {
        const body = await readBody(req);
        const r = pathname === '/api/auth/setup'
          ? auth.setup(body && body.code, body && body.password)
          : auth.login(body && body.password);
        if (!r.ok) {
          if (r.badCode || r.badPassword) countFail();
          return sendJson(res, 400, { ok: false, error: r.error });
        }
        failed.delete(ip);
        res.setHeader('Set-Cookie', auth.cookie(r.token, secure));
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        auth.logout(req);
        res.setHeader('Set-Cookie', auth.clearCookie(secure));
        return sendJson(res, 200, { ok: true });
      }
      const PUBLIC = ['/login.html', '/login.js', '/login.css', '/style.css', '/favicon.ico'];
      if (PUBLIC.includes(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
        return serveStatic(req, res, pathname);
      }

      // ---- Alles hieronder alleen als je bent ingelogd ----
      const admin = isAdmin(req);
      req.viaServer = admin;
      if (!admin && !auth.check(req)) {
        if (pathname.startsWith('/api/') || pathname === '/events') {
          return sendJson(res, 401, { ok: false, error: 'Log eerst in.' });
        }
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
      }

      if (pathname === '/api/auth/change' && req.method === 'POST') {
        const body = await readBody(req);
        const r = auth.change(body && body.oldPassword, body && body.newPassword);
        if (!r.ok) {
          if (r.badPassword) countFail();
          return sendJson(res, 400, { ok: false, error: r.error });
        }
        res.setHeader('Set-Cookie', auth.cookie(r.token, secure));
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/events' && req.method === 'GET') return handleEvents(req, res);
      if (pathname.startsWith('/vnc/')) return proxyVnc(req, res);
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

      res.writeHead(405); res.end();
    } catch (err) {
      const status = err.status || 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
      else res.end();
    }
  });

  // Websocket van noVNC: alleen /vnc/websockify en alleen met een geldige sessie.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = ''; }
    if (pathname !== '/vnc/websockify' || !allowedHosts.has(String(req.headers.host || '').toLowerCase()) || !auth.check(req)) {
      socket.destroy();
      return;
    }
    const up = net.connect(VNC_PORT, '127.0.0.1', () => {
      let raw = req.method + ' /websockify HTTP/1.1\r\n';
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^host$/i.test(k)) continue;
        raw += k + ': ' + req.rawHeaders[i + 1] + '\r\n';
      }
      raw += 'Host: 127.0.0.1:' + VNC_PORT + '\r\n\r\n';
      up.write(raw);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve({ host, port });
        });
      });
    },
    broadcast,
    close() {
      for (const res of clients) {
        try { res.end(); } catch (err) { /* negeren */ }
      }
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

module.exports = { createServer };
