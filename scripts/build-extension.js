'use strict';

// Bouwt de Chrome-extensie in de map extension/.
// Voegt de paginascripts samen tot extension/bot.js en zet het adres van de
// server en de sleutel erin. Draai dit na elke wijziging in page/:
//   npm run build

const fs = require('fs');
const path = require('path');
const { loadToken } = require('../src/bridge');

const ROOT = path.join(__dirname, '..');
const PAGE_FILES = ['timer.js', 'api.js', 'targeting.js', 'kite.js', 'gearswap.js', 'pickup.js', 'cavebot.js', 'stuck.js', 'healing.js', 'safety.js', 'recorder.js', 'depot.js', 'engine.js', 'chat.js', 'automove.js', 'captchawatch.js', 'quizdump.js', 'bags.js', 'loot.js', 'autologin.js', 'bridge-client.js'];
const port = Number(process.env.PORT) || 3100;

const token = loadToken(ROOT);
const parts = PAGE_FILES.map((f) => fs.readFileSync(path.join(ROOT, 'page', f), 'utf8'));
let code = parts.join(';\n');
code = code.replace(/'__WJ_URL__'/g, JSON.stringify('http://127.0.0.1:' + port)).replace(/'__WJ_TOKEN__'/g, JSON.stringify(token));

// Versie = bouwmoment, zodat je in de status ziet welke code in Chrome draait.
const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const version = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
const out = '// Automatisch gemaakt door scripts/build-extension.js. Niet met de hand aanpassen.\n' +
  'if (window.top === window) {\n(window.WJBot = window.WJBot || {}).version = ' + JSON.stringify(version) + ';\n' + code + '\n}\n';

const extDir = path.join(ROOT, 'extension');
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, 'bot.js'), out);

const manifest = {
  manifest_version: 3,
  name: 'WJ Minibia-bot',
  version: '1.0.0',
  description: 'Laadt de Minibia-bot in het Minibia-tabblad en koppelt hem aan het dashboard op je eigen computer.',
  content_scripts: [{
    matches: ['https://minibia.com/play*'],
    js: ['bot.js'],
    world: 'MAIN',
    run_at: 'document_idle',
    all_frames: false
  }]
};
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Extensie gebouwd in ' + extDir + ' (' + Math.round(out.length / 1024) + ' KB).');
