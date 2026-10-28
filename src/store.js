'use strict';
// Opslag van config en routes in de map data/.
// Schrijven gaat altijd atomisch: eerst een tmp-bestand, daarna rename.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUTES_DIR = path.join(DATA_DIR, 'routes');
const SETS_DIR = path.join(DATA_DIR, 'sets');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const EXAMPLE_FILE = path.join(DATA_DIR, 'config.example.json');

const NAME_RE = /^[a-z0-9_-]+$/;

// Standaard config uit de SPEC. Wordt gebruikt als data/config.json ontbreekt.
const DEFAULT_CONFIG = {
  routeName: 'rotworms',
  targeting: {
    monsters: [
      { name: 'Rotworm', priority: 1 },
      { name: 'Carrion Worm', priority: 2 }
    ],
    attackAll: false,
    maxDistance: 7,
    approachMinMs: 2000,
    unreachableMs: 1500,
    unreachableCooldownMs: 15000,
    switchIfAdjacent: true
  },
  healing: {
    skipInPz: true,
    rules: [
      { type: 'hp', belowPct: 60, hotkey: 1, cooldownMs: 1000 },
      { type: 'mana', belowPct: 30, hotkey: 2, cooldownMs: 1000 }
    ]
  },
  cavebot: { arriveDistance: 0, repathMs: 3000, maxRepaths: 2, loop: true },
  safety: { onPlayer: 'alert', playerIgnore: [], lowHpAlertPct: 30 },
  notify: { ntfyTopic: '', desktop: true },
  crowd: { enabled: true, windowMin: 10, factor: 1.5, minDiffPts: 15, cooldownMin: 10 }
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureDirs() {
  fs.mkdirSync(ROUTES_DIR, { recursive: true });
}

function writeJsonAtomic(file, data) {
  ensureDirs();
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function routeFile(name) {
  if (!isValidName(name)) throw new Error('Ongeldige routenaam. Gebruik alleen a-z, 0-9, - en _.');
  return path.join(ROUTES_DIR, name + '.json');
}

// Config laden. Ontbreekt het bestand, dan de voorbeeldconfig of de standaard.
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return readJson(CONFIG_FILE);
  } catch (err) {
    console.error('[store] config.json is niet te lezen, ik gebruik de standaard:', err.message);
    return clone(DEFAULT_CONFIG);
  }
  try {
    if (fs.existsSync(EXAMPLE_FILE)) return readJson(EXAMPLE_FILE);
  } catch (err) {
    console.error('[store] config.example.json is niet te lezen:', err.message);
  }
  return clone(DEFAULT_CONFIG);
}

function saveConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Config moet een object zijn.');
  }
  writeJsonAtomic(CONFIG_FILE, cfg);
  return cfg;
}

function listRoutes() {
  ensureDirs();
  return fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter(isValidName)
    .sort();
}

// Geeft de route terug, of null als hij niet bestaat.
function loadRoute(name) {
  const file = routeFile(name);
  if (!fs.existsSync(file)) return null;
  const route = readJson(file);
  if (!Array.isArray(route.waypoints)) route.waypoints = [];
  route.name = name;
  return route;
}

function saveRoute(route) {
  if (!route || typeof route !== 'object') throw new Error('Route moet een object zijn.');
  const name = route.name;
  const file = routeFile(name);
  const clean = {
    name,
    waypoints: Array.isArray(route.waypoints) ? route.waypoints : []
  };
  writeJsonAtomic(file, clean);
  return clean;
}

function deleteRoute(name) {
  const file = routeFile(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// Sets: een jachtroute plus de refill-instellingen (met de routes naar het
// depot en terug) onder één naam, bijv. "Liberty Bay Unlimited".
// Elke set bewaart een eigen kopie van de routes.
function setId(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function setFile(id) {
  if (!isValidName(id)) throw new Error('Ongeldige setnaam.');
  return path.join(SETS_DIR, id + '.json');
}

function listSets() {
  fs.mkdirSync(SETS_DIR, { recursive: true });
  return fs.readdirSync(SETS_DIR)
    .filter((f) => f.endsWith('.json') && isValidName(f.slice(0, -5)))
    .map((f) => {
      try {
        const s = readJson(path.join(SETS_DIR, f));
        return {
          id: f.slice(0, -5), name: s.name, routeName: s.routeName, savedAt: s.savedAt, routes: Object.keys(s.routes || {}),
          monsters: ((s.targeting && s.targeting.monsters) || []).map((m) => m && m.name).filter(Boolean),
          healingRules: ((s.healing && s.healing.rules) || []).length
        };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function loadSet(id) {
  const file = setFile(id);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function saveSet(set) {
  const id = setId(set && set.name);
  if (!id) throw new Error('Geef de set een naam.');
  fs.mkdirSync(SETS_DIR, { recursive: true });
  writeJsonAtomic(setFile(id), set);
  return id;
}

function deleteSet(id) {
  const file = setFile(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = {
  setId,
  listSets,
  loadSet,
  saveSet,
  deleteSet,
  DEFAULT_CONFIG,
  isValidName,
  loadConfig,
  saveConfig,
  listRoutes,
  loadRoute,
  saveRoute,
  deleteRoute
};
