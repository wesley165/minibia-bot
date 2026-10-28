# Minibia-bot op de Hostinger-VPS

Laatst bijgewerkt op 18 oktober 2026.

## Wat draait er

De bot draait op de Hostinger-VPS (72.61.162.113), naast de WhatsApp-bots. Alles draait onder een eigen gebruiker `minibia` en start vanzelf na een herstart van de server.

| Dienst | Wat het doet |
|---|---|
| `minibia-xvfb` | een onzichtbaar scherm voor Chrome |
| `minibia-chrome` | Chrome met Minibia en de bot-extensie |
| `minibia-vnc` en `minibia-novnc` | schermweergave, zodat je kunt meekijken |
| `minibia-bot` | de bot-server en het dashboard |

Het dashboard staat online met een wachtwoord (zie hieronder). De schermweergave is alleen bereikbaar via een beveiligde verbinding (SSH-tunnel) en staat niet open op internet.

## Dashboard online

Open **https://minibia.wjdigital.nl** op je computer of telefoon.

- **Eerste keer:** je maakt zelf een wachtwoord aan van minimaal 6 tekens. Daarvoor is eenmalig een aanmaakcode nodig (staat op de VPS als DASHBOARD_PASSWORD in `/home/minibia/bot/.env`). Daarna werkt die code niet meer.
- **Daarna:** inloggen met je eigen wachtwoord. Je blijft 30 dagen ingelogd op dat apparaat. Rechtsboven staat Uitloggen.
- **Wachtwoord vergeten?** Laat Claude `data/auth.json` op de VPS weghalen. Dan kun je met de aanmaakcode een nieuw wachtwoord maken.
- Na 5 foute pogingen is je adres een uur geblokkeerd.
- Je wachtwoord wordt alleen versleuteld bewaard. Niemand kan het terugzien.

De koppeling met de extensie (`/bridge/`) is van buitenaf niet bereikbaar. Het domein wijst via SiteGround-DNS naar de VPS. Traefik regelt HTTPS (container `minibia-proxy`).

## Meekijken in Chrome op de VPS (via je Mac)

1. Open de app Terminal en plak deze regel. Laat het venster daarna open staan.

```bash
ssh -i ~/.ssh/id_ed25519_wj_vps -N -L 6080:127.0.0.1:6080 -L 3101:127.0.0.1:3100 root@72.61.162.113
```

2. Open in je browser: http://localhost:6080/vnc.html

3. Klaar? Sluit het Terminal-venster. De bot blijft gewoon doorspelen.

## Automatisch inloggen

Logt Minibia uit, dan logt de bot zelf weer in: inlogvenster openen, wachtwoord invullen, Login, Wess kiezen, Enter Game. Dat gebeurt alleen als de bot moet spelen. Staat hij op **Stop**, dan logt hij niet meer in en drukt hij ook niet op Reconnect. Zo kun je zelf ergens anders spelen. Het wachtwoord staat als `GAME_PASSWORD` in `/home/minibia/bot/.env` (alleen leesbaar voor de server). Het komt niet in het dashboard of in de logs. Wachtwoord veranderd? Zet het nieuwe er op dezelfde manier in en herstart de bot-server.

## Vanzelf weer starten

De server onthoudt of de bot moet spelen (`data/wanted.json`). Start of Doorgaan zet dat aan, alleen Stop zet het uit. Na een herstart van Chrome of de VPS logt de bot eerst in. Staat hij daarna 15 seconden stil, dan start hij zichzelf. Dat gebeurt hooguit 3 keer per 10 minuten.

## Vastzitten

Staat Wess langer dan 1 minuut op dezelfde plek zonder kill, en verliest zijn doel geen HP? Dan zoekt de bot uit waarom (doel raakt niet op, ingesloten, waypoint bezet, actie lukt niet, weg geblokkeerd) en doet hij iets:
- na 1 minuut: doel loslaten, waypoint overslaan of het dichtstbijzijnde waypoint kiezen;
- na 1,5 minuut: een stap opzij en het waypoint overslaan;
- na 2 minuten en daarna elke halve minuut: twee tegels opzij en opnieuw beginnen. Na 2 minuten komt er ook een melding.

In het dashboard zie je bij "Bezig met" hoe lang en waarom hij vastzit. Alles staat ook in het log.

Bedienen vanaf de server zelf (voor Claude): `minibia status | start | stop | pause | resume`.

## Belangrijk

- **Zelf spelen?** Druk eerst op Stop in het VPS-dashboard. Dan blijft de bot uitgelogd. Druk je weer op Start, dan logt hij zelf in en gaat hij verder.
- **Anti-bot-controle of Cloudflare-vakje:** dat klik je zelf aan via de schermweergave. De bot doet dat nooit.
- **Meldingen op je telefoon:** vul in het dashboard bij Veiligheid en meldingen een ntfy-topic in. Installeer de ntfy-app en abonneer je op hetzelfde topic.

## Meting van processor en verbinding

Sinds 18 oktober 2026 meet de dienst `minibia-meting` elke minuut hoe het gaat. De uitkomst staat in `/home/minibia/bot/data/metingen.csv`.

- **steal_pct:** hoeveel processortijd Hostinger achterhoudt. Boven 20% gaat het spel haperen.
- **bezig_pct, load1 en chrome_pct:** hoe druk de server en Chrome zijn.
- **ping_ms en verbinden_ms:** hoe snel minibia.com reageert. Bij "weg" was er geen verbinding.
- **ingelogd en toestand:** of Wess in het spel staat en wat de bot doet.

Chrome draait met lichte instellingen: geen achtergronddiensten, geen vertaling en geen updates op de achtergrond. De oude dienst staat als reserve in `/root/minibia-chrome.service.bak`.

## Code bijwerken

Na een wijziging in de code (door Claude):
1. Bestanden naar de VPS kopiëren en de extensie daar opnieuw bouwen.
2. In de VPS-Chrome bij `chrome://extensions` de extensie vernieuwen (rond pijltje) en het Minibia-tabblad herladen.
3. `systemctl restart minibia-bot` als de server-kant is veranderd.
