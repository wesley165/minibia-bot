#!/bin/bash
# Knop "Bijwerken" in het dashboard: nieuwste versie van GitHub installeren.
# Wordt als root gestart door minibia-bijwerken.path als data/bijwerken-verzoek verschijnt.
# Root draait een kopie: /root/bijwerken-knop.sh en /root/van-github.sh (niet de bestanden in de
# map van minibia, die kan minibia zelf veranderen). Na een wijziging aan deze scripts:
#   cp /home/minibia/bot/scripts/{bijwerken-knop,van-github}.sh /root/
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
  # Status schrijven als minibia (geen root in de map van minibia).
  zet() {
    python3 -c "import json,sys,time;print(json.dumps({'stap':sys.argv[1],'tekst':sys.argv[2],'tijd':int(time.time()*1000)}))" "$1" "$2" \
      | su minibia -s /bin/bash -c "cat > $STATE"
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
    N=$(api http://127.0.0.1:3100/api/status | python3 -c "import json,sys;s=json.load(sys.stdin);print(len(s.get('monstersNear') or []) if 'state' in s and s.get('version') else 'x')" 2>/dev/null)
    if [ "$N" = "0" ]; then rustig=ja; break; fi
    sleep 2
  done
  if [ "$rustig" != "ja" ]; then
    zet mislukt "Er bleven monsters in de buurt. Niets veranderd. Probeer het zo nog eens."
    return 1
  fi
  zet bezig "Nieuwe versie installeren en de extensie herladen."
  if ! uit=$(bash /root/van-github.sh 2>&1); then
    echo "$uit"
    # Halve update (bijv. bouwen mislukt na het ophalen)? Terug naar de oude versie,
    # zodat een volgende klik het opnieuw probeert.
    [ "$(als 'git rev-parse HEAD')" != "$oud" ] && als "git reset -q --keep $oud"
    zet mislukt "Bijwerken lukte niet: $(echo "$uit" | tail -n 1 | cut -c1-200)"
    return 1
  fi
  echo "$uit"
  nieuw=$(als "git rev-parse HEAD")
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
