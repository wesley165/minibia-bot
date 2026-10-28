# Minibia-bot op de VPS (voor Claude Code)

Je draait op de VPS van Wesley (72.61.162.113), als root, naast de bot. Map: /home/minibia/bot.
Karakter: John Bow (paladin, crossbow + bolts), account "wess". Schrijf alles op B1-niveau in het Nederlands. Geen em dashes (—).

## Harde regels
1. AI auto-reply: kom er nooit aan. Dat is src/ai-reply.js, chat.aiReply in data/config.json, de schakelaars sAiReply en sAiReplySafety en hun code in dashboard/app.js. Niet weghalen, aanpassen, aan- of uitzetten. Wil een taak dat toch? Stop en vraag het Wesley.
2. Typ nooit wachtwoorden, inlogcodes of tokens. GAME_PASSWORD staat in .env; laat dat bestand met rust.
3. Pauzeer de bot nooit met de hand voor onderhoud midden in een hunt (John ging zo een keer dood). Herladen alleen als er geen monsters in de buurt zijn (zie Herladen).

## Onderdelen
- Diensten: minibia-bot (Node-server), minibia-chrome (Chrome op display :99), minibia-xvfb, minibia-vnc en minibia-novnc (live beeld, kosten ~30% CPU: zet ze uit als niemand kijkt).
- Commando's: `minibia start|stop|status`, `mbcmd <naam> '<json>'`.
- API: http://127.0.0.1:3100 met header `X-WJ-Admin: $(cat data/admin-token)` (werkt alleen vanaf 127.0.0.1).
  - GET /api/status, GET/PUT /api/config (hele config terugsturen), GET/PUT /api/routes/<naam>, POST /api/command {"name":..., "args":{}}.
  - Commando's: start, stop, pause, resume, scanArea {r}, walkTo, setIndex {i}, getHotbar, setHotbar, farmReset.
