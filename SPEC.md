# Bouwtekening Minibia-cavebot v1

Dit document is de afspraak tussen alle onderdelen. Wijk er niet van af. Code-comments en teksten in het Nederlands, B1-niveau, nooit een em dash.

## Doel v1

Een cavebot die zelf huntt:
- een route (waypoints) lopen in een lus;
- monsters uit een lijst aanvallen;
- healen en mana-spells via hotkeys;
- stoppen en een melding sturen bij gevaar (anti-bot-controle, death, speler in beeld, disconnect);
- een webpagina (dashboard) om alles te bedienen.

Refill, depot en restocken na death komen in v2. Looten doet het spel zelf (ingebouwde Automations: Loot Gold, Open Corpse enzovoort).

**Regel:** bij de anti-bot-controle (`captcha-modal`) pauzeert de bot eerst en loopt hij naar een veilige plek (geen monsters binnen `clearDistance` tegels). Daarna probeert captchawatch de quiz **zelf op te lossen** (dashboard-optie "Resolve quizzes", `config.quiz.resolve`, standaard aan): rekensommen worden ter plaatse uitgerekend, veldrasters worden geteld, en meerkeuzevragen gaan via Claude (`/bridge/quiz`, model `claude-haiku-4-5`). Staat "Resolve quizzes" uit, dan doet de bot geen eigen pogingen en logt hij netjes uit. Een wachtwoordquiz kan de bot niet raden; die blijft voor de speler. Lukt oplossen niet of duurt het te lang (`config.quiz.giveUpMs`, default 90 s), dan logt de bot uit en pakt autologin het op. AI-chat (auto-reply op GM/CM/Tutor-berichten) is apart aan/uit te zetten in het dashboard (`config.chat.aiReply.enabled`). Geen stealth, geen aanpassingen aan `navigator.webdriver`, geen vervalste meetgegevens.

## Opzet

```
Node (server op 127.0.0.1:3100)          Eigen Chrome: minibia.com/play
-------------------------------          ------------------------------
src/main.js       start alles            extensie WJ Minibia-bot (map extension/)
src/bridge.js     brug met de extensie   content script bot.js, world MAIN
src/server.js     dashboard + API        window.WJBot = { api, targeting, cavebot,
src/store.js      config en routes                        healing, safety, recorder, engine }
src/notify.js     meldingen              bridge-client.js praat via fetch met /bridge/*
scripts/build-extension.js               (sleutel X-WJ-Token, CORS voor https://minibia.com)
dashboard/        webpagina
data/config.json, data/routes/<naam>.json, data/bridge-token (niet in git)
```

De bot draait in je eigen Chrome. Je logt zelf in. `npm start` bouwt eerst de extensie en start dan de server.

## Paginascripts (map `page/`)

Volgorde van samenvoegen: `api.js`, `targeting.js`, `cavebot.js`, `healing.js`, `safety.js`, `recorder.js`, `engine.js`, `bridge-client.js`. Het bouwscript zet alles in `extension/bot.js`.

Elk bestand heeft deze vorm:

```js
(function (B) {
  'use strict';
  // ...
  B.naam = { ... };
})(window.WJBot = window.WJBot || {});
```

Het script kan draaien voordat het spel klaar is. Gebruik `gameClient` dus pas tijdens een tick, nooit bij het laden. Vang fouten per tick af met try/catch, zodat één fout de lus niet stopt.

### Bewezen spelfuncties (live getest op 17 oktober 2026)

