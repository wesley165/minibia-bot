(function (B) {
  'use strict';

  // Route opnemen: Wesley loopt zelf, de bot zet onderweg waypoints neer.
  // Elke `step` tegels een walk-waypoint. Bij een andere verdieping een
  // floor-waypoint op de laatste tegel van de oude verdieping, met de plek
  // waar je uitkwam (toX, toY, toZ). Zo kan de cavebot later over de trap lopen.

  // Dubbel geladen terwijl een opname loopt: de lopende opname laten staan.
  if (B.recorder && B.recorder.active()) return;

  var SAMPLE_MS = 50;
  var timer = null;
  var step = 4;
  var last = null;    // laatste gemeten positie
  var lastWp = null;  // laatste waypoint dat is neergezet

  function emitWp(wp) {
    if (B.engine && typeof B.engine.emit === 'function') B.engine.emit('recordWaypoint', { waypoint: wp });
    else if (typeof window.wjEmit === 'function') window.wjEmit('recordWaypoint', { waypoint: wp });
  }

  function pos() {
    var p = B.api && B.api.player();
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }

  function addWalk(p) {
    lastWp = { x: p.x, y: p.y, z: p.z };
    emitWp({ type: 'walk', x: p.x, y: p.y, z: p.z });
  }

  function sample() {
    try {
      var p = pos();
      if (!p) return;
      if (!last) { last = p; addWalk(p); return; }
      if (p.z !== last.z) {
        // Van verdieping gewisseld: trap, gat, ladder of touw.
        emitWp({ type: 'floor', x: last.x, y: last.y, z: last.z, toX: p.x, toY: p.y, toZ: p.z });
        addWalk(p);
      } else if (!lastWp || lastWp.z !== p.z ||
          Math.max(Math.abs(p.x - lastWp.x), Math.abs(p.y - lastWp.y)) >= step) {
        addWalk(p);
      }
      last = p;
    } catch (e) { /* volgende meting opnieuw */ }
  }

  B.recorder = {
    start: function (opts) {
      if (timer) return { ok: true, recording: true };
      var s = Number(opts && opts.step);
      step = s >= 1 && s <= 20 ? Math.floor(s) : 4;
      last = null;
      lastWp = null;
      timer = B.every ? B.every(sample, SAMPLE_MS) : setInterval(sample, SAMPLE_MS);
      sample();
      return { ok: true, recording: true, step: step };
    },
    stop: function () {
      if (!timer) return { ok: true, recording: false };
      if (B.stopEvery && timer && typeof timer === 'object') B.stopEvery(timer); else clearInterval(timer);
      timer = null;
      // Eindpunt altijd vastleggen.
      var p = pos();
      if (p && (!lastWp || lastWp.x !== p.x || lastWp.y !== p.y || lastWp.z !== p.z)) addWalk(p);
      return { ok: true, recording: false };
    },
    active: function () { return !!timer; }
  };
})(window.WJBot = window.WJBot || {});
