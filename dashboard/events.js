(function () {
  'use strict';

  var KEY = 'wj-recent-events';
  var MAX = 5;
  var MERGE_MS = 2 * 60 * 1000;
  var MAX_TEXT = 80;

  var list = document.getElementById('recentEvents');
  if (!list) return;

  var LABELS = {
    death: 'Dood',
    gm: 'GM',
    captcha: 'Anti-bot',
    disconnect: 'Verbinding',
    noway: 'Vast',
    floor: 'Verdieping',
    lowHp: 'HP laag',
    player: 'Speler',
    character: 'Karakter',
    restock: 'Voorraad',
    chat: 'Chat'
  };
  var LEVEL = {
    death: 'high', gm: 'high', captcha: 'high',
    disconnect: 'mid', noway: 'mid', floor: 'mid', lowHp: 'mid'
  };

  var events = load();

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (e) {
        return e && typeof e.reason === 'string' && typeof e.time === 'number';
      }).slice(0, MAX);
    } catch (err) {
      return [];
    }
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(events));
    } catch (err) { /* opslaan lukt niet, dat is ok */ }
  }

  function shorten(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (t.length <= MAX_TEXT) return t;
    return t.slice(0, MAX_TEXT - 1).replace(/\s+\S*$/, '').replace(/[.,;:\s]+$/, '') + '…';
  }

  function hhmm(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '--:--';
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function render() {
    list.textContent = '';
    if (!events.length) {
      var empty = document.createElement('li');
      empty.className = 're-empty';
      empty.textContent = 'Nog niets bijzonders.';
      list.appendChild(empty);
      return;
    }
    events.forEach(function (e) {
      var li = document.createElement('li');
      li.className = 're-item';

      var badge = document.createElement('span');
      badge.className = 're-badge re-' + (LEVEL[e.reason] || 'low');
      badge.textContent = LABELS[e.reason] || 'Melding';

      var time = document.createElement('span');
      time.className = 're-time';
      time.textContent = hhmm(e.time);

      var msg = document.createElement('span');
      msg.className = 're-text';
      msg.textContent = shorten(e.message) + (e.count > 1 ? ' (' + e.count + 'x)' : '');

      li.appendChild(badge);
      li.appendChild(time);
      li.appendChild(msg);
      list.appendChild(li);
    });
  }

  function sameKey(e, reason, time, message) {
    return e.reason === reason && e.time === time && e.message === message;
  }

  function add(detail) {
    if (!detail || !detail.reason) return;
    var reason = String(detail.reason);
    var time = Number(detail.time) || Date.now();
    var message = String(detail.message == null ? '' : detail.message);

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      // Dubbele melding (server speelt oude meldingen opnieuw af)
      if (sameKey(e, reason, time, message)) return;
      if (e.last && e.last.time === time && e.last.message === message && e.reason === reason) return;
    }

    var first = events[0];
    if (first && first.reason === reason && Math.abs(time - first.time) <= MERGE_MS) {
      first.count = (first.count || 1) + 1;
      first.last = { time: time, message: message };
      if (time > first.time) {
        first.time = time;
        first.message = message;
      }
    } else {
      events.unshift({ reason: reason, time: time, message: message, count: 1 });
      events.sort(function (a, b) { return b.time - a.time; });
      if (events.length > MAX) events.length = MAX;
    }
    save();
    render();
  }

  document.addEventListener('wj:alert', function (ev) {
    add(ev && ev.detail);
  });

  render();
})();