| Wat | Hoe |
|---|---|
| Speler | `gameClient.player` (null op het inlogscherm) |
| Verbonden | `gameClient.networkManager.isConnected()` |
| Positie | `player.__position` met `x, y, z`. Klasse `Position` = `player.__position.constructor` |
| HP / mana / cap nu | `player.state.__state.health`, `.mana`, `.capacity` |
| Max HP / mana / cap | `player.state.maxHealth`, `.maxMana`, `.maxCapacity` |
| Level | `player.level` |
| Dood | `player.isDead === true` |
| Protection zone | `player.isInProtectionZone()` |
| Huidig doel | `player.__target` (creature of null) |
| Wezens | `Object.values(gameClient.world.activeCreatures)`. Velden: `id`, `name`, `type` (0 speler, 1 monster, 2 NPC), `getPosition()` geeft `{x,y,z}`, `getHealthPercentage()`. Bevat ook jezelf (`id === player.id`) |
| Aanvallen | `gameClient.world.targetMonster(creature)`, loslaten met `targetMonster(null)` |
| Lopen | `gameClient.world.pathfinder.findPath(player.__position, new Position(x,y,z))`. Loopt zelf, ook via de minimap. Heeft eigen vastloop-check |
| Loopt hij? | `gameClient.world.pathfinder.__isAutoWalking` |
| Stoppen met lopen | `gameClient.world.pathfinder.handleCancelWalk()` |
| Hotkey | `gameClient.interface.hotbarManager.handleKeyPress(111 + n)` voor F`n` (F1 = 112) |
| Open containers | `player.__openedContainers` (Set). Per container: `id`, `size`, `__title`, `getSlotItem(i)` |
| Item | `id` (client-id), `sid`, `count`. Naam: `gameClient.itemDefinitions[item.sid].properties.name` |
| Container op id | `player.getContainer(cid)`. cid 0 = uitrusting |
| Tegel | `gameClient.world.getTileFromWorldPosition(new Position(x,y,z))` |
| Pakket versturen | `gameClient.send(new XxxPacket(...))`. De klassen zijn globale `const` uit gewone scripts: bereikbaar bij naam (`ItemUsePacket`), niet via `window`. Controleer met `typeof ItemUsePacket !== 'undefined'` |
| Item gebruiken | `new ItemUsePacket({ which, index })`. Tegel: `which = tegel`, `index = 0xFF`. Container: `which = player.getContainer(cid)`, `index = slot` |
| Item gebruiken op tegel (touw) | `new ItemUseWithPacket(from, to)`, beide `{ which, index }` |
| Vensters | element `document.getElementById('<id>')`. Zichtbaar als `getComputedStyle(el).display !== 'none'`. Ids: `captcha-modal`, `death-modal` (knop `button[action="confirm"]`) |

## Gedeelde vormen

### ctx (wordt elke tick door engine gemaakt)

```js
ctx = {
  now,            // Date.now()
  player,         // B.api.player()
  creatures,      // B.api.creatures()
  config,         // volledige config (zie onder)
  route,          // { name, waypoints: [...] }
  state,          // 'running' (alleen dan worden modules aangeroepen)
  log(msg),       // logregel naar dashboard
  emit(type, payload)
}
```

### B.api (api.js)

Alles geeft eenvoudige objecten terug, geen spelobjecten (behalve `ref`).

- `ready()` geeft `true` als `gameClient`, `player` en verbinding er zijn.
- `player()` geeft `{ id, name, x, y, z, hp, maxHp, hpPct, mana, maxMana, manaPct, cap, maxCap, level, isDead, inPz, targetId, isWalking }` of `null`.
- `creatures()` geeft `[{ id, name, type, x, y, z, hpPct, ref }]` zonder jezelf.
- `distance(a, b)` geeft `Math.max(|dx|, |dy|)`, of `Infinity` bij een andere z.
- `attack(id)` geeft `true/false`. `clearTarget()`.
- `walkTo(x, y, z)` geeft `true/false`. `cancelWalk()`. `isWalking()`.
- `pressHotkey(n)`, met n van 1 t/m 12.
- `findItem(clientId)` geeft `{ cid, slot, count }` of `null` (zoekt in open containers). `countItem(clientId)` geeft het totaal.
- `itemName(clientId)`.
- `useTile(x, y, z)` gebruikt het bovenste item op een tegel (ladder, gat, deur).
- `useItemOnTile(clientId, x, y, z)` gebruikt een item uit de rugzak op een tegel (touw = client-id 3003).
- `modalVisible(id)` geeft `true/false`. `clickModalButton(id, action)` klikt op `button[action=...]`.

### B.targeting (targeting.js)

