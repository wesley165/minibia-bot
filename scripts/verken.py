#!/usr/bin/env python3
# Cave verkennen: de bot loopt steeds naar de rand van wat hij al kent,
# scant daar de tegels en vecht onderweg mee. Blijft op dezelfde verdieping.
# Gebruik: python3 scripts/verken.py [max_minuten] [max_afstand] [kaart.json]
# Schrijft de kaart naar data/verken-<x>-<y>-<z>.json. Met een kaart erbij
# gaat hij verder waar een vorige keer stopte.
import json, sys, time, urllib.request
from collections import deque

import os
API = os.environ.get('WJ_API', 'http://127.0.0.1:3100')
ADMIN = os.environ.get('WJ_ADMIN', '')   # op de VPS: inhoud van data/admin-token
TMP_ROUTE = 'verken-tmp'
MAX_MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 15
MAX_RANGE = int(sys.argv[2]) if len(sys.argv) > 2 else 60
KAART = sys.argv[3] if len(sys.argv) > 3 else None
FAIL_RADIUS = 4   # mislukt doel: de hele buurt overslaan
RICHTING = sys.argv[4] if len(sys.argv) > 4 else ''   # bijv. 'noord': randen in het noorden eerst
PAD_STAP = 6      # verre doelen: om de zoveel tegels een tussenpunt over bekende grond
STOP_HP = 40
# Met ZOEK_OMLAAG=1 stopt hij zodra hij een trap/gat omlaag ziet ([floorchange=down]).
ZOEK_OMLAAG = os.environ.get('ZOEK_OMLAAG') == '1'
omlaag = []   # gevonden tegels omlaag
ladders = set()   # ladders (omhoog met 'use')
omhoog = set()    # trappen/ramps omhoog (floorchange met een richting, niet 'down')


def call(path, data=None, method=None):
    req = urllib.request.Request(API + path, data=json.dumps(data).encode() if data is not None else None,
                                 method=method or ('POST' if data is not None else 'GET'),
                                 headers=dict({'Content-Type': 'application/json'}, **({'X-WJ-Admin': ADMIN} if ADMIN else {})))
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


def status():
    return call('/api/status')


def cmd(name, args=None):
    return call('/api/command', {'name': name, 'args': args or {}})


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


walk = {}      # (x,y) -> True/False
blocked = set()  # gaten, trappen: nooit op stappen
failed = set()   # doelen die niet lukten
# VAK=x0,y0,x1,y1: alleen randen binnen dit vak verkennen (bijv. binnen de muren).
VAK = tuple(int(v) for v in os.environ['VAK'].split(',')) if os.environ.get('VAK') else None
def in_vak(k):
    return not VAK or (VAK[0] <= k[0] <= VAK[2] and VAK[1] <= k[1] <= VAK[3])
bezocht = []     # doelen waar we al heen zijn gegaan: daar niet steeds opnieuw heen
trail = []

st = status()
p = st['player']
Z, START = p['z'], (p['x'], p['y'])
out_file = 'data/verken-%d-%d-%d.json' % (START[0], START[1], Z)
if KAART:
    with open(KAART) as f:
        old = json.load(f)
    if old['z'] == Z:
        START = tuple(old['start'])
        out_file = KAART
        for k in old['walk']:
            walk[tuple(k)] = True
        for k in old['blocked']:
            blocked.add(tuple(k)); walk[tuple(k)] = False
        for k in old.get('ladders', []):
            ladders.add(tuple(k))
        for k in old.get('omhoog', []):
            omhoog.add(tuple(k))
        bezocht.extend(tuple(k) for k in old.get('bezocht', []))
        if os.environ.get('VERKEN_RESET_MISLUKT') != '1':
            for k in old.get('failed', []):
                failed.add(tuple(k))
        trail = old.get('trail', [])
        print('Kaart geladen:', len(old['walk']), 'tegels', flush=True)
old_route = call('/api/config')['routeName']
log('Start op', START, 'verdieping', Z, '(oude route', old_route + ')')


