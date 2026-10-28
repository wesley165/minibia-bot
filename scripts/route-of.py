#!/usr/bin/env python3
# Rondje Orc Fortress: verdieping 7 (begane grond) en 6 (+1) om en om.
# Plekken = waar vandaag het meest gedood is en waar sterke orcs spawnden.
# 7: van de aankomst (onder het gat) langs de drukke plekken naar de ladder omhoog.
# 6: van de ladder langs de drukke plekken naar het gat omlaag. Dan weer 7.
# Gebruik (in /home/minibia/bot): python3 scripts/route-of.py [routenaam]
import collections, json, sys
from collections import deque

NAAM = sys.argv[1] if len(sys.argv) > 1 else 'john-of-0-1'
STAP = 6
MIN_SCORE = {7: 7, 6: 3}   # zoveel kills/spawns in een vak van 8x8 tegels = een plek
LADDER_OP = (32959, 31751)   # ladder op 7 (use) -> 6
GAT_OMLAAG = (32959, 31751)  # gat boven de ladder op 6 -> terug naar 7
KAART = {7: 'data/verken-32821-31770-7.json', 6: 'data/verken-32889-31793-6.json'}
GEBIED = (32860, 31690, 32990, 31815)   # alleen de fortress en de directe omgeving


# Alleen binnen de muren blijven (per verdieping een vak). Verdieping 6 = de muren zelf.
BINNEN = {7: (32890, 31749, 32977, 31805)}


def laad(z):
    d = json.load(open(KAART[z]))
    blocked = {tuple(k) for k in d['blocked']}
    walk = {tuple(k) for k in d['walk']} - blocked
    if z in BINNEN:
        b = BINNEN[z]
        walk = {k for k in walk if b[0] <= k[0] <= b[2] and b[1] <= k[1] <= b[3]}
    near = {(x + a, y + b) for (x, y) in blocked for a in (-1, 0, 1) for b in (-1, 0, 1)}
    return walk - near


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
    p, k = [], b
    while k is not None:
        p.append(k)
        k = prev[k]
    return p[::-1]


def dichtst(p, W):
    return min(W, key=lambda k: (max(abs(k[0] - p[0]), abs(k[1] - p[1])), abs(k[0] - p[0]) + abs(k[1] - p[1])))


# Score per vak van 8x8: kills van vandaag + spawns van sterke orcs (dubbel).
score = collections.Counter()
for l in open('data/kills.jsonl'):
    k = json.loads(l)
    if k['time'] > 1793190000000 and k['z'] in KAART and GEBIED[0] <= k['x'] <= GEBIED[2] and GEBIED[1] <= k['y'] <= GEBIED[3] \
            and k['name'] not in ('Pig', 'Chicken', 'Deer', 'Bug'):
        score[(k['z'], k['x'] // 8, k['y'] // 8)] += 1
try:
    for l in open('data/spawns.jsonl'):
        s = json.loads(l)
        if s['z'] in KAART:
            score[(s['z'], s['x'] // 8, s['y'] // 8)] += 2
except FileNotFoundError:
    pass

route = []
for z, start, eind, overgang in ((7, GAT_OMLAAG, LADDER_OP, 'ladder'), (6, LADDER_OP, GAT_OMLAAG, 'gat')):
    W = laad(z)
    s0 = dichtst(start, W)
    e0 = dichtst(eind, W)
    bereik = bfs(s0, W)[0]
    plekken = []
    if z == 6:
        # Verdieping 6: weinig data, dus alles wat bereikbaar is dekken (plekken binnen 5 tegels).
        todo = set(bereik)
        while todo:
            best = max(bereik, key=lambda k: sum(1 for t in todo if max(abs(t[0] - k[0]), abs(t[1] - k[1])) <= 5))
            gain = {t for t in todo if max(abs(t[0] - best[0]), abs(t[1] - best[1])) <= 5}
            if len(gain) < 6:
                break
            plekken.append((best, len(gain)))
            todo -= gain
    for (zz, cx, cy), n in ([] if z == 6 else score.items()):
        if zz != z or n < MIN_SCORE[z]:
            continue
        midden = (cx * 8 + 4, cy * 8 + 4)
        cand = [t for t in bereik if max(abs(t[0] - midden[0]), abs(t[1] - midden[1])) <= 4]
        if cand:
            plekken.append((dichtst(midden, cand), n))
    # Volgorde: steeds de dichtstbijzijnde (looptegels), eindigen bij de overgang.
    volg, cur, rest = [], s0, {p for p, _ in plekken}
    while rest:
        d, _ = bfs(cur, W)
        nxt = min(rest, key=lambda k: d.get(k, 10 ** 6))
        volg.append(nxt)
        rest.discard(nxt)
        cur = nxt
    cur, lengte = s0, 0
    for i, pl in enumerate(volg + [e0]):
        p = pad(cur, pl, W)
        lengte += len(p)
        w = [{'type': 'walk', 'x': x, 'y': y, 'z': z} for j, (x, y) in enumerate(p) if j and (j % STAP == 0 or j == len(p) - 1)]
        if w and i < len(volg):
            w[-1]['label'] = 'spawn %d-%d' % (z, i + 1)
        route += w
        cur = pl
    if overgang == 'ladder':
        route.append({'type': 'use', 'x': eind[0], 'y': eind[1], 'z': z, 'label': 'ladder omhoog'})
    else:
        route.append({'type': 'floor', 'x': eind[0], 'y': eind[1], 'z': z, 'label': 'gat omlaag'})
    print('Verdieping %d: %d plekken, ongeveer %d tegels lopen' % (z, len(volg), lengte))

json.dump({'name': NAAM, 'waypoints': route}, open('data/routes/%s.json' % NAAM, 'w'), indent=1)
print('Route %s: %d waypoints.' % (NAAM, len(route)))