- Config-wijzigingen via de API werken meteen. Code-wijzigingen (page/*.js) niet: die moeten in de extensie.
- Logs: logs/bot-<datum>.log. Metingen: data/metingen.csv. Kills: data/kills.jsonl.
- Dashboard: https://minibia.wjdigital.nl (map dashboard/, statische bestanden, geen herstart nodig). Back-ups in /root/dashboard-backup-*.

## Code aanpassen
1. Pas page/*.js aan, test met `node --check`.
2. `sudo -u minibia npm run build` (bouwt extension/bot.js).
3. Herladen (hieronder). Daarna in het log kijken of de bot weer loopt.

## Herladen (extensie + tab)
Wacht tot `monstersNear` leeg is. Script: `/root/herlaad.sh` (wacht zelf op rust, herlaadt de extensie en de tab; John logt vanzelf weer in).

## Routes en kaarten
- Verkennen: `WJ_ADMIN=$(cat data/admin-token) python3 scripts/verken.py <minuten> <bereik> [kaart.json] [noord|zuid|oost|west|punt:x,y]`. Stopt bij een trap, neemt nooit een trap.
  Let op: als achtergrondproces negeert hij SIGINT; stop met `kill -TERM <pid>` en zet daarna routeName zelf terug.
- Route uit kaart: `python3 scripts/route-uit-kaart.py <kaart.json> <routenaam> <dekking>`. Upload met PUT /api/routes/<naam>, zet routeName in de config.
- Wesley stuurt vaak een minimap-plaatje met omcirkelde spawns: maak dan een route met alleen dat deel, laat een kaartje met genummerde waypoints zien en pas punten aan op nummer.
- Actieve route nu: john-cyclopolis-8-11 (Cyclopolis, verdieping 8 tot en met 11, heen en terug). Wesley wil alle verdiepingen blijven hunten voor variatie in de looproute; stel niet voor om alleen verdieping 11 te lopen.

## Belangrijke instellingen (data/config.json)
- targeting: keepDistance 3, kiteRange 3, maxDistance 5, extraDistance {Orc Berserker:1, Orc Leader:1}, unreachableCooldownMs 30000, avoidLine [Dragon].
- healing: F7 (mana fluid) als mana onder 100. F4 (80 mana) bij HP < 60%; zonder genoeg mana F5 (UH, item 3160). F6 rune (HMM) op doel: Fire Elemental altijd, andere monsters bij de laatste 40 HP, alleen met HMM. F9 bij paralyze.
  Mana boven 95%: F3 bolts maken tot 200, F2 HMM tot 100, F10 (invisible) als alles klaar is en er mana over is. F8 uit (oude regel bewaard in healing.bewaardF8).
- ammoSwitch: power bolts (3450) gebruiken vanaf 100 tot 0, dan weer bolts (3446).
- autoMove: life ring vak 8, bolts vak 9 (minMissing 15), crossbow vak 4, Dark helmet (3384) vak 0 als leeg.
- pickup: bolts, power bolts, HMM, royal helmet, DSM, MPA, crown/knight legs, knight armor, dark helmet.
- Life ring duurt 20 minuten; aantal life rings bepaalt hoe lang de hunt nog kan.

## Bewaken
Let op: `pkill -f <woord>` raakt ook je eigen shell als dat woord in je commando staat. Zoek pids met `pgrep -f "^python3 ..."`.
Belangrijke regels in het log: "MELDING (death", "MELDING (gm", "God Minibia", "captcha", "disconnect", "There is no way", "Twijfel", "overgeslagen".
Bij een GM in de buurt of een teleport: meteen Wesley melden, niets doen in het spel.
Meldingen gaan ook naar de telefoon via ntfy (topic in de config).

## Knoppen in het dashboard (sinds 28 okt 2026)
- Herstart: POST /api/restart-browser legt data/herstart-verzoek neer. minibia-herstart.path start /root/herstart.sh (wacht max 30 s op rust, herstart minibia-chrome, start de bot, status in data/herstart-status.json, log /var/log/minibia-herstart.log).
- Bijwerken: POST /api/update-github legt data/bijwerken-verzoek neer. minibia-bijwerken.path start /root/bijwerken-knop.sh, een kopie van scripts/bijwerken-knop.sh (wacht max 60 s op rust, anders niets; dan van-github.sh; bij src/ ook restart minibia-bot; mislukt het halverwege, dan terug naar de oude versie). Na een wijziging aan dit script of van-github.sh: kopie in /root vernieuwen. Status in data/bijwerken-status.json, log /var/log/minibia-bijwerken.log.
- Live beeld: noVNC loopt via het dashboard zelf op /vnc/ (websocket /vnc/websockify, alleen met een geldige dashboard-sessie). Aan/uit via POST /api/vnc {"aan":true|false}; minibia-vnc-schakel.path start /root/vnc-schakel.sh. Een SSH-tunnel is niet meer nodig.
- nginx-proxy (docker minibia-proxy) staat in /opt/minibia-proxy/default.conf, met een aparte location voor /vnc/websockify. Back-up: /root/minibia-proxy.conf.bak.

## Cyclopolis: van verdieping 8 naar 11 (gevonden 28 okt 2026)
- Trappen omlaag: verdieping 8 bij 33180,31680 (west) -> 9; verdieping 9 bij 33283,31635 (oost) -> 10; verdieping 10 bij 33254,31682 -> 11.
- Trap op 8 bij 33250,31697 gaat OMHOOG naar 7 (Edron). floorchange=down gaat omlaag; floorchange=north/south/east/west gaat omhoog.
- Jachtroute Cyclopolis: john-cyclopolis-ring (8-11, per verdieping een ring: omlaag de ene helft, terug de andere; scripts/route-ring.py).
- Vaste reisroute: naar-floor-11 (start op 8 bij 33251,31698). Nog niet in één keer getest.
- Zelf zoeken: WJ_ADMIN=$(cat data/admin-token) [RICHTING_<z>=punt:x,y] python3 scripts/omlaag.py 11 john-cyclopolis-11-midden

## Spawnplekken (sinds 28 okt 2026)
- Dienst minibia-spawnlog (scripts/spawnlog.py) schrijft van Orc Leader, Orc Berserker, Orc Warlord en Orc Shaman de plek waar ze voor het eerst gezien worden naar data/spawns.jsonl. Andere namen: env SPAWN_NAMEN.
- data/kills.jsonl bewaart per kill ook de plek van John (x, y, z).
- Orc Fortress (verdieping 7): binnen de muren ongeveer 32887,31747 tot 32980,31808. Kaart: data/verken-32821-31770-7.json.
- Targeting: ignoreNames (bijv. Chicken) wordt nooit aangevallen; Orc Leader heeft always=true (gaat altijd voor).

# GitHub (sinds 28 oktober 2026)
1 De code staat in de privé-repository wesley165/minibia-bot. Deze map op de VPS is een git-kopie daarvan (branch main).
2 De VPS mag alleen lezen van GitHub (deploy key ~minibia/.ssh/github_minibia_bot). Pushen vanaf de VPS kan niet.
3 Bijwerken gaat automatisch: minibia-github.timer draait elke 10 minuten `AUTO=1 scripts/van-github.sh`. Alleen als het rustig is (geen monsters, geen pauze); dan bouwen + herladen bij page/extension, melding via ntfy. Bij src/ alleen een melding (herstart minibia-bot zelf). Met de hand: `bash /home/minibia/bot/scripts/van-github.sh`.
4 Wachtwoorden, tokens, config.json, logs en chat staan nooit in Git (.gitignore laat alleen code, routes en kaarten toe).
