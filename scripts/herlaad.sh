#!/bin/bash
# Extensie + Minibia-tab herladen via het Chrome-menu (typen in de adresbalk werkt niet meer).
export DISPLAY=:99
cd /home/minibia/bot; T=$(cat data/admin-token)
for i in $(seq 1 120); do
  n=$(curl -s -H "X-WJ-Admin: $T" http://127.0.0.1:3100/api/status | python3 -c "import json,sys;s=json.load(sys.stdin);print(len(s.get(\"monstersNear\") or []))")
  [ "$n" = "0" ] && break; sleep 3
done
xdotool keyup Alt_L Alt_R Control_L Control_R Shift_L Shift_R Super_L Super_R Meta_L Meta_R
xdotool key Escape; sleep 0.5
xdotool mousemove 150 20 click 1; sleep 0.8
xdotool mousemove 1000 63 click 1; sleep 1.2
xdotool mousemove 690 391; sleep 1.2
xdotool mousemove 480 391; sleep 0.3; xdotool click 1; sleep 3
xdotool mousemove 766 493 click 1; sleep 2
xdotool mousemove 493 20 click 1; sleep 1.5
xdotool mousemove 150 20 click 1; sleep 0.8
xdotool mousemove 95 63 click 1; sleep 2.5
xdotool mousemove 674 190 click 1; sleep 30
# Nooit een vastzittende Alt/Ctrl achterlaten (dan selecteert D de adresbalk en kun je niet typen).
xdotool keyup Alt_L Alt_R Control_L Control_R Shift_L Shift_R Super_L Super_R Meta_L Meta_R
curl -s -H "X-WJ-Admin: $T" http://127.0.0.1:3100/api/status | python3 -c "import json,sys;s=json.load(sys.stdin);print(s[\"state\"],s.get(\"version\"),(s.get(\"player\") or {}).get(\"hpPct\"))"
