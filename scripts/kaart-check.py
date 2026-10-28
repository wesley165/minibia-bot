#!/usr/bin/env python3
# Kaart nakijken terwijl de bot loopt: scant elke 4 s rond de speler en zet
# tegels met een muur-item (bijv. 'sandstone wall' op een vloertegel) in de kaart
# op niet begaanbaar. Ook nieuw ontdekte begaanbare tegels komen erbij.
# Gebruik: python3 scripts/kaart-check.py data/verken-....json [minuten]
import json, sys, time, urllib.request

import os
API = os.environ.get('WJ_API', 'http://127.0.0.1:3100')
ADMIN = os.environ.get('WJ_ADMIN', '')   # op de VPS: inhoud van data/admin-token
kaart = sys.argv[1]
MINUTEN = float(sys.argv[2]) if len(sys.argv) > 2 else 15


def cmd(name, args=None):
    req = urllib.request.Request(API + '/api/command', data=json.dumps({'name': name, 'args': args or {}}).encode(),
                                 method='POST', headers=dict({'Content-Type': 'application/json'}, **({'X-WJ-Admin': ADMIN} if ADMIN else {})))
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


d = json.load(open(kaart))
Z = d['z']
walk = {tuple(k) for k in d['walk']}
blocked = {tuple(k) for k in d['blocked']}
weg, erbij = set(), set()
t0 = time.time()
while time.time() - t0 < MINUTEN * 60:
    try:
        s = cmd('scanArea', {'r': 8}).get('scan') or {}
    except Exception:
        time.sleep(5)
        continue
    if (s.get('player') or {}).get('z') == Z:
        for t in s.get('tiles', []):
            k = (t['x'], t['y'])
            muur = any('wall' in i for i in t['i'])
            if k in walk and (muur or not t['w']) and k not in blocked and ('wall' in t['g'] or muur):
                walk.discard(k)
                weg.add(k)
            elif t['w'] and k not in walk and k not in blocked and '[floorchange' not in t['g']:
                walk.add(k)
                erbij.add(k)
        d['walk'] = [list(k) for k in walk]
        with open(kaart, 'w') as f:
            json.dump(d, f)
    print(time.strftime('%H:%M:%S'), 'muur gecorrigeerd', len(weg), '| nieuw', len(erbij), flush=True)
    time.sleep(4)
print('Klaar. Muren gecorrigeerd:', len(weg), 'nieuwe tegels:', len(erbij), flush=True)
