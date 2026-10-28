# Minibia-cavebot

Dit is een bot voor het spel Minibia. De bot speelt in je eigen Chrome, in het tabblad van minibia.com/play.

Wat de bot doet:

- Hij loopt een route met vaste punten (waypoints) in een rondje.
- Hij valt monsters aan die op jouw lijst staan.
- Hij healt en gebruikt mana via de hotkeys F1 tot en met F12.
- Hij pauzeert en stuurt een melding bij gevaar. Denk aan de anti-bot-controle, een death, een speler in de buurt of een verbroken verbinding.

## Hoe werkt het?

De bot bestaat uit twee delen.

1. **Een Chrome-extensie.** Een extensie is een kleine uitbreiding voor Chrome. Deze extensie zet de bot in het Minibia-tabblad. De bot speelt daar het spel.
2. **Een klein programma op je Mac (de server).** Dat programma toont het dashboard, bewaart je instellingen en routes en stuurt meldingen naar je telefoon.

De bot in Chrome en de server praten met elkaar via je eigen Mac. Er gaat niets via internet.

## Wat heb je nodig?

- Een Mac met Node.js versie 20 of hoger. Node.js is het programma dat de server laat draaien. Je haalt het op nodejs.org.
- Google Chrome.
- Een Minibia-account.

## Eenmalig installeren

**Stap 1. Bouw de extensie.** Open de Terminal in deze map en typ:

```
npm run build
```

Er staat nu een map `extension` in deze map.

**Stap 2. Laad de extensie in Chrome.**

1. Typ in de adresbalk van Chrome: `chrome://extensions`
2. Zet rechtsboven **Ontwikkelaarsmodus** aan.
3. Klik op **Uitgepakte extensie laden**.
4. Kies de map `extension` uit deze map.

Je ziet nu de extensie **WJ Minibia-bot** in de lijst. Zorg dat hij aan staat.

## Starten

1. Typ in de Terminal, in deze map:

   ```
   npm start
   ```

   Dit bouwt eerst de extensie opnieuw en start dan de server.

2. Open minibia.com/play in je eigen Chrome. Dat mag ook de Minibia-app zijn die je via Chrome hebt geïnstalleerd.
3. Log zelf in met je eigen gegevens.
4. Open het dashboard en druk op Start.

Vraagt Chrome of minibia.com apparaten op je lokale netwerk mag gebruiken? Kies dan **Toestaan**. Zo kan de bot met de server op je Mac praten.

Houd het Minibia-tabblad zichtbaar. Chrome remt tabbladen af die op de achtergrond staan. Dan reageert de bot trager.

Stoppen doe je met `Ctrl + C` in de Terminal. De bot in Chrome stopt dan ook.

## Dashboard

Open in Chrome: http://127.0.0.1:3100

Hier kun je:

- de bot starten, pauzeren, laten doorgaan en stoppen;
- je HP, mana, cap, positie en doel zien;
- zien hoe lang de bot draait en hoeveel kills hij maakt;
- zien welke monsters en spelers in de buurt zijn;
- routes maken, opnemen en aanpassen;
- kiezen welke monsters de bot aanvalt;
- regels voor healen instellen;
- instellen wat de bot doet als er een speler komt;
- meldingen instellen;
- de log en de meldingen lezen.

Wil je een andere poort? Start dan met `PORT=3200 npm start`. Het dashboard staat dan op http://127.0.0.1:3200.

Wil je het dashboard met een wachtwoord beveiligen? Zet dan de variabele `DASHBOARD_PASSWORD` voordat je start. Zet dat wachtwoord nooit in Git.

## Route opnemen

Je kunt een route maken door hem zelf te lopen.

1. Stop de bot.
2. Druk in het dashboard bij Route op **Start opname**. Je mag een naam invullen. Doe je dat niet, dan krijgt de route een naam met de datum.
3. Loop zelf de route in het spel. De bot zet onderweg waypoints neer, ook bij elke trap of elk gat.
4. Druk op **Stop opname**.
5. Ging je omhoog met een ladder of touw? Zet dat waypoint dan op `use` (ladder) of `rope` (touw).

