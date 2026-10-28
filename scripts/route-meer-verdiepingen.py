#!/usr/bin/env python3
# Eén jachtroute over meerdere verdiepingen. Per verdieping: van de aankomstplek
# langs alle plekken (dekking R tegels) naar de trap omlaag. Op de onderste verdieping
# een bestaande route (rondje), daarna via de trappen omhoog terug naar het begin.
# Instellingen staan in PLAN hieronder. Gebruik (in /home/minibia/bot):
#   python3 scripts/route-meer-verdiepingen.py <routenaam> [dekking]
import json, sys
from collections import deque

NAAM = sys.argv[1] if len(sys.argv) > 1 else 'john-cyclopolis-8-11'
R = int(sys.argv[2]) if len(sys.argv) > 2 else 5
STAP = 6

# Per verdieping: kaart, waar je aankomt, en de trap omlaag (None = onderste).
PLAN = [
    {'z': 8, 'kaart': 'data/verken-33251-31698-8.json', 'in': (33251, 31699), 'omlaag': (33180, 31680)},
    {'z': 9, 'kaart': 'data/verken-33180-31681-9.json', 'in': (33180, 31682), 'omlaag': (33283, 31635)},
    {'z': 10, 'kaart': 'data/verken-33281-31633-10.json', 'in': (33283, 31637), 'omlaag': (33254, 31682)},
]
ONDERSTE = {'z': 11, 'route': 'data/routes/john-cyclopolis-11-midden.json', 'in': (33255, 31683)}
# Trappen omhoog voor de terugweg (op de verdieping zelf), en waar je dan aankomt.
OMHOOG = {11: (33254, 31682), 10: (33283, 31635), 9: (33180, 31680)}


def laad(kaart):
    d = json.load(open(kaart))
    blocked = {tuple(k) for k in d['blocked']}
    walk = {tuple(k) for k in d['walk']} - blocked
    near = {(x + dx, y + dy) for (x, y) in blocked for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    return walk, walk - near


def buren(k, W):
    for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0), (-1, -1), (1, -1), (1, 1), (-1, 1)):
        n = (k[0] + dx, k[1] + dy)
        if dx and dy and ((k[0] + dx, k[1]) not in W or (k[0], k[1] + dy) not in W):
            continue
        if n in W:
            yield n


def bfs(src, W):
    dist, prev = {src: 0}, {src: None}
    q = deque([src])
    while q:
        k = q.popleft()
        for n in buren(k, W):
            if n not in dist:
                dist[n] = dist[k] + 1
                prev[n] = k
                q.append(n)
    return dist, prev


def pad(a, b, W):
    _, prev = bfs(a, W)
    if b not in prev:
        raise SystemExit('Geen pad van %s naar %s' % (a, b))
    p, k = [], b
    while k is not None:
        p.append(k)
        k = prev[k]
    return p[::-1]


def dichtst(p, W):
    return min(W, key=lambda k: (max(abs(k[0] - p[0]), abs(k[1] - p[1])), abs(k[0] - p[0]) + abs(k[1] - p[1])))


def walk_wps(p, z):
    return [{'type': 'walk', 'x': x, 'y': y, 'z': z} for i, (x, y) in enumerate(p) if i and (i % STAP == 0 or i == len(p) - 1)]


def verdieping(stuk):
    z = stuk['z']
    walk, safe = laad(stuk['kaart'])
    start = dichtst(stuk['in'], safe)
    eind = dichtst(stuk['omlaag'], safe)
    bereik = set(bfs(start, safe)[0])
    # Plekken kiezen tot alles binnen R tegels van een plek ligt.
    todo = set(bereik)
    plekken = []
    while todo:
        best = max(bereik, key=lambda k: sum(1 for t in todo if max(abs(t[0] - k[0]), abs(t[1] - k[1])) <= R))
        gain = {t for t in todo if max(abs(t[0] - best[0]), abs(t[1] - best[1])) <= R}
        if len(gain) < 4:
            break
        plekken.append(best)
        todo -= gain
    # Volgorde: steeds de dichtstbijzijnde plek (in looptegels), eindigen bij de trap.
    volg, cur, rest = [], start, set(plekken)
    while rest:
        d, _ = bfs(cur, safe)
        nxt = min(rest, key=lambda k: d.get(k, 10 ** 6))
        volg.append(nxt)
        rest.discard(nxt)
        cur = nxt
    wps, cur, lengte = [], start, 0
    for i, pl in enumerate(volg + [eind]):
        p = pad(cur, pl, safe)
        lengte += len(p)
        w = walk_wps(p, z)
        if w and i < len(volg):
            w[-1]['label'] = 'spawn %d-%d' % (z, i + 1)
        wps += w
        cur = pl
    wps.append({'type': 'floor', 'x': stuk['omlaag'][0], 'y': stuk['omlaag'][1], 'z': z, 'label': 'trap omlaag'})
    print('Verdieping %d: %d plekken, %d van %d tegels gedekt, ongeveer %d tegels lopen' % (
        z, len(volg), len(bereik) - len(todo), len(bereik), lengte))
    return wps


route = []
for stuk in PLAN:
    route += verdieping(stuk)

# Onderste verdieping: het bestaande rondje, gedraaid zodat het begint bij de aankomst.
onder = json.load(open(ONDERSTE['route']))['waypoints']
ax, ay = ONDERSTE['in']
i0 = min(range(len(onder)), key=lambda i: max(abs(onder[i]['x'] - ax), abs(onder[i]['y'] - ay)))
rondje = onder[i0:] + onder[:i0] + [dict(onder[i0])]
for w in rondje:
    w = dict(w)
    if str(w.get('label', '')).startswith(('spawn', 'start')):
        w['label'] = 'spawn 11-' + str(w['label']).split(' ')[-1]
    route.append(w)
print('Verdieping 11: bestaand rondje (%d punten)' % len(onder))

# Terug omhoog: 11 -> 10 -> 9 -> 8, kortste weg, daarna naar het begin op 8.
terug = [(11, None), (10, 'data/verken-33281-31633-10.json'), (9, 'data/verken-33180-31681-9.json'), (8, 'data/verken-33251-31698-8.json')]
route.append({'type': 'floor', 'x': OMHOOG[11][0], 'y': OMHOOG[11][1], 'z': 11, 'label': 'trap omhoog'})
aankomst = {10: PLAN[2]['omlaag'], 9: PLAN[1]['omlaag'], 8: PLAN[0]['omlaag']}
for z, kaart in terug[1:]:
    walk, safe = laad(kaart)
    a = dichtst(aankomst[z], safe)
    doel = dichtst(OMHOOG[z], safe) if z in OMHOOG else dichtst(PLAN[0]['in'], safe)
    route += walk_wps(pad(a, doel, safe), z)
    if z in OMHOOG:
        route.append({'type': 'floor', 'x': OMHOOG[z][0], 'y': OMHOOG[z][1], 'z': z, 'label': 'trap omhoog'})

json.dump({'name': NAAM, 'waypoints': route}, open('data/routes/%s.json' % NAAM, 'w'), indent=1)
print('Route %s: %d waypoints, waarvan %d trappen.' % (NAAM, len(route), sum(1 for w in route if w['type'] == 'floor')))
