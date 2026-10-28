(function () {
  'use strict';

  // Knop Herstart: browser op de VPS opnieuw opstarten, inloggen en de bot starten.
  // De server legt een verzoek neer; een dienst op de VPS doet de rest. Hier volgen we de voortgang.
  var btn = document.getElementById('btnRestart');
  var msg = document.getElementById('restartMsg');
  if (!btn || !msg) return;

  var timer = null;

  function show(text) { msg.textContent = text || ''; }

  function poll(until) {
    clearTimeout(timer);
    fetch('/api/restart-browser', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var st = d && d.status;
        if (d && d.pending) show('Herstart staat klaar...');
        else if (st && st.tekst) show(st.tekst);
        var done = st && (st.stap === 'klaar' || st.stap === 'mislukt') && !d.pending;
        if (done) {
          btn.disabled = false;
          // Melding na een minuut weer weg.
          setTimeout(function () { if (msg.textContent === st.tekst) show(''); }, 60000);
          return;
        }
        if (Date.now() < until) timer = setTimeout(function () { poll(until); }, 3000);
        else { btn.disabled = false; show('Geen antwoord van de herstart. Kijk in het live beeld.'); }
      })
      .catch(function () {
        // Tijdens de herstart is de verbinding soms even weg: gewoon opnieuw proberen.
        if (Date.now() < until) timer = setTimeout(function () { poll(until); }, 3000);
      });
  }

  btn.addEventListener('click', function () {
    if (!window.confirm('Browser opnieuw opstarten, inloggen en de bot starten? Dit duurt ongeveer een minuut.')) return;
    btn.disabled = true;
    show('Herstart wordt aangevraagd...');
    fetch('/api/restart-browser', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d || x.d.ok === false) {
          btn.disabled = false;
          show((x.d && x.d.error) || 'Herstart lukte niet.');
          return;
        }
        poll(Date.now() + 4 * 60 * 1000);
      })
      .catch(function () { btn.disabled = false; show('Herstart lukte niet: geen verbinding met de server.'); });
  });
})();
