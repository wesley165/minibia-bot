#!/usr/bin/env python3
# Rondje over 8, 9, 10, 11 zonder dubbel lopen: per verdieping (8, 9, 10) een ring langs
# alle plekken die door de trap van boven (A) en de trap naar beneden (B) gaat. Omlaag de
# helft A->B, op de terugweg de andere helft B->A. Verdieping 11: het bestaande rondje.
# Gebruik (in /home/minibia/bot): python3 scripts/route-ring.py [routenaam]
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('m', 'scripts/route-meer-verdiepingen.py')
src = open('scripts/route-meer-verdiepingen.py').read().split('\nroute = []')[0]
m = {}
exec(compile(src, 'm', 'exec'), m)
laad, bfs, pad, dichtst, walk_wps, PLAN, ONDERSTE, OMHOOG, R = m['laad'], m['bfs'], m['pad'], m['dichtst'], m['walk_wps'], m['PLAN'], m['ONDERSTE'], m['OMHOOG'], m['R']

NAAM = sys.argv[1] if len(sys.argv) > 1 else 'john-cyclopolis-ring'


def plekken_voor(z, safe, start):
    bereik = set(bfs(start, safe)[0])
    todo, pl = set(bereik), []
    while todo:
        best = max(bereik, key=lambda k: sum(1 for t in todo if max(abs(t[0] - k[0]), abs(t[1] - k[1])) <= R))
        gain = {t for t in todo if max(abs(t[0] - best[0]), abs(t[1] - best[1])) <= R}
        if len(gain) < 4:
            break
        pl.append(best)
        todo -= gain
    return pl


def ring(knopen, safe):
    # Rondje door alle knopen (begint bij knopen[0] = A), dichtstbijzijnde eerst, dan 2-opt.
    dist = {k: bfs(k, safe)[0] for k in knopen}
    D = lambda a, b: dist[a].get(b, 10 ** 6)
    tour, rest = [knopen[0]], set(knopen[1:])
    while rest:
        n = min(rest, key=lambda k: D(tour[-1], k))
        tour.append(n)
        rest.discard(n)
    beter = True
    while beter:
        beter = False
        for i in range(1, len(tour) - 1):
            for j in range(i + 1, len(tour)):
                a, b, c, d = tour[i - 1], tour[i], tour[j], tour[(j + 1) % len(tour)]
                if D(a, c) + D(b, d) < D(a, b) + D(c, d) - 0.5:
                    tour[i:j + 1] = tour[i:j + 1][::-1]
                    beter = True
    return tour


def loop(punten, z, safe, label):
    wps, n = [], 0
    for a, b in zip(punten, punten[1:]):
        w = walk_wps(pad(a, b, safe), z)
        if w and b not in (punten[0], punten[-1]):
            n += 1
            w[-1]['label'] = 'spawn %d-%s%d' % (z, label, n)
        wps += w
    return wps


omlaag, omhoog = [], []
for stuk in PLAN:
    z = stuk['z']
    walk, safe = laad(stuk['kaart'])
    A, B = dichtst(stuk['in'], safe), dichtst(stuk['omlaag'], safe)
    pl = [p for p in plekken_voor(z, safe, A) if p not in (A, B)]
    tour = ring([A] + pl + [B], safe)
    i = tour.index(B)
    heen = tour[:i + 1]                 # A -> B
    terug = tour[i:] + [A]              # B -> A
    omlaag.append(loop(heen, z, safe, 'a') + [{'type': 'floor', 'x': stuk['omlaag'][0], 'y': stuk['omlaag'][1], 'z': z, 'label': 'trap omlaag'}])
    # Terug: aankomst bij de trap omhoog van de verdieping eronder komt uit bij B; daarna naar A en de trap omhoog.
    up = loop(terug, z, safe, 'b')
    if z in OMHOOG:
        up.append({'type': 'floor', 'x': OMHOOG[z][0], 'y': OMHOOG[z][1], 'z': z, 'label': 'trap omhoog'})
    omhoog.append(up)
    print('Verdieping %d: %d plekken, omlaag %d, terug %d punten' % (z, len(pl), len(heen), len(terug)))

onder = json.load(open(ONDERSTE['route']))['waypoints']
ax, ay = ONDERSTE['in']
i0 = min(range(len(onder)), key=lambda i: max(abs(onder[i]['x'] - ax), abs(onder[i]['y'] - ay)))
rond = [dict(w) for w in onder[i0:] + onder[:i0] + [onder[i0]]]
rond.append({'type': 'floor', 'x': OMHOOG[11][0], 'y': OMHOOG[11][1], 'z': 11, 'label': 'trap omhoog'})

route = omlaag[0] + omlaag[1] + omlaag[2] + rond + omhoog[2] + omhoog[1] + omhoog[0]
json.dump({'name': NAAM, 'waypoints': route}, open('data/routes/%s.json' % NAAM, 'w'), indent=1)
pts = [(q['x'], q['y'], q['z']) for q in route]
dubbel = sum(1 for i, p in enumerate(pts) if any(q[2] == p[2] and max(abs(q[0] - p[0]), abs(q[1] - p[1])) <= 2 for q in pts[:max(0, i - 8)]))
print('Route %s: %d punten, waarvan %d vlak bij een eerder punt. Eerste %s, laatste %s' % (NAAM, len(route), dubbel, pts[0], pts[-1]))
