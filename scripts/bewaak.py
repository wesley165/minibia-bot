#!/usr/bin/env python3
# Bewaker: meet elke 3 seconden de status, schrijft alles naar data/samples-<naam>.jsonl
# en print alleen regels waar iets mee moet (pauze, stop, lage HP, andere verdieping,
# dood, vastzitten). Elke 10 minuten een korte samenvatting.
# Meldt het als HP onder NOOD_HP komt (pauzeert niet).
import json, time, urllib.request
from collections import Counter

API = 'http://127.0.0.1:3100'
NOOD_HP = 40
SAMENVATTING_S = 600


def get(path):
    return json.loads(urllib.request.urlopen(API + path, timeout=8).read())


def cmd(name):
    req = urllib.request.Request(API + '/api/command', data=json.dumps({'name': name}).encode(),
                                 method='POST', headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


def say(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


last = {}
t_sum = time.time()
win = []          # samples in dit venster
same_pos = 0
while True:
    try:
        s = get('/api/status')
    except Exception as e:
        say('GEEN STATUS', e)
        time.sleep(10)
        continue
    p = s.get('player') or {}
    row = {'t': time.time(), 'state': s.get('state'), 'reason': s.get('pauseReason'), 'mode': s.get('mode'),
           'wp': s.get('waypointIndex'), 'x': p.get('x'), 'y': p.get('y'), 'z': p.get('z'), 'hp': p.get('hpPct'),
           'mp': p.get('manaPct'), 'kills': (s.get('stats') or {}).get('kills'), 'exp': s.get('experience'),
           'name': p.get('name'), 'near': [m.get('dist') for m in s.get('monstersNear') or []],
           'players': len(s.get('playersNear') or [])}
    win.append(row)
    try:
        with open('data/samples-%s.jsonl' % str(row['name'] or 'onbekend').replace(' ', '-').lower(), 'a') as f:
            f.write(json.dumps(row) + '\n')
    except Exception:
        pass

    if last:
        if row['state'] != last['state'] or row['reason'] != last['reason']:
            say('STATUS', last['state'], '->', row['state'], 'reden', row['reason'], 'op', (row['x'], row['y'], row['z']), 'hp', row['hp'])
        if row['z'] is not None and last['z'] is not None and row['z'] != last['z']:
            say('VERDIEPING', last['z'], '->', row['z'], 'op', (row['x'], row['y']))
        if p.get('isDead') and not last.get('dead'):
            say('DOOD op', (row['x'], row['y'], row['z']))
    row['dead'] = bool(p.get('isDead'))
    # Alleen melden, niet pauzeren: een gepauzeerde bot houdt geen afstand meer.
    if row['state'] == 'running' and (row['hp'] or 100) < NOOD_HP and (last.get('hp') or 100) >= NOOD_HP:
        say('LAGE HP', row['hp'], 'op', (row['x'], row['y'], row['z']), 'monsters', row['near'])
    # Vast: 40 s (13 metingen) op dezelfde plek tijdens lopen.
    if row['state'] == 'running' and last and (row['x'], row['y']) == (last.get('x'), last.get('y')) and row['mode'] == 'walking':
        same_pos += 1
        if same_pos == 13:
            say('VAST? 40 s stil tijdens lopen op', (row['x'], row['y'], row['z']), 'wp', row['wp'])
    else:
        same_pos = 0
    last = row

    if time.time() - t_sum >= SAMENVATTING_S and len(win) > 5:
        a, b = win[0], win[-1]
        mins = (b['t'] - a['t']) / 60
        kills = (b['kills'] or 0) - (a['kills'] or 0)
        exp = (b['exp'] or 0) - (a['exp'] or 0)
        modes = Counter(r['mode'] for r in win if r['state'] == 'running')
        tot = sum(modes.values()) or 1
        low = min((r['hp'] or 100) for r in win)
        say('SAMENVATTING %.0f min: %d kills (%.1f/min), %d exp (%d/u), laagste HP %s%%, %s' % (
            mins, kills, kills / max(mins, 0.1), exp, exp / max(mins, 0.1) * 60, low,
            ', '.join('%s %d%%' % (k, v * 100 // tot) for k, v in modes.most_common())))
        win = [win[-1]]
        t_sum = time.time()
    time.sleep(3)
