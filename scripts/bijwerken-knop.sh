#!/bin/bash
# Knop "Bijwerken" in het dashboard: nieuwste versie van GitHub installeren.
# Wordt als root gestart door minibia-bijwerken.path als data/bijwerken-verzoek verschijnt.
# - Wacht tot er geen monsters in de buurt zijn (max 60 s). Anders stopt hij, zodat John
#   niet midden in een gevecht herladen wordt.
# - Draait scripts/van-github.sh (ophalen, bouwen, extensie herladen).
# - Is de server-code (src/) veranderd, dan herstart hij ook minibia-bot.
# Status voor het dashboard: data/bijwerken-status.json. Log: /var/log/minibia-bijwerken.log.
# Alles staat in main(), zodat bash het hele script al gelezen heeft voordat git dit bestand
# zelf bijwerkt.
main() {
  BOT=/home/minibia/bot
  REQ=$BOT/data/bijwerken-verzoek
  STATE=$BOT/data/bijwerken-status.json
  T=$(cat $BOT/data/admin-token)
  als() { su minibia -s /bin/bash -c "cd $BOT && $1"; }
  api() { curl -s -m 10 -H "X-WJ-Admin: $T" "$@"; }
  zet() {
    python3 -c "import json,sys,time;json.dump({'stap':sys.argv[1],'tekst':sys.argv[2],'tijd':int(time.time()*1000)},open(sys.argv[3],'w'))" "$1" "$2" "$STATE"
    chown minibia:minibia $STATE; chmod 644 $STATE
    echo "$(date '+%F %T') $1: $2"
  }
  rm -f $REQ
  cd $BOT
  zet bezig "Kijken of er een nieuwe versie op GitHub staat."
  oud=$(als "git rev-parse HEAD")
  if ! als "git fetch -q origin"; then zet mislukt "GitHub is niet bereikbaar. Probeer het later nog eens."; return 1; fi
  nieuw=$(als "git rev-parse origin/main")
  if [ "$oud" = "$nieuw" ]; then
    zet klaar "Je hebt al de nieuwste versie ($(als "git log -1 --format='%h van %cd' --date=format:'%d-%m %H:%M'"))."
    return 0
  fi
  zet bezig "Nieuwe versie gevonden. Wachten tot er geen monsters in de buurt zijn (max 60 s)."
  rustig=nee
  for i in $(seq 1 30); do
    N=$(api http://127.0.0.1:3100/api/status | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('monstersNear') or []))" 2>/dev/null)
    if [ "$N" = "0" ]; then rustig=ja; break; fi
    sleep 2
  done
  if [ "$rustig" != "ja" ]; then
    zet mislukt "Er bleven monsters in de buurt. Niets veranderd. Probeer het zo nog eens."
    return 1
  fi
  zet bezig "Nieuwe versie installeren en de extensie herladen."
  if ! uit=$(bash $BOT/scripts/van-github.sh 2>&1); then
    echo "$uit"
    zet mislukt "Bijwerken lukte niet: $(echo "$uit" | tail -n 1 | cut -c1-200)"
    return 1
  fi
  echo "$uit"
  if als "git diff --name-only $oud $nieuw" | grep -q '^src/'; then
    zet bezig "Server-code is veranderd. De server wordt herstart."
    systemctl restart minibia-bot
    sleep 5
  fi
  zet klaar "Klaar: nu op $(als "git log -1 --format='%h van %cd' --date=format:'%d-%m %H:%M'")."
  return 0
}
main "$@"
exit $?
