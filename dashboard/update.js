(function () {
  'use strict';

  // Knop Bijwerken: de nieuwste versie van de bot van GitHub installeren.
  // De server legt een verzoek neer; een dienst op de VPS doet de rest. Hier volgen we de voortgang.
  var btn = document.getElementById('btnUpdate');
  var msg = document.getElementById('updateMsg');
  if (!btn || !msg) return;

  var timer = null;

  function show(text) { msg.textContent = text || ''; }

  function poll(until) {
    clearTimeout(timer);
    fetch('/api/update-github', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var st = d && d.status;
        if (d && d.pending) show('Update staat klaar...');
        else if (st && st.tekst) show(st.tekst);
        var done = st && (st.stap === 'klaar' || st.stap === 'mislukt') && !d.pending;
        if (done) {
          btn.disabled = false;
          // Melding na een minuut weer weg.
          setTimeout(function () { if (msg.textContent === st.tekst) show(''); }, 60000);
          return;
        }
        if (Date.now() < until) timer = setTimeout(function () { poll(until); }, 3000);
        else { btn.disabled = false; show('Geen antwoord van de update. Kijk in het log.'); }
      })
      .catch(function () {
        // Tijdens de update (herstart server) is de verbinding soms even weg: gewoon opnieuw proberen.
        if (Date.now() < until) timer = setTimeout(function () { poll(until); }, 3000);
      });
  }

  btn.addEventListener('click', function () {
    if (!window.confirm('De nieuwste versie van GitHub installeren? De bot wacht eerst tot er geen monsters in de buurt zijn.')) return;
    btn.disabled = true;
    show('Update wordt aangevraagd...');
    fetch('/api/update-github', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d || x.d.ok === false) {
          btn.disabled = false;
          show((x.d && x.d.error) || 'Update lukte niet.');
          return;
        }
        poll(Date.now() + 8 * 60 * 1000);
      })
      .catch(function () { btn.disabled = false; show('Update lukte niet: geen verbinding met de server.'); });
  });
})();
