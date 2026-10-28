#!/bin/bash
# Haalt de nieuwste versie van de bot van GitHub (wesley165/minibia-bot) en zet hem aan.
# Gebruik op de VPS (als root):  bash /home/minibia/bot/scripts/van-github.sh
# Automatisch: de timer minibia-github.timer draait dit elke 10 minuten met AUTO=1.
# - Pagina-code (page/, extension/) veranderd: bouwen en de extensie herladen.
# - Server-code (src/) veranderd: alleen een melding. Herstarten doe je zelf met: systemctl restart minibia-bot
# - AUTO=1: alleen bijwerken als het rustig is (geen monsters, geen pauze zoals captcha of GM).
#   Anders niets doen; de timer probeert het 10 minuten later opnieuw. Na een update komt er een
#   melding op de telefoon (ntfy).
# Lokale wijzigingen op de VPS (bijv. routes via het dashboard) blijven staan. Raakt GitHub
# hetzelfde bestand, dan stopt git en verandert er niets.
set -e
cd /home/minibia/bot
als() { su minibia -s /bin/bash -c "cd /home/minibia/bot && $1"; }
T=$(cat data/admin-token)
meld() {
  echo "$1"
  [ "$AUTO" = "1" ] || return 0
  topic=$(python3 -c "import json;print((json.load(open('data/config.json')).get('notify') or {}).get('ntfyTopic') or '')" 2>/dev/null)
  [ -n "$topic" ] && curl -s -m 10 -H "Title: Minibia-bot bijgewerkt" -d "$1" "https://ntfy.sh/$topic" >/dev/null || true
}
oud=$(als "git rev-parse HEAD")
als "git fetch -q origin"
nieuw=$(als "git rev-parse origin/main")
if [ "$oud" = "$nieuw" ]; then [ "$AUTO" = "1" ] || echo "Al bijgewerkt ($(als 'git log --oneline -1'))."; exit 0; fi
if [ "$AUTO" = "1" ]; then
  rust=$(curl -s -m 10 -H "X-WJ-Admin: $T" http://127.0.0.1:3100/api/status | python3 -c "import json,sys;s=json.load(sys.stdin);print('ja' if not s.get('pauseReason') and not (s.get('monstersNear') or []) else 'nee')" 2>/dev/null || echo nee)
  if [ "$rust" != "ja" ]; then echo "Nieuwe versie klaar, maar het is niet rustig. Later opnieuw."; exit 0; fi
fi
if ! als "git merge -q --ff-only origin/main"; then
  meld "STOP: bijwerken lukt niet. Lokale wijzigingen op de VPS botsen met GitHub: $(als 'git status -s' | tr '\n' ' ')"; exit 1
fi
veranderd=$(als "git diff --name-only $oud $nieuw")
tekst="Nu op: $(als 'git log --oneline -1'). Veranderd: $(echo $veranderd | tr '\n' ' ')"
if echo "$veranderd" | grep -q -E '^(page|extension|scripts/build-extension)'; then
  als "npm run -s build"
  [ -x /root/herlaad.sh ] && bash /root/herlaad.sh >/dev/null 2>&1
  versie=$(curl -s -m 10 -H "X-WJ-Admin: $T" http://127.0.0.1:3100/api/status | python3 -c "import json,sys;print(json.load(sys.stdin).get('version'))" 2>/dev/null)
  tekst="$tekst. Extensie herladen (versie $versie)."
fi
if echo "$veranderd" | grep -q '^src/'; then
  tekst="$tekst LET OP: server-code veranderd. Herstart met: systemctl restart minibia-bot"
fi
meld "$tekst"