- `tick(ctx)` geeft `{ targetId, fighting }`. Kiest een doel en valt het aan met `B.api.attack`.
- `reset()`.
- Regels uit `voorschrift-targeting-leren-van-minibot.md`:
  - nooit een wezen met hpPct 0 (lijk), nooit spelers (type 0), nooit NPC's (type 2);
  - alleen namen uit `config.targeting.monsters`, tenzij `attackAll` aan staat;
  - alleen dezelfde z en binnen `maxDistance`;
  - score: huidig doel +4200, -240 per tegel afstand, gewond-bonus, prioriteit uit de lijst;
  - wissel naar een monster direct naast je als het huidige doel 3 of meer tegels weg is (`switchIfAdjacent`);
  - doel dat `unreachableMs` niet dichterbij komt en niet geraakt wordt: loslaten en `unreachableCooldownMs` overslaan.
- Tellen: als het doel verdwijnt of hpPct 0 wordt, roep `ctx.emit('kill', { name })` aan.

### B.cavebot (cavebot.js)

- `tick(ctx)` loopt naar het huidige waypoint als targeting niet vecht. Geeft `{ mode: 'walking' | 'action' | 'idle', index }`.
- `setIndex(i)`, `getIndex()`, `reset()`.
- Waypoint-typen:
  - `walk`: lopen tot afstand `<= config.cavebot.arriveDistance` (standaard 0), dan volgende.
  - `stand`: lopen, daarna `waitMs` wachten (standaard 1000).
  - `rope`: op de plek naast/op het gat staan, `useItemOnTile(3003, x, y, z)`, wachten tot z verandert (max 3 s), dan volgende.
  - `use`: `useTile(x, y, z)` (ladder, trap-luik), wachten tot z verandert (max 3 s).
- Vastlopen: geen voortgang in `repathMs` (3000) dan opnieuw `walkTo`. Na `maxRepaths` (2) waypoint overslaan en loggen.
- Waypoint op een andere z dan de speler: gewoon `walkTo` proberen (de pathfinder kan trappen nemen). Lukt dat 2 keer niet, overslaan.
- Aan het eind van de lijst terug naar 0 als `loop` aan staat, anders `ctx.emit('routeEnd')`.

### B.healing (healing.js)

- `tick(ctx)`. Loopt de regels af uit `config.healing.rules`. Per regel een eigen cooldown.
  - `{ type: 'hp', belowPct, hotkey, cooldownMs }`
  - `{ type: 'mana', belowPct, hotkey, cooldownMs }` (mana potion)
  - `{ type: 'manaSpell', abovePct, hotkey, cooldownMs }` (mana verbruiken, bijv. een spell voor skill)
- Eerste regel die past wint per tick (hp-regels eerst). Niets doen in PZ als `skipInPz`.

### B.safety (safety.js)

- `check(ctx)` geeft `null` of `{ action: 'pause' | 'alert', reason, message }`.
- Redenen en standaard:
  - `captcha`: `captcha-modal` zichtbaar. Altijd `pause`. Bericht: "Quiz staat open. Ik probeer hem zelf op te lossen; lukt dat niet, dan log ik uit."
  - `death`: `player.isDead` of `death-modal` zichtbaar. `pause`.
  - `player`: een speler (type 0, niet in `playerIgnore`) binnen 8 tegels op dezelfde z. Volgens `onPlayer`: `alert`, `pause` of `ignore`. Maximaal één melding per speler per 2 minuten.
  - `lowHp`: hpPct onder `lowHpAlertPct`. `alert`, maximaal één per minuut.
  - `disconnect`: `ready()` is false terwijl de bot loopt. `pause`.
- Alerts nooit spammen: per reden een eigen afkoeltijd.

### B.engine (engine.js)

