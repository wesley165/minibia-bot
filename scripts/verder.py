#!/usr/bin/env python3
# Verder ontdekken over verdiepingen: deze verdieping verkennen, en als er niets
# nieuws meer is een ladder of trap/ramp OMHOOG nemen en daar verder gaan.
# Gebruik (in /home/minibia/bot): WJ_ADMIN=$(cat data/admin-token) python3 scripts/verder.py [max_verdiepingen]
# VAK en RICHTING (env) worden doorgegeven aan verken.py.
import glob, json, os, subprocess, sys, time, urllib.request

API = 'http://127.0.0.1:3100'
ADMIN = os.environ.get('WJ_ADMIN', '')
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 3
GEBRUIKT = 'data/verder-gebruikt.json'


def call(path, data=None, method=None):
    req = urllib.request.Request(API + path, data=json.dumps(data).encode() if data is not None else None,
                                 method=method or ('POST' if data is not None else 'GET'),
                                 headers={'Content-Type': 'application/json', 'X-WJ-Admin': ADMIN})
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def pos():
    p = call('/api/status').get('player') or {}
    return p.get('x'), p.get('y'), p.get('z')


def kaart(z):
    files = [f for f in glob.glob('data/verken-*-%d.json' % z) if '.bak' not in f and 'voor-check' not in f]
    return max(files, key=os.path.getsize) if files else None


def gebruikt():
    try:
        return {tuple(k) for k in json.load(open(GEBRUIKT))}
    except Exception:
        return set()


def omhoog(z):
    """Neem de dichtstbijzijnde nog niet gebruikte ladder of trap omhoog."""
    k = kaart(z)
    d = json.load(open(k)) if k else {}
    x, y, _ = pos()
    al = gebruikt()
    kandidaten = [('ladder', tuple(t)) for t in d.get('ladders', [])] + [('trap', tuple(t)) for t in d.get('omhoog', [])]
    kandidaten = [c for c in kandidaten if (c[1][0], c[1][1], z) not in al]
    kandidaten.sort(key=lambda c: max(abs(c[1][0] - x), abs(c[1][1] - y)))
    walk = {tuple(t) for t in d.get('walk', [])}
    for soort, (tx, ty) in kandidaten[:4]:
        log('Omhoog via', soort, 'bij', (tx, ty))
        al.add((tx, ty, z))
        json.dump([list(t) for t in al], open(GEBRUIKT, 'w'))
        if soort == 'ladder':
            naast = min([(tx + a, ty + b) for a in (-1, 0, 1) for b in (-1, 0, 1) if (a or b) and (tx + a, ty + b) in walk] or [(tx, ty + 1)],
                        key=lambda t: max(abs(t[0] - x), abs(t[1] - y)))
            wps = [{'type': 'walk', 'x': naast[0], 'y': naast[1], 'z': z}, {'type': 'use', 'x': tx, 'y': ty, 'z': z, 'label': 'ladder omhoog'}]
        else:
            wps = [{'type': 'floor', 'x': tx, 'y': ty, 'z': z, 'label': 'trap omhoog'}]
        call('/api/routes/verder-tmp', {'waypoints': wps}, 'PUT')
        cfg = call('/api/config')
        cfg['routeName'] = 'verder-tmp'
        call('/api/config', cfg, 'PUT')
        call('/api/command', {'name': 'start', 'args': {}})
        for _ in range(40):
            time.sleep(1.5)
            nz = pos()[2]
            if nz is not None and nz < z:
                call('/api/command', {'name': 'stop', 'args': {}})
                time.sleep(1)
                log('Gelukt: nu op verdieping', nz)
                return True
        call('/api/command', {'name': 'stop', 'args': {}})
    return False


for ronde in range(MAX):
    z = pos()[2]
    if z is None:
        log('Positie onbekend. Stop.')
        break
    k = kaart(z)
    args = ['python3', 'scripts/verken.py', '15', '200', k or '']
    if os.environ.get('RICHTING'):
        args.append(os.environ['RICHTING'])
    if ronde == 0 and os.environ.get('EERSTE_OVERSLAAN') == '1':
        log('Verdieping', z, ': al bekend, meteen omhoog')
    else:
        log('Verdieping', z, ': verkennen', '(kaart ' + k + ')' if k else '(nieuwe kaart)')
        subprocess.run(args, check=False)
    z = pos()[2]
    if ronde == MAX - 1:
        break
    if not omhoog(z):
        log('Geen ladder of trap omhoog meer op verdieping', z, '. Klaar.')
        break
log('Klaar met ontdekken.')
