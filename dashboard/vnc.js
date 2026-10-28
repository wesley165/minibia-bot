(function () {
  'use strict';

  // Live beeld (noVNC) via het dashboard zelf, zonder tunnel.
  // Staat het uit, dan zet een klik op Live beeld het eerst aan en opent het daarna.
  // "Live uit" zet het weer uit: dat scheelt zo'n 30% rekenkracht op de VPS.
  var link = document.getElementById('btnVnc');
  var off = document.getElementById('btnVncOff');
  if (!link || !off) return;

  var on = false;

  function api(method, body) {
    return fetch('/api/vnc', {
      method: method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json(); });
  }

  function render() {
    off.hidden = !on;
    link.textContent = on ? 'Live beeld' : 'Live beeld (uit)';
    link.title = on ? 'Live beeld openen' : 'Live beeld aanzetten en openen';
  }

  function check() {
    api('GET').then(function (d) { on = !!(d && d.aan); render(); }).catch(function () {});
  }

  // Wachten tot noVNC luistert, dan pas openen.
  function waitOn(win, tries) {
    api('GET').then(function (d) {
      if (d && d.aan) {
        on = true; render();
        if (win) win.location.href = link.href;
        return;
      }
      if (tries > 0) setTimeout(function () { waitOn(win, tries - 1); }, 1000);
      else { render(); if (win) win.close(); window.alert('Live beeld start niet. Probeer het zo nog eens.'); }
    }).catch(function () { if (tries > 0) setTimeout(function () { waitOn(win, tries - 1); }, 1000); });
  }

  link.addEventListener('click', function (e) {
    if (on) return; // gewoon openen
    e.preventDefault();
    // Venster meteen openen (anders blokkeert de browser het), daarna de goede pagina laden.
    var win = window.open('about:blank', '_blank');
    link.textContent = 'Live beeld start...';
    api('POST', { aan: true }).then(function () { waitOn(win, 20); }).catch(function () { render(); });
  });

  off.addEventListener('click', function () {
    off.disabled = true;
    api('POST', { aan: false }).then(function () {
      setTimeout(function () { off.disabled = false; check(); }, 2500);
    }).catch(function () { off.disabled = false; });
  });

  check();
  setInterval(check, 30000);
})();