Een opname komt altijd in een nieuwe route. Een bestaande route blijft dus zoals hij was.

## Meldingen op je telefoon (ntfy)

De bot kan meldingen naar je telefoon sturen via de gratis app ntfy.

1. Zet de app **ntfy** op je telefoon (App Store of Google Play).
2. Bedenk een topic. Dat is een naam voor je meldingen, bijvoorbeeld `minibia-wesley-8231`. Kies iets wat moeilijk te raden is. Iedereen die de naam weet, kan je meldingen lezen.
3. Abonneer je in de app op dat topic.
4. Vul hetzelfde topic in op het dashboard bij "Veiligheid en meldingen" en sla op.

Bij een anti-bot-controle of een death krijg je een melding met de hoogste prioriteit. Op de Mac krijg je ook een melding met geluid, als je bureaubladmeldingen aan hebt staan.

De meldingen komen van de server op je Mac. Staat de server uit, dan krijg je dus geen meldingen.

## Na een wijziging in de code

Pas je iets aan in de map `page/`? Doe dan deze drie stappen:

1. Typ in de Terminal: `npm run build`
2. Ga naar `chrome://extensions` en klik bij **WJ Minibia-bot** op het pijltje om de extensie te vernieuwen.
3. Herlaad het Minibia-tabblad.

Pas je alleen iets aan in `src/` of `dashboard/`? Dan is het genoeg om de server opnieuw te starten met `npm start`. Herlaad daarna het dashboard.

## Bestanden

- `page/` bevat de scripts van de bot in het spel.
- `scripts/build-extension.js` maakt van die scripts de extensie.
- `extension/` is de extensie die je in Chrome laadt. Pas hier niets met de hand aan. Het bouwscript maakt deze map steeds opnieuw.
- `src/` bevat de server: dashboard, brug met de extensie, opslag en meldingen.
- `dashboard/` bevat de webpagina.
- `data/config.json` bevat je instellingen. Ontbreekt dit bestand? Dan gebruikt de bot `data/config.example.json`.
- `data/routes/` bevat je routes, één bestand per route.
- `logs/` bevat de logbestanden per dag.

## Veiligheid

- De extensie en de server gebruiken een vaste sleutel. Die staat in `data/bridge-token`. Alleen met die sleutel kan de bot met de server praten.
- **Deel deze sleutel nooit.** Zet hem niet in Git, niet in een chat en niet in een mail. Dat geldt ook voor het bestand `extension/bot.js`, want daar zit de sleutel in.
- Heb je de sleutel toch gedeeld? Verwijder dan `data/bridge-token`. Typ daarna `npm start`, vernieuw de extensie in `chrome://extensions` en herlaad het Minibia-tabblad. Je krijgt dan een nieuwe sleutel.
- De server luistert alleen op 127.0.0.1. Dat is je eigen Mac. Andere computers kunnen er niet bij.

## Let op

- **De bot lost de anti-bot-controle nooit zelf op.** Verschijnt die controle? Dan pauzeert de bot en krijg je een melding. Los de controle zelf op in het Minibia-tabblad. Druk daarna op "Doorgaan" in het dashboard.
- **Log niet twee keer tegelijk in met hetzelfde account.** Dus geen tweede tabblad, niet tegelijk de Minibia-app en een tabblad, en geen andere browser. Dan raakt het spel in de war en kan de bot rare dingen doen.
- **Je kunt een ban krijgen.** Een bot gebruiken kan tegen de regels van Minibia zijn. Je account kan dan geblokkeerd worden. Dat risico ligt bij jou.
- Blijf in de buurt als de bot speelt. Kijk regelmatig in het dashboard.

De VPS haalt nieuwe versies automatisch op van GitHub (minibia-github.timer, elke 10 minuten, alleen als het rustig is).
