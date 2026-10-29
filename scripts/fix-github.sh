#!/bin/bash
# Eenmalige reparatie van de GitHub-verbinding op de VPS.
# Oorzaak "GitHub is niet bereikbaar": de git-remote in /home/minibia/bot (en in de
# root-kopie /root/minibia-bot) wijst naar een onbereikbare URL (SSH zonder key, of een
# typfout in de repo-naam), en/of er staat een onjuiste github.com-sleutel in known_hosts.
# Dit script zet de remote op de correcte publieke HTTPS-URL, herstelt known_hosts en
# test de verbinding. Veilig: verandert niets aan de code zelf.
#
# Gebruik (als root op de VPS):
#   bash /home/minibia/bot/scripts/fix-github.sh
# Of met eigen repo/branch:
#   REPO=https://github.com/jouw-user/jouw-repo.git BRANCH=main bash scripts/fix-github.sh
set -u
REPO="${REPO:-https://github.com/wesley165/minibia-cavebot.git}"
BRANCH="${BRANCH:-main}"

zodat() { su minibia -s /bin/bash -c "cd /home/minibia/bot && $1" 2>/dev/null; }

echo "== 1. GitHub-hostkeys vernieuwen =="
ssh-keygen -R github.com >/dev/null 2>&1 || true
mkdir -p /root/.ssh && chmod 700 /root/.ssh
ssh-keyscan -t ed25519,rsa github.com >> /root/.ssh/known_hosts 2>/dev/null
echo "   known_hosts bijgewerkt."

echo "== 2. Remote van /home/minibia/bot op HTTPS zetten =="
zodat "git config --global --add safe.directory /home/minibia/bot" || true
zodat "git remote set-url origin $REPO" && echo "   origin -> $REPO"
zodat "git config --global --add safe.directory /home/minibia/bot" || true

echo "== 3. Root-kopieën bijwerken (used by de Bijwerken-knop) =="
if [ -d /root/minibia-bot ]; then
  git -C /root/minibia-bot remote set-url origin "$REPO" && echo "   /root/minibia-bot -> $REPO"
fi
if [ -f /root/van-github.sh ]; then
  # Zorg dat root-skripte de juiste repo gebruiken als ze die hardcoded hebben.
  grep -q 'minibia-cavebot\|minibia-bot' /root/van-github.sh && \
    sed -i "s#github.com[:/][^ ]*minibia-[a-z]*\.git#$REPO#g; s#git@github.com:[^ ]*minibia-[a-z]*#$REPO#g" /root/van-github.sh && \
    echo "   /root/van-github.sh URL gecorrigeerd."
fi

echo "== 4. Verbinding testen =="
if zodat "git fetch -q origin $BRANCH"; then
  HEAD=$(zodat "git rev-parse --short origin/$BRANCH")
  echo "   GELUKT: GitHub bereikbaar, nieuwste commit is $HEAD."
  echo "   Nu bijwerken doe je met: bash /home/minibia/bot/scripts/van-github.sh"
  echo "   of via de knop 'Bijwerken' in het dashboard."
else
  echo "   Mislukt. Test handmatig:"
  echo "     su minibia -s /bin/bash -c 'cd /home/minibia/bot && git ls-remote origin'"
  echo "   Ziet je repo er privé uit? Maak hem publiek (Settings -> Danger Zone -> Make public)"
  echo "   of geef mij een nieuw geldig token; SSH-werk op deze server niet (geen key)."
  exit 1
fi