- Toestand: `stopped`, `running`, `paused` (met `pauseReason`).
- `start()`, `stop()`, `pause(reason)`, `resume()`.
- `setConfig(cfg)`, `setRoute(route)`.
- `command(name, args)` geeft een resultaat terug: `start`, `stop`, `pause`, `resume`, `setIndex {i}`, `status`.
- `getStatus()` geeft het status-object (zie onder).
- Lus: elke 250 ms. Eerst `safety`, dan `healing`, dan `targeting`, en als die niet vecht `cavebot`. Bij `pause` van safety: `cancelWalk`, `clearTarget` niet nodig, wel melden via `emit('alert', ...)`.
- Na `resume` na een captcha: gewoon verder.
- Elke 500 ms `emit('status', getStatus())`, ook als de bot stil staat (zodat het dashboard live waarden toont).
- `emit` roept `window.wjEmit(type, payload)` aan als die bestaat, en zet het anders in `console.log('[WJBot]', ...)`.
- Na een reload laadt het script opnieuw. Node stuurt dan config en route opnieuw via `setConfig` en `setRoute`. De bot start na een reload altijd in `stopped`, tenzij Node `start` stuurt.

### Status-object

```js
{
  ready, state, pauseReason, mode,          // mode: idle | walking | fighting | action
  player,                                    // B.api.player() of null
  target: { id, name, hpPct, dist } | null,
  waypointIndex, waypointCount, routeName,
  monstersNear: [{ name, dist }],            // max 10, binnen 8 tegels
  playersNear:  [{ name, dist }],
  stats: { kills, startedAt, runtimeMs, killsPerHour },
  time
}
```

### Events van pagina naar Node (`wjEmit(type, payload)`)

| type | payload |
|---|---|
| `status` | status-object |
| `alert` | `{ reason, action, message, time }` |
| `log` | `{ msg, time }` |
| `kill` | `{ name, time }` |
| `routeEnd` | `{}` |

## Config (`data/config.json`)

```json
{
  "routeName": "rotworms",
  "targeting": {
    "monsters": [
      { "name": "Rotworm", "priority": 1 },
      { "name": "Carrion Worm", "priority": 2 }
    ],
    "attackAll": false,
    "maxDistance": 7,
    "unreachableMs": 3000,
    "unreachableCooldownMs": 15000,
    "switchIfAdjacent": true
  },
  "healing": {
    "skipInPz": true,
    "rules": [
      { "type": "hp", "belowPct": 60, "hotkey": 1, "cooldownMs": 1000 },
      { "type": "mana", "belowPct": 30, "hotkey": 2, "cooldownMs": 1000 }
    ]
  },
  "cavebot": { "arriveDistance": 0, "repathMs": 3000, "maxRepaths": 2, "loop": true },
  "safety": { "onPlayer": "alert", "playerIgnore": [], "lowHpAlertPct": 30 },
  "notify": { "ntfyTopic": "", "desktop": true }
}
```

## Route (`data/routes/<naam>.json`)

```json
{ "name": "rotworms", "waypoints": [ { "type": "walk", "x": 32211, "y": 32775, "z": 10, "label": "start" } ] }
```

Naam: alleen `a-z 0-9 - _`.

## Node-kant

- `package.json`: `"type": "commonjs"`, geen dependencies. Scripts: `"build": "node scripts/build-extension.js"` en `"start"` (eerst build, dan `node src/main.js`).
- `scripts/build-extension.js`: voegt `page/*.js` samen tot `extension/bot.js`, vult het serveradres (`http://127.0.0.1:<PORT>`) en de sleutel uit `data/bridge-token` in, en schrijft `extension/manifest.json` (Manifest V3, content script op `https://minibia.com/play*`, `world: MAIN`, `run_at: document_idle`, alleen het hoofdframe).
- `src/bridge.js`: `start()`, `command(name, args)`, `pushConfig(cfg)`, `pushRoute(route)`, `close()`, plus `handle(req, res, pathname)` voor `/bridge/*`.
  - Elke aanvraag moet de juiste `X-WJ-Token` hebben. Herkomst alleen `https://minibia.com`.
  - `POST /bridge/hello`: pagina is (opnieuw) geladen. Server zet de nieuwste config en route klaar.
  - `GET /bridge/poll`: lang wachten (max 20 s) op opdrachten.
  - `POST /bridge/result`: antwoord op een opdracht (`{ id, result }`). Geen antwoord binnen 10 s: fout terug naar het dashboard.
  - `POST /bridge/events`: events van de pagina in één keer (`{ events: [{ type, payload }] }`). De pagina stuurt ze elke 400 ms.
  - Geen contact meer na 45 s: niet verbonden.
