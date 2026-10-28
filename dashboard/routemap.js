// Live routekaart: tekent de route en de positie van de speler in #routeMap.
(function () {
  'use strict';
  var box = document.getElementById('routeMap');
  if (!box) return;
  var info = document.getElementById('routeMapInfo');
  var NS = 'http://www.w3.org/2000/svg';

  var route = null;      // { name, waypoints }
  var routeName = null;  // naam waarvan we de route hebben
  var fetchedAt = 0;
  var fetching = false;
  var last = null;       // laatste status
  var lastDraw = 0;
  var timer = null;
  var tiles = null;      // { key, walk, blocked } kaart rond de route
  var tilesFetching = false;

  // Eenvoudige hulp om een SVG-element te maken
  function el(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function message(text) {
    box.textContent = '';
    var p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = text;
    box.appendChild(p);
    if (info) info.textContent = '';
  }

  // Route ophalen als de naam wijzigt of na 60 seconden
  function loadRoute(name) {
    if (fetching) return;
    fetching = true;
    fetch('/api/routes/' + encodeURIComponent(name), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && Array.isArray(data.waypoints)) { route = data; routeName = name; }
        fetchedAt = Date.now();
      })
      .catch(function () { fetchedAt = Date.now(); })
      .then(function () { fetching = false; schedule(); });
  }

  // Kaart (begaanbare tegels) ophalen voor dit vak op deze verdieping.
  function loadTiles(z, x0, y0, x1, y1) {
    var key = [z, x0, y0, x1, y1].join(',');
    if (tilesFetching || (tiles && tiles.key === key)) return;
    tilesFetching = true;
    fetch('/api/map?z=' + z + '&x0=' + x0 + '&y0=' + y0 + '&x1=' + x1 + '&y1=' + y1, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { tiles = { key: key, walk: (d && d.walk) || [], blocked: (d && d.blocked) || [] }; })
      .catch(function () { tiles = { key: key, walk: [], blocked: [] }; })
      .then(function () { tilesFetching = false; schedule(); });
  }

  // Tegels als één pad (snel, ook bij duizenden tegels).
  function tilePath(list) {
    var d = '';
    for (var i = 0; i < list.length; i++) d += 'M' + list[i][0] + ' ' + list[i][1] + 'h1v1h-1z';
    return d;
  }

  function draw() {
    var s = last;
    var p = s && s.player;
    if (!s || !s.routeName) return message('Geen route actief.');
    if (!p || typeof p.x !== 'number') return message('Positie nog niet bekend.');
    if (!route || routeName !== s.routeName) return message('Route wordt geladen...');

    var z = p.z;
    var idx = s.waypointIndex;
    // Alleen waypoints op de verdieping van de speler, met hun originele index
    var pts = [];
    route.waypoints.forEach(function (w, i) {
      if (w.z === z) pts.push({ x: w.x, y: w.y, i: i, label: String(w.label || '') });
    });
    if (!pts.length) return message('Geen waypoints op deze verdieping.');

    // Grenzen met ruimte eromheen, beeldverhouding blijft gelijk
    var xs = pts.map(function (q) { return q.x; }).concat(p.x);
    var ys = pts.map(function (q) { return q.y; }).concat(p.y);
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var pad = Math.max(6, (maxX - minX + maxY - minY) * 0.06);
    // Kaart van het vak rond de route (vaste stappen van 20, zodat hij niet steeds opnieuw laadt).
    var bx0 = Math.floor((minX - pad) / 20) * 20, by0 = Math.floor((minY - pad) / 20) * 20;
    var bx1 = Math.ceil((maxX + pad) / 20) * 20, by1 = Math.ceil((maxY + pad) / 20) * 20;
    loadTiles(z, bx0, by0, bx1, by1);
    var w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
    var r = Math.max(w, h) / 90; // dot-grootte schaalt mee

    var svg = el('svg', {
      viewBox: [minX - pad, minY - pad, w, h].join(' '),
      width: '100%', height: '320',
      preserveAspectRatio: 'xMidYMid meet', role: 'img'
    });

    // Kaart: begaanbare grond en trappen/gaten (uit de verken-kaarten).
    if (tiles && tiles.key === [z, bx0, by0, bx1, by1].join(',')) {
      if (tiles.walk.length) svg.appendChild(el('path', { d: tilePath(tiles.walk), transform: 'translate(-0.5 -0.5)', style: 'fill: var(--line-strong); opacity: 0.7; stroke: none' }));
      if (tiles.blocked.length) svg.appendChild(el('path', { d: tilePath(tiles.blocked), transform: 'translate(-0.5 -0.5)', style: 'fill: var(--warn); opacity: 0.8' }));
    }

    // Route als gesloten lijn
    var d = pts.map(function (q) { return q.x + ',' + q.y; }).join(' ');
    svg.appendChild(el('polygon', {
      points: d, fill: 'none', 'stroke-linejoin': 'round',
      style: 'stroke: var(--primary); opacity: 0.55; stroke-width: ' + (r * 0.6)
    }));

    // Waypoints
    pts.forEach(function (q) {
      var spawn = /^(spawn|start)/i.test(q.label);
      var cur = q.i === idx;
      var color = cur ? '--warn' : spawn ? '--primary' : '--muted';
      svg.appendChild(el('circle', {
        cx: q.x, cy: q.y, r: cur ? r * 2 : spawn ? r * 1.7 : r,
        style: 'fill: var(' + color + ')'
      }));
    });

    // Speler met rustige puls
    svg.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: r * 2.6, class: 'routemap-pulse',
      style: 'fill: var(--danger); opacity: 0.25'
    }));
    svg.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: r * 2.2,
      style: 'fill: var(--danger)'
    }));

    box.textContent = '';
    box.appendChild(svg);
    if (info) {
      var n = s.waypointCount || route.waypoints.length;
      info.textContent = 'Waypoint ' + (typeof idx === 'number' ? idx + 1 : '?') +
        ' van ' + n + ' · verdieping ' + z;
    }
  }

  // Maximaal 1 keer per seconde tekenen
  function schedule() {
    if (timer) return;
    var wait = Math.max(0, 1000 - (Date.now() - lastDraw));
    timer = setTimeout(function () {
      timer = null;
      lastDraw = Date.now();
      draw();
    }, wait);
  }

  document.addEventListener('wj:status', function (e) {
    last = e.detail || null;
    var name = last && last.routeName;
    if (name && (name !== routeName || Date.now() - fetchedAt > 60000)) loadRoute(name);
    schedule();
  });

  message('Wachten op status...');
})();