def scan():
    s = cmd('scanArea', {'r': 8}).get('scan') or {}
    for t in s.get('tiles', []):
        k = (t['x'], t['y'])
        if any('ladder' in i.lower() for i in t['i']) or 'ladder' in t['g'].lower():
            ladders.add(k)
        alles = t['g'] + ' ' + ' '.join(t['i'])
        if '[floorchange=' in alles and 'floorchange=down' not in alles:
            omhoog.add(k)
        if ZOEK_OMLAAG and ('floorchange=down' in t['g'] or any('floorchange=down' in i for i in t['i'])):
            if k not in omlaag:
                omlaag.append(k)
        if '[floorchange' in t['g'] or any('[floorchange' in i or 'teleport' in i.lower() for i in t['i']):
            blocked.add(k)
            walk[k] = False
        elif t['w']:
            walk[k] = True
        elif walk.get(k) is True and any('wall' in i for i in t['i']):
            walk[k] = False   # eerder ten onrechte begaanbaar: muur op een vloertegel
        elif k not in walk:
            # Niet begaanbaar kan ook een wezen of speler zijn. Alleen als muur tellen
            # als er geen lijk/wezen-achtig item ligt; bij twijfel later opnieuw bekijken.
            vloer = any(w in t['g'] for w in ('tile', 'floor', 'sand', 'grass', 'ground', 'mud', 'dirt', 'gravel'))
            walk[k] = None if vloer else False   # vloer maar bezet (wezen): later opnieuw


def ok(k):
    # Met VAK: ook het lopen zelf blijft binnen het vak (bijv. binnen de muren).
    return walk.get(k) is True and k not in blocked and in_vak(k) and max(abs(k[0] - START[0]), abs(k[1] - START[1])) <= MAX_RANGE


def near_failed(k):
    return any(max(abs(k[0] - f[0]), abs(k[1] - f[1])) <= FAIL_RADIUS for f in failed)


# Alles binnen GEZIEN_R tegels van een plek waar de bot ooit liep, heeft hij al gezien.
# Dat geldt ook na een herstart: het pad (trail) staat in de kaart.
GEZIEN_R = int(os.environ.get('VERKEN_GEZIEN', '6'))
ONBEKEND_MIN = int(os.environ.get('VERKEN_ONBEKEND', '10'))
gezien = set()
def markeer_gezien(pt):
    for dx in range(-GEZIEN_R, GEZIEN_R + 1):
        for dy in range(-GEZIEN_R, GEZIEN_R + 1):
            gezien.add((pt[0] + dx, pt[1] + dy))