- `src/server.js`: alleen `http` uit Node. Luistert op `127.0.0.1:3100` (poort uit env `PORT`). Als env `DASHBOARD_PASSWORD` gezet is: Basic Auth op alles.
  - `GET /` en statische bestanden uit `dashboard/` (met path-traversal-check).
  - `GET /events`: Server-Sent Events. Stuurt elk event als `event: <type>\ndata: <json>\n\n`. Bij verbinden direct de laatste status en de laatste 50 logregels en alerts.
  - `GET /api/status`.
  - `POST /api/command` met `{ name, args }`.
  - `GET /api/config`, `PUT /api/config` (hele object, daarna doorsturen naar de pagina).
  - `GET /api/routes` (lijst namen), `GET /api/routes/:name`, `PUT /api/routes/:name`, `DELETE /api/routes/:name`.
  - `PUT` van de actieve route of een nieuwe `routeName` in de config: route meteen doorsturen naar de pagina.
- `src/store.js`: `loadConfig()`, `saveConfig(cfg)`, `listRoutes()`, `loadRoute(name)`, `saveRoute(route)`, `deleteRoute(name)`. Atomisch schrijven (tmp-bestand en rename). Standaard config als het bestand ontbreekt (zie boven).
- `src/notify.js`: `notify({ title, message, priority })`. Als `ntfyTopic` gezet is: POST naar `https://ntfy.sh/<topic>` met headers `Title` en `Priority` (`urgent` voor captcha en death). Als `desktop` aan staat en het platform macOS is: `osascript -e 'display notification ...'` met geluid. Fouten alleen loggen.
- `src/main.js`: config laden, brug en server starten, config en route klaarzetten, events koppelen:
  - `status` bewaren en naar SSE;
  - `alert` naar SSE, log en `notify`;
  - `log`, `kill`, `routeEnd` naar SSE;
  - netjes afsluiten bij SIGINT.

## Dashboard (`dashboard/index.html`, `app.js`, `style.css`)

Eén pagina, Nederlands B1, licht en rustig, werkt op mobiel (kolommen onder elkaar). Geen externe bibliotheken.

- **Bovenbalk:** toestand (Gestopt, Actief, Gepauzeerd + reden), knoppen Start, Pauze, Doorgaan, Stop.
- **Speler:** naam, level, HP-balk, mana-balk, cap, positie, modus, doel.
- **Statistiek:** looptijd, kills, kills per uur.
- **In de buurt:** monsters en spelers met afstand. Spelers in rood.
- **Route:** keuzelijst met routes, nieuwe route maken, lijst met waypoints (type, x, y, z, label). Knoppen: "Waypoint hier" (type kiezen: walk, stand, rope, use; gebruikt de huidige positie uit de laatste status), omhoog, omlaag, verwijderen, "Ga naar deze" (`setIndex`). Huidige waypoint gemarkeerd. Opslaan via `PUT /api/routes/:name`.
- **Targeting:** lijst monsters (naam, prioriteit), toevoegen en verwijderen, vinkje "Alles aanvallen", maximale afstand. Knop "Voeg monsters in de buurt toe".
- **Healing:** regels (type, drempel, hotkey F1-F12, cooldown). Toevoegen en verwijderen.
- **Veiligheid en meldingen:** onPlayer (melden, pauzeren, negeren), negeerlijst spelers, lage-HP-drempel, ntfy-topic, bureaubladmelding aan of uit.
- **Log en meldingen:** laatste 100 regels, alerts opvallend. Bij een captcha-alert: grote rode balk bovenaan plus een geluid (Web Audio piep, geen bestand).
- Instellingen opslaan via `PUT /api/config`.
- Live data via `EventSource('/events')`, met automatisch opnieuw verbinden.
