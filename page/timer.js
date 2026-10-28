(function (B) {
  'use strict';

  // Timer die ook doorloopt als het tabblad op de achtergrond staat.
  // Chrome remt setInterval in verborgen tabbladen af tot één keer per minuut.
  // Een Web Worker wordt veel minder afgeremd. Het spel doet dit zelf ook
  // (gameClient.__bgTickWorker). Lukt een worker niet, dan gewoon setInterval.
  if (B.every) return;

  var nextId = 1;
  var handlers = {};   // id -> functie
  var intervals = {};  // id -> ms
  var fallback = {};   // id -> setInterval-id na terugval
  var worker = null;
  var gotTick = false;

  // Terugvallen op gewone timers (bijv. als de site workers blokkeert).
  function fallBack() {
    if (!worker) return;
    try { worker.terminate(); } catch (e) { /* niets */ }
    worker = null;
    B.timerMode = 'gewoon';
    Object.keys(handlers).forEach(function (id) {
      fallback[id] = setInterval(handlers[id], intervals[id]);
    });
  }

  try {
    var src = 'var t={};onmessage=function(e){var d=e.data;' +
      'if(d.cmd==="start"){t[d.id]=setInterval(function(){postMessage(d.id)},d.ms);}' +
      'else if(d.cmd==="stop"){clearInterval(t[d.id]);delete t[d.id];}};';
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onerror = fallBack;
    worker.onmessage = function (e) {
      gotTick = true;
      var fn = handlers[e.data];
      if (fn) { try { fn(); } catch (err) { /* volgende keer weer */ } }
    };
  } catch (e) {
    worker = null;
  }
  // Geen enkele tik binnen 2 seconden: worker werkt niet, dus terugvallen.
  setTimeout(function () { if (worker && !gotTick) fallBack(); }, 2000);

  // every(fn, ms) geeft een id terug. stopEvery(id) stopt hem.
  B.every = function (fn, ms) {
    var id = nextId++;
    handlers[id] = fn;
    intervals[id] = ms;
    if (worker) {
      worker.postMessage({ cmd: 'start', id: id, ms: ms });
      return { worker: true, id: id };
    }
    fallback[id] = setInterval(fn, ms);
    return { worker: true, id: id };
  };

  B.stopEvery = function (h) {
    if (!h) return;
    delete handlers[h.id];
    delete intervals[h.id];
    if (fallback[h.id]) { clearInterval(fallback[h.id]); delete fallback[h.id]; }
    if (worker) worker.postMessage({ cmd: 'stop', id: h.id });
  };

  B.timerMode = worker ? 'worker' : 'gewoon';
})(window.WJBot = window.WJBot || {});
