(function () {
  'use strict';
  // Uurgrafiek: HP, kills per 5 min en markeringen van het laatste uur
  var box = document.getElementById('hourChart');
  if (!box) return;
  var info = document.getElementById('hourChartInfo');
  var KEY = 'wj-hourchart';
  var HOUR = 60 * 60 * 1000;
  var BUCKET = 5 * 60 * 1000;
  var W = 600, H = 160, PAD = 14;
  var NS = 'http://www.w3.org/2000/svg';
  var samples = [], kills = [], marks = [];
  var lastSample = 0, lastDraw = 0, wasDead = false, timer = null;

  // Markeringen: kleur en symbool per soort
  var TYPES = {
    death: { color: 'var(--danger)', sym: '☠', label: 'Dood' },
    disconnect: { color: 'var(--warn)', sym: '✕', label: 'Verbinding weg' },
    gm: { color: 'var(--danger-dark)', sym: 'GM', label: 'GM' },
    player: { color: 'var(--muted)', sym: '●', label: 'Speler' },
    captcha: { color: 'var(--warn)', sym: '?', label: 'Captcha' }
  };

  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY) || '{}');
      samples = d.samples || []; kills = d.kills || []; marks = d.marks || [];
    } catch (e) { samples = []; kills = []; marks = []; }
    prune();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ samples: samples, kills: kills, marks: marks })); } catch (e) { /* negeren */ }
  }
  function prune() {
    var min = Date.now() - HOUR;
    samples = samples.filter(function (s) { return s.t >= min; });
    kills = kills.filter(function (t) { return t >= min; });
    marks = marks.filter(function (m) { return m.t >= min; });
  }
  function addMark(type, t) {
    var last = marks[marks.length - 1];
    // Dubbele meldingen vlak na elkaar samenvoegen
    for (var i = marks.length - 1; i >= 0 && i >= marks.length - 5; i--) {
      if (marks[i].type === type && Math.abs(marks[i].t - t) < 30000) return;
    }
    marks.push({ type: type, t: t });
  }

  function el(name, attrs, style) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (style) e.setAttribute('style', style);
    return e;
  }
  function html(tag, text, style) {
    var e = document.createElement(tag);
    if (text) e.textContent = text;
    if (style) e.setAttribute('style', style);
    return e;
  }

  function draw() {
    lastDraw = Date.now();
    prune();
    var now = lastDraw, start = now - HOUR;
    var x = function (t) { return ((t - start) / HOUR) * W; };
    var y = function (p) { return PAD + (1 - Math.max(0, Math.min(100, p)) / 100) * (H - 2 * PAD); };
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '160', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Grafiek van het laatste uur' }, 'display:block;width:100%;height:160px');

    // Kills per 5 minuten
    var buckets = {}, max = 0;
    kills.forEach(function (t) {
      var b = Math.floor((t - start) / BUCKET);
      buckets[b] = (buckets[b] || 0) + 1;
      if (buckets[b] > max) max = buckets[b];
    });
    for (var b in buckets) {
      var h = (buckets[b] / max) * (H - 2 * PAD);
      svg.appendChild(el('rect', { x: b * (W / 12) + 1, y: H - PAD - h, width: W / 12 - 2, height: h }, 'fill: var(--primary-soft)'));
    }

    // Markeringslijnen met symbool
    marks.forEach(function (m) {
      var T = TYPES[m.type]; if (!T) return;
      var mx = x(m.t);
      svg.appendChild(el('line', { x1: mx, x2: mx, y1: PAD, y2: H - PAD, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, 'stroke: ' + T.color));
    });

    // HP-lijn
    if (samples.length) {
      var pts = samples.map(function (s) { return x(s.t).toFixed(1) + ',' + y(s.hp).toFixed(1); }).join(' ');
      svg.appendChild(el('polyline', { points: pts, fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, 'stroke: var(--hp)'));
    }

    // Symbolen als HTML boven de grafiek, zodat tekst niet uitrekt
    var wrap = html('div', '', 'position:relative');
    wrap.appendChild(svg);
    marks.forEach(function (m) {
      var T = TYPES[m.type]; if (!T) return;
      var s = html('span', T.sym, 'position:absolute;top:0;transform:translateX(-50%);font-size:12px;line-height:1;color:' + T.color + ';left:' + ((m.t - start) / HOUR * 100).toFixed(2) + '%');
      s.title = T.label;
      wrap.appendChild(s);
    });

    var legend = html('div', '', 'display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;margin-top:4px');
    [['HP', 'var(--hp)', '━'], ['Kills per 5 min', 'var(--primary-soft)', '■'], ['Dood', TYPES.death.color, TYPES.death.sym],
     ['Verbinding weg', TYPES.disconnect.color, TYPES.disconnect.sym], ['GM', TYPES.gm.color, 'GM'], ['Speler', TYPES.player.color, TYPES.player.sym]
    ].forEach(function (l) {
      var i = html('span', '', 'white-space:nowrap');
      i.appendChild(html('span', l[2], 'color:' + l[1] + ';margin-right:4px'));
      i.appendChild(document.createTextNode(l[0]));
      legend.appendChild(i);
    });

    // Verdiepingsband: per stuk tijd op welke verdieping de bot was, met het nummer erin.
    var FLOOR_COLORS = ['var(--primary)', 'var(--ok)', 'var(--warn)', 'var(--mana)', 'var(--danger-dark)', 'var(--muted)'];
    var band = html('div', '', 'position:relative;height:20px;margin-top:4px;border-radius:4px;overflow:hidden;background:var(--bar-bg)');
    var segs = [];
    samples.forEach(function (sm, i) {
      if (sm.z == null) return;
      var end = i + 1 < samples.length ? samples[i + 1].t : now;
      var last = segs[segs.length - 1];
      if (last && last.z === sm.z && sm.t - last.end < 60000) last.end = end;
      else segs.push({ z: sm.z, start: sm.t, end: end });
    });
    segs.forEach(function (g) {
      var left = Math.max(0, (g.start - start) / HOUR * 100), width = Math.max(0.5, (g.end - Math.max(g.start, start)) / HOUR * 100);
      var seg = html('span', width > 4 ? String(g.z) : '', 'position:absolute;top:0;bottom:0;left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;' +
        'background:' + FLOOR_COLORS[((g.z % FLOOR_COLORS.length) + FLOOR_COLORS.length) % FLOOR_COLORS.length] + ';color:var(--card);font-size:12px;font-weight:600;line-height:20px;text-align:center;overflow:hidden;white-space:nowrap');
      seg.title = 'Verdieping ' + g.z;
      band.appendChild(seg);
    });
    var bandLabel = html('div', 'Verdieping', 'font-size:12px;color:var(--muted);margin-top:6px');

    var axis = html('div', '', 'display:flex;justify-content:space-between;font-size:12px;margin-top:2px');
    axis.appendChild(html('span', '60 min geleden'));
    axis.appendChild(html('span', 'nu'));

    box.textContent = '';
    box.appendChild(wrap); box.appendChild(bandLabel); box.appendChild(band); box.appendChild(axis); box.appendChild(legend);

    if (info) {
      if (!samples.length) { info.textContent = 'Nog geen gegevens'; return; }
      var low = Math.min.apply(null, samples.map(function (s) { return s.hp; }));
      var zNow = samples[samples.length - 1].z;
      info.textContent = 'Laagste HP ' + Math.round(low) + '% · ' + kills.length + ' kills' + (zNow != null ? ' · nu verdieping ' + zNow : '');
    }
  }

  function schedule() {
    if (timer) return;
    var wait = Math.max(0, 5000 - (Date.now() - lastDraw));
    timer = setTimeout(function () { timer = null; draw(); }, wait);
  }

  document.addEventListener('wj:status', function (ev) {
    var d = ev.detail || {}, p = d.player || {}, now = Date.now();
    if (typeof p.hpPct === 'number' && now - lastSample >= 10000) {
      lastSample = now;
      samples.push({ t: now, hp: p.hpPct, z: typeof p.z === 'number' ? p.z : null });
      save();
    }
    if (p.isDead && !wasDead) addMark('death', now);
    wasDead = !!p.isDead;
    if (d.playersNear && d.playersNear.length) addMark('player', now);
    schedule();
  });
  document.addEventListener('wj:kill', function () { kills.push(Date.now()); save(); schedule(); });
  document.addEventListener('wj:alert', function (ev) {
    var r = ev.detail && ev.detail.reason;
    if (TYPES[r]) { addMark(r, Date.now()); save(); schedule(); }
  });

  load();
  draw();
})();
