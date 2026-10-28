#!/bin/bash
# Haalt de nieuwste versie van de bot van GitHub (wesley165/minibia-bot) en zet hem aan.
# Gebruik op de VPS (als root):  bash /home/minibia/bot/scripts/van-github.sh
# - Pagina-code (page/, extension/) veranderd: bouwen en de extensie herladen (wacht tot het rustig is).
# - Server-code (src/) veranderd: alleen een melding. Herstarten doe je zelf met: systemctl restart minibia-bot
# Lokale wijzigingen op de VPS (bijv. routes via het dashboard) blijven staan. Raakt GitHub
# hetzelfde bestand, dan stopt git en verandert er niets.
set -e
cd /home/minibia/bot
als() { su minibia -s /bin/bash -c "cd /home/minibia/bot && $1"; }
oud=$(als "git rev-parse HEAD")
als "git fetch -q origin"
nieuw=$(als "git rev-parse origin/main")
if [ "$oud" = "$nieuw" ]; then echo "Al bijgewerkt ($(als 'git log --oneline -1'))."; exit 0; fi
if ! als "git merge -q --ff-only origin/main"; then
  echo "STOP: bijwerken lukt niet. Lokale wijzigingen op de VPS botsen met GitHub:"; als "git status -s"; exit 1
fi
echo "Bijgewerkt naar: $(als 'git log --oneline -1')"
veranderd=$(als "git diff --name-only $oud $nieuw")
echo "$veranderd" | sed 's/^/  /'
if echo "$veranderd" | grep -q -E '^(page|extension|scripts/build-extension)'; then
  echo "Pagina-code veranderd: bouwen en herladen."
  als "npm run -s build"
  [ -x /root/herlaad.sh ] && bash /root/herlaad.sh
fi
if echo "$veranderd" | grep -q '^src/'; then
  echo "LET OP: server-code veranderd. Herstart met: systemctl restart minibia-bot"
fi
