#!/usr/bin/env python3
# Rondje maken uit een verken-kaart: kiest plekken zodat de hele cave binnen
# DEKKING tegels van de route ligt, zet ze in een slimme volgorde en vult de
# stukken ertussen met tussenpunten. Plekken heten "spawn N": die slaat de
# cavebot nooit over.
# Gebruik: python3 scripts/route-uit-kaart.py data/verken-....json routenaam [dekking]
import json, sys
from collections import deque

kaart, naam = sys.argv[1], sys.argv[2]
DEKKING = int(sys.argv[3]) if len(sys.argv) > 3 else 5
STAP = 7          # om de zoveel tegels een tussenpunt
MUUR_AFSTAND = 1  # tussenpunten liever niet tegen een gat of trap

d = json.load(open(kaart))
Z = d['z']
blocked = {tuple(k) for k in d['blocked']}
walk = {tuple(k) for k in d['walk']} - blocked
# Niet naast een gat of trap lopen: daar val je zo een verdieping lager.
near_hole = {(x + dx, y + dy) for (x, y) in blocked for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
path_ok = walk - near_hole
start = tuple(d['start'])


def bfs(src, allowed):
    dist, prev = {src: 0}, {src: None}
    q = deque([src])
    while q:
        k = q.popleft()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                n = (k[0] + dx, k[1] + dy)
                # Schuin alleen als je niet tussen twee muren door knijpt (zoals in het spel).
                if dx and dy and (k[0] + dx, k[1]) not in allowed and (k[0], k[1] + dy) not in allowed:
                    continue
                if n in allowed and n not in dist:
                    dist[n] = dist[k] + 1
                    prev[n] = k
                    q.append(n)
    return dist, prev


# Alleen het deel dat vanaf de start te bereiken is.
s0 = min(path_ok, key=lambda k: max(abs(k[0] - start[0]), abs(k[1] - start[1])))
reach, _ = bfs(s0, path_ok)
area = set(reach)
print('Bereikbaar:', len(area), 'van', len(walk), 'tegels')

# Plekken kiezen (gretig): steeds de tegel die de meeste nog niet gedekte tegels dekt.
def cover(k):
    return {t for t in area if max(abs(t[0] - k[0]), abs(t[1] - k[1])) <= DEKKING}

todo = set(area)
spots = []
covers = {k: cover(k) for k in area}
while len(todo) > 0.03 * len(area):
    best = max(area, key=lambda k: len(covers[k] & todo))
    gain = covers[best] & todo
    if len(gain) < 4:
        break
    spots.append(best)
    todo -= gain
print('Plekken:', len(spots), '| niet gedekt:', len(todo))

# Afstanden tussen plekken over de kaart.
pts = [s0] + spots
info = {p: bfs(p, path_ok) for p in pts}
D = [[info[a][0].get(b, 10 ** 6) for b in pts] for a in pts]

# Volgorde: dichtstbijzijnde eerst, daarna 2-opt verbeteren. Rondje begint en eindigt bij de start.
order = [0]
left = set(range(1, len(pts)))
while left:
    nxt = min(left, key=lambda j: D[order[-1]][j])
    order.append(nxt)
    left.remove(nxt)

def length(o):
    return sum(D[o[i]][o[(i + 1) % len(o)]] for i in range(len(o)))

better = True
while better:
    better = False
    for i in range(1, len(order) - 1):
        for j in range(i + 1, len(order)):
            new = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
            if length(new) < length(order):
                order, better = new, True
print('Lengte rondje:', length(order), 'tegels')

# Pad tussen de plekken met tussenpunten.
wps = []
nr = 0
for idx in range(len(order)):
    a, b = pts[order[idx]], pts[order[(idx + 1) % len(order)]]
    _, prev = info[a]
    path = []
    k = b
    while k is not None:
        path.append(k)
        k = prev[k]
    path.reverse()   # van a naar b
    if order[idx] != 0:
        nr += 1
        wps.append({'type': 'walk', 'x': a[0], 'y': a[1], 'z': Z, 'label': 'spawn %d' % nr})
    else:
        wps.append({'type': 'walk', 'x': a[0], 'y': a[1], 'z': Z, 'label': 'start'})
    for i in range(STAP, len(path) - 3, STAP):
        wps.append({'type': 'walk', 'x': path[i][0], 'y': path[i][1], 'z': Z})

route = {'name': naam, 'waypoints': wps}
with open('data/routes/%s.json' % naam, 'w') as f:
    json.dump(route, f, indent=1)
print('Route', naam, 'met', len(wps), 'waypoints opgeslagen.')

# Tekening voor controle (tekst): # = begaanbaar, S = plek, . = tussenpunt, X = gat/trap.
xs = [k[0] for k in walk]; ys = [k[1] for k in walk]
sp = {(w['x'], w['y']) for w in wps if 'label' in w}
tp = {(w['x'], w['y']) for w in wps if 'label' not in w}
with open('data/routes/%s.txt' % naam, 'w') as f:
    for y in range(min(ys), max(ys) + 1):
        row = ''
        for x in range(min(xs), max(xs) + 1):
            k = (x, y)
            row += 'S' if k in sp else '.' if k in tp else 'X' if k in blocked else '#' if k in area else ('-' if k in walk else ' ')
        f.write(row.rstrip() + '\n')
