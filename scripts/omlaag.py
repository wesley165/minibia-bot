#!/usr/bin/env python3
# Naar een lagere verdieping lopen: op elke verdieping verkennen tot er een trap
# of gat omlaag in beeld is ([floorchange=down]), erop stappen, en herhalen.
# Gebruik (op de VPS, in /home/minibia/bot):
#   WJ_ADMIN=$(cat data/admin-token) python3 scripts/omlaag.py <doelverdieping> [route-daarna]
# Trappen met floorchange=north/south/east/west gaan omhoog; die slaat hij over.
import glob, json, os, subprocess, sys, time, urllib.request

API = os.environ.get('WJ_API', 'http://127.0.0.1:3100')
ADMIN = os.environ.get('WJ_ADMIN', '')
DOEL = int(sys.argv[1]) if len(sys.argv) > 1 else 11
ROUTE = sys.argv[2] if len(sys.argv) > 2 else ''


def call(path, data=None, method=None):
    req = urllib.request.Request(API + path, data=json.dumps(data).encode() if data is not None else None,
                                 method=method or ('POST' if data is not None else 'GET'),
                                 headers=dict({'Content-Type': 'application/json'}, **({'X-WJ-Admin': ADMIN} if ADMIN else {})))
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def pos():
    p = call('/api/status').get('player') or {}
    return p.get('x'), p.get('y'), p.get('z')


def kaart(z):
    # Grootste bestaande verken-kaart van deze verdieping, zodat hij verder gaat waar hij was.
    files = [f for f in glob.glob('data/verken-*-%d.json' % z) if '.bak' not in f and 'voor-check' not in f]
    return max(files, key=os.path.getsize) if files else None


def stap_omlaag(z):
    x, y, _ = pos()
    if os.path.exists('data/trap-omlaag.json'):
        os.remove('data/trap-omlaag.json')
    args = ['python3', 'scripts/verken.py', '15', os.environ.get('BEREIK', '160')]
    k = kaart(z)
    args.append(k or '')
    # RICHTING (bijv. west of punt:x,y): die kant eerst verkennen. Alleen voor de eerste verdieping.
    r = os.environ.get('RICHTING_%d' % z) or (os.environ.get('RICHTING') if z == START_Z else '')
    if r:
        args.append(r)
    log('Verdieping', z, ': verkennen tot er een trap omlaag is', '(kaart ' + k + ')' if k else '')
    subprocess.run(args, env=dict(os.environ, ZOEK_OMLAAG='1'), check=False)
    try:
        gevonden = json.load(open('data/trap-omlaag.json'))
    except Exception:
        gevonden = {'tegels': []}
    tegels = [tuple(t) for t in gevonden.get('tegels', [])]
    if not tegels:
        log('Geen trap omlaag gevonden op verdieping', z)
        return False
    x, y, _ = pos()
    tegels.sort(key=lambda t: max(abs(t[0] - x), abs(t[1] - y)))
    for t in tegels[:4]:
        log('Op de trap stappen bij', t)
        for _ in range(3):
            call('/api/command', {'name': 'walkTo', 'args': {'x': t[0], 'y': t[1], 'z': z}})
            for _ in range(10):
                time.sleep(1.5)
                nz = pos()[2]
                if nz is not None and nz > z:
                    log('Gelukt: nu op verdieping', nz)
                    # De bot pauzeert bij een onverwachte verdieping; stoppen wist die pauze.
                    call('/api/command', {'name': 'stop', 'args': {}})
                    time.sleep(1)
                    return True
    return False


start = pos()
START_Z = start[2]
log('Start op', start, '| doel verdieping', DOEL)
for poging in range(8):
    z = pos()[2]
    if z is None:
        log('Positie onbekend (uitgelogd?). Stop.')
        sys.exit(1)
    if z >= DOEL:
        break
    if not stap_omlaag(z):
        log('Vast op verdieping', z, '. Stop.')
        sys.exit(1)
z = pos()[2]
if z != DOEL:
    log('Niet op verdieping', DOEL, 'maar op', z)
    sys.exit(1)
log('Aangekomen op verdieping', DOEL, 'bij', pos())
if ROUTE:
    cfg = call('/api/config')
    cfg['routeName'] = ROUTE
    call('/api/config', cfg, 'PUT')
    call('/api/command', {'name': 'start', 'args': {}})
    log('Route', ROUTE, 'actief en bot gestart. Hij loopt zelf naar het dichtstbijzijnde waypoint.')