def nearest_frontier(src):
    if not gezien:
        for pt in trail:
            markeer_gezien(tuple(pt))
    # BFS over bekende begaanbare tegels; rand = tegel met een onbekende buur.
    # Met RICHTING 'noord' tellen randen in het noorden als dichterbij.
    seen = {src: None}
    q = deque([(src, 0)])
    best = None
    while q:
        k, d = q.popleft()
        if k != src and d >= 3 and in_vak(k) and k not in gezien and not near_failed(k) and not any(max(abs(k[0] - b[0]), abs(k[1] - b[1])) <= 3 for b in bezocht):
            # Echte rand: minstens 10 onbekende tegels in de buurt (5x5). Eén losse
            # onbekende tegel (boom, steen, monster) is geen nieuw gebied.
            onbekend = sum(1 for dx in range(-2, 3) for dy in range(-2, 3) if walk.get((k[0] + dx, k[1] + dy)) is None)
            if onbekend >= ONBEKEND_MIN and any(walk.get((k[0] + dx, k[1] + dy)) is None for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                richting = {'noord': (0, 1), 'zuid': (0, -1), 'west': (1, 0), 'oost': (-1, 0)}.get(RICHTING, (0, 0))
                score = d + 1.5 * (richting[0] * (k[0] - src[0]) + richting[1] * (k[1] - src[1]))
                if RICHTING.startswith('punt:'):
                    # Randen dicht bij het opgegeven punt eerst. Verder dan 25 tegels ervan: niet.
                    px, py = (int(v) for v in RICHTING[5:].split(','))
                    afst = max(abs(k[0] - px), abs(k[1] - py))
                    if afst > 25:
                        score = None
                    else:
                        score = 0.3 * d + afst
                if score is None:
                    pass
                elif best is None or score < best[0]:
                    best = (score, k, d)
                if not RICHTING:
                    break
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                n = (k[0] + dx, k[1] + dy)
                if dx and dy and not ok((k[0] + dx, k[1])) and not ok((k[0], k[1] + dy)):
                    continue   # niet schuin tussen twee muren door
                if n not in seen and ok(n):
                    seen[n] = k
                    q.append((n, d + 1))
    if not best:
        return None, None, []
    # Pad terug opbouwen, voor tussenpunten.
    path, k = [], best[1]
    while k is not None:
        path.append(k)
        k = seen[k]
    path.reverse()
    return best[1], best[2], path


def save():
    out = {'z': Z, 'start': START, 'walk': [list(k) for k, v in walk.items() if v and k not in blocked],
           'blocked': [list(k) for k in blocked], 'failed': [list(k) for k in failed], 'trail': trail,
           'ladders': [list(k) for k in ladders], 'omhoog': [list(k) for k in omhoog],
           'bezocht': [list(k) for k in bezocht[-2000:]]}
    with open(out_file, 'w') as f:
        json.dump(out, f)


# Tijdelijke route met één punt: de cavebot loopt erheen, targeting vecht mee.
def go(k, path=None):
    # Ver weg: tussenpunten over bekende grond, zodat de bot niet vastloopt
    # (het spel zoekt alleen een pad binnen beeld).
    pts = [p for i, p in enumerate(path or []) if i and i % PAD_STAP == 0 and i < len(path) - 2] + [k]
    call('/api/routes/' + TMP_ROUTE, {'waypoints': [{'type': 'walk', 'x': x, 'y': y, 'z': Z} for (x, y) in pts]}, 'PUT')


# Eerste doel: waar de speler nu staat (niet het beginpunt van een oude kaart).
go((p['x'], p['y']))
cfg = call('/api/config')
cfg['routeName'] = TMP_ROUTE
call('/api/config', cfg, 'PUT')
if status()['state'] != 'running':
    cmd('start')
# Even wachten tot de status meldt dat de bot loopt.
for _ in range(10):
    if status()['state'] == 'running':
        break
    time.sleep(1)

t0 = time.time()
reason = 'klaar'
try:
    while time.time() - t0 < MAX_MIN * 60:
        st = status()
        p = st['player']
        if st['state'] != 'running':
            reason = 'bot staat niet meer aan (' + str(st.get('pauseReason')) + ')'
            break
        if p['z'] != Z:
            reason = 'andere verdieping'
            break
        scan()
        if ZOEK_OMLAAG and omlaag:
            reason = 'trap omlaag gevonden'
            break
        here = (p['x'], p['y'])
        trail.append(here)
        markeer_gezien(here)
        target, d, path = nearest_frontier(here)
        if not target:
            reason = 'hele cave verkend'
            break
        log('Naar', target, 'afstand', d, '| bekend', sum(1 for v in walk.values() if v))
        bezocht.append(target)
        go(target, path)
        last, still, t1 = here, 0, time.time()
        while time.time() - t1 < 40 + d:
            time.sleep(1.5)
            st = status()
            p = st['player']
            if st['state'] != 'running' or not p or p['z'] != Z:
                break
            now = (p['x'], p['y'])
            trail.append(now)
            markeer_gezien(now)
            if max(abs(now[0] - target[0]), abs(now[1] - target[1])) <= 2:
                break
            if st['mode'] == 'fighting':
                still = 0
            elif now == last:
                still += 1
                if still >= 6:
                    break
            else:
                still = 0
            last = now
            if len(trail) % 4 == 0:
                scan()
        else:
            failed.add(target)
        if not p:
            reason = 'speler weg (dood of uitgelogd)'
            break
        if max(abs(p['x'] - target[0]), abs(p['y'] - target[1])) > 2:
            failed.add(target)
        else:
            # Aangekomen en opnieuw gescand: wat er rond het doel nog 'onbekend' is,
            # is vaste rommel (pilaar, meubel). Als muur tellen, anders blijft hij terugkomen.
            scan()
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    kk = (target[0] + dx, target[1] + dy)
                    if walk.get(kk) is None:      # onbekend of niet geladen
                        walk[kk] = False
        save()
finally:
    cmd('stop')
    cfg = call('/api/config')
    cfg['routeName'] = old_route
    call('/api/config', cfg, 'PUT')
    save()
    if ZOEK_OMLAAG:
        with open('data/trap-omlaag.json', 'w') as f:
            json.dump({'z': Z, 'tegels': [list(k) for k in omlaag]}, f)
    log('Ladders:', sorted(ladders), '| omhoog:', sorted(omhoog))
    log('Gestopt:', reason, '| begaanbaar', sum(1 for k, v in walk.items() if v and k not in blocked),
        '| gaten/trappen', len(blocked), '| mislukt', len(failed))
