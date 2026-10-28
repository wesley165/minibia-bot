#!/usr/bin/env python3
# Rondje Orc Fortress over 7, 6, 5 en weer 6:
#  A. 7 binnen de muren: drukke plekken, dan ladder omhoog (32959,31751).
#  B. 6 deel 1 (noordoost, midden, west): alles dekken, dan ladder omhoog (32893,31767).
#  C. 5 (zolder): naar het luik aan de andere kant (32892,31776).
#  D. 6 deel 2 (zuidwest): alles dekken, dan gat omlaag (32890,31793) en weer A.
# Gebruik (in /home/minibia/bot): python3 scripts/route-of-rond.py [routenaam]
import collections, json, sys
from collections import deque

NAAM = sys.argv[1] if len(sys.argv) > 1 else 'john-of-rond'
STAP = 6
K7, K6, K5 = 'data/verken-32821-31770-7.json', 'data/verken-32889-31793-6.json', 'data/verken-32893-31768-5.json'
BINNEN7 = (32890, 31749, 32977, 31805)
EXTRA = {6: {(32891, 31766), (32892, 31766)}}   # hier liep John wel, maar de kaart mist ze


def laad(f, z, box=None, veilig=True):
    d = json.load(open(f))
    blocked = {tuple(k) for k in d['blocked']}
    walk = ({tuple(k) for k in d['walk']} | {tuple(k) for k in d.get('trail', [])} | EXTRA.get(z, set())) - blocked
    if box:
        walk = {k for k in walk if box[0] <= k[0] <= box[2] and box[1] <= k[1] <= box[3]}
    if veilig:
        near = {(x + a, y + b) for (x, y) in blocked for a in (-1, 0, 1) for b in (-1, 0, 1)}
        walk -= near
    return walk


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


def dekking(bereik, r=5, min_gain=6):
    todo, plekken = set(bereik), []
    while todo:
        best = max(bereik, key=lambda k: sum(1 for t in todo if max(abs(t[0] - k[0]), abs(t[1] - k[1])) <= r))
        gain = {t for t in todo if max(abs(t[0] - best[0]), abs(t[1] - best[1])) <= r}
        if len(gain) < min_gain:
            break
        plekken.append(best)
        todo -= gain
    return plekken


def stuk(z, W, start, eind, plekken, label, vast=False):
    s0, e0 = dichtst(start, W), dichtst(eind, W)
    volg, cur, rest = ([p for p in plekken] if vast else []), s0, (set() if vast else set(plekken))
    while rest:
        d, _ = bfs(cur, W)
        nxt = min(rest, key=lambda k: d.get(k, 10 ** 6))
        if nxt not in d:
            break
        volg.append(nxt)
        rest.discard(nxt)
        cur = nxt
    # 2-opt: volgorde verbeteren met vaste begin- en eindpunten (kortste rondje, geen kruisingen).
    if not vast and len(volg) > 2:
        knopen = [s0] + volg + [e0]
        dist = {k: bfs(k, W)[0] for k in knopen}
        D = lambda a, b: dist[a].get(b, 10 ** 6)
        beter = True
        while beter:
            beter = False
            for i in range(1, len(knopen) - 2):
                for j in range(i + 1, len(knopen) - 1):
                    a, b, c, d = knopen[i - 1], knopen[i], knopen[j], knopen[j + 1]
                    if D(a, c) + D(b, d) < D(a, b) + D(c, d) - 0.5:
                        knopen[i:j + 1] = knopen[i:j + 1][::-1]
                        beter = True
        volg = knopen[1:-1]
    wps, cur, lengte = [], s0, 0
    for i, pl in enumerate(volg + [e0]):
        p = pad(cur, pl, W)
        lengte += len(p)
        w = [{'type': 'walk', 'x': x, 'y': y, 'z': z} for j, (x, y) in enumerate(p) if j and (j % STAP == 0 or j == len(p) - 1)]
        if w and i < len(volg):
            w[-1]['label'] = 'spawn %s-%d' % (label, i + 1)
        wps += w
        cur = pl
    print('%s: %d plekken, ongeveer %d tegels' % (label, len(volg), lengte))
    return wps


# Drukke plekken op 7 (kills van vandaag + spawns).
score = collections.Counter()
for l in open('data/kills.jsonl'):
    k = json.loads(l)
    if k['time'] > 1793190000000 and k['z'] == 7 and k['name'] not in ('Pig', 'Chicken', 'Deer', 'Bug', 'Snake'):
        score[(k['x'] // 8, k['y'] // 8)] += 1
for l in open('data/spawns.jsonl'):
    s = json.loads(l)
    if s['z'] == 7:
        score[(s['x'] // 8, s['y'] // 8)] += 2

route = []
# A. Verdieping 7
W7 = laad(K7, 7, BINNEN7)
START7 = (32975, 31803)   # onder het gat in het zuidoosten van verdieping 6
b7 = bfs(dichtst(START7, W7), W7)[0]
pl7 = []
for (cx, cy), n in score.items():
    if n >= 7:
        cand = [t for t in b7 if max(abs(t[0] - (cx * 8 + 4)), abs(t[1] - (cy * 8 + 4))) <= 4]
        if cand:
            pl7.append(dichtst((cx * 8 + 4, cy * 8 + 4), cand))
# Rond de binnenplaats: vanaf het zuidoosten met de klok mee (zuid -> west -> noord -> noordoost).
import math
MID = (32933, 31777)
def hoek(p):
    a = math.atan2(p[1] - MID[1], p[0] - MID[0])   # 0 = oost, + = zuid
    h = (a - math.atan2(START7[1] - MID[1], START7[0] - MID[0])) % (2 * math.pi)
    return h
pl7.sort(key=hoek)
route += stuk(7, W7, START7, (32959, 31752), pl7, '7', vast=True)
route.append({'type': 'use', 'x': 32959, 'y': 31751, 'z': 7, 'label': 'ladder omhoog'})
# B. Verdieping 6, deel 1
W6 = laad(K6, 6)
W6r = laad(K6, 6, veilig=False)
r1 = set(bfs(dichtst((32958, 31750), W6r), W6r)[0])
W6a = W6r & r1
route += stuk(6, W6a, (32958, 31750), (32892, 31766), dekking(W6 & r1), '6a')
route.append({'type': 'use', 'x': 32893, 'y': 31767, 'z': 6, 'label': 'ladder omhoog'})
# C. Verdieping 5: naar het luik aan de andere kant
W5 = laad(K5, 5, veilig=False)
route += stuk(5, W5, (32893, 31768), (32892, 31775), [], '5')
route.append({'type': 'floor', 'x': 32892, 'y': 31776, 'z': 5, 'label': 'luik omlaag'})
# D. Verdieping 6, deel 2
r2 = set(bfs(dichtst((32892, 31777), W6r), W6r)[0])
W6b = W6r & r2
route += stuk(6, W6b, (32892, 31777), (32975, 31802), dekking(W6 & r2, min_gain=4), '6b')
route.append({'type': 'floor', 'x': 32976, 'y': 31802, 'z': 6, 'label': 'gat omlaag'})

json.dump({'name': NAAM, 'waypoints': route}, open('data/routes/%s.json' % NAAM, 'w'), indent=1)
print('Route %s: %d waypoints.' % (NAAM, len(route)))
