#!/usr/bin/env python3
# Spawnplekken bijhouden: elke 2 s de status lezen en van elk nieuw monster (per id)
# uit de lijst de plek bewaren waar we hem voor het eerst zagen. Dat is meestal
# vlak bij waar hij spawnt. Schrijft naar data/spawns.jsonl.
# Namen: env SPAWN_NAMEN (komma's), standaard de sterke orcs.
import json, os, time, urllib.request

API = 'http://127.0.0.1:3100'
ADMIN = open('/home/minibia/bot/data/admin-token').read().strip()
NAMEN = {n.strip().lower() for n in os.environ.get('SPAWN_NAMEN', 'Orc Leader,Orc Berserker,Orc Warlord,Orc Shaman').split(',') if n.strip()}
UIT = '/home/minibia/bot/data/spawns.jsonl'
gezien = {}

while True:
    try:
        req = urllib.request.Request(API + '/api/status', headers={'X-WJ-Admin': ADMIN})
        s = json.loads(urllib.request.urlopen(req, timeout=5).read())
        now = time.time()
        for m in s.get('monstersNear') or []:
            if m.get('id') is None or m.get('x') is None or str(m.get('name', '')).lower() not in NAMEN:
                continue
            if m['id'] in gezien:
                continue
            gezien[m['id']] = now
            with open(UIT, 'a') as f:
                f.write(json.dumps({'t': int(now * 1000), 'name': m['name'], 'x': m['x'], 'y': m['y'], 'z': m['z'],
                                    'route': s.get('routeName')}) + '\n')
        # Oude ids vergeten (na een uur), zodat de lijst klein blijft.
        for k in [k for k, v in gezien.items() if now - v > 3600]:
            del gezien[k]
    except Exception:
        pass
    time.sleep(2)
