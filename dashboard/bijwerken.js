(function () {
  'use strict';

  // Knop Bijwerken: haalt de nieuwste versie van GitHub op de VPS binnen.
  // De server legt een verzoek neer; een dienst op de VPS voert scripts/van-github.sh uit.
  var btn = document.getElementById('btnBijwerken');
  var msg = document.getElementById('bijwerkMsg');
  if (!btn || !msg) return;

  var timer = null;

  function show(text) { msg.textContent = text || ''; }

  function poll(until) {
    clearTimeout(timer);
    fetch('/api/update-from-github', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var st = d && d.status;
        if (d && d.pending) show('Bijwerken staat klaar...');
        else if (st && st.tekst) show(st.tekst);
        var done = st && (st.stap === 'klaar' || st.stap === 'mislukt') && !d.pending;
        if (done) {
          btn.disabled = false;
          // Melding na een minuut weer weg.
          setTimeout(function () { if (msg.textContent === st.tekst) show(''); }, 60000);
          if (st.stap === 'klaar') setTimeout(function () { window.location.reload(); }, 3000);
          return;
        }
        if (Date.now() < until) timer = setTimeout(function () { poll(until); }, 3000);
        else { btn.disabled = false; show('Geen antwoord van de bijwerking. Kijk op de VPS.'); }
      })
      .catch(function () {
        if (Date.now() < until) timer = setTimeout(function () { poll(until); }, 3000);
      });
  }

  btn.addEventListener('click', function () {
    if (!window.confirm('De nieuwste versie van GitHub direct op de VPS zetten?')) return;
    btn.disabled = true;
    show('Bijwerken wordt aangevraagd...');
    fetch('/api/update-from-github', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d || x.d.ok === false) {
          btn.disabled = false;
          show((x.d && x.d.error) || 'Bijwerken lukte niet.');
          return;
        }
        poll(Date.now() + 4 * 60 * 1000);
      })
      .catch(function () { btn.disabled = false; show('Bijwerken lukte niet: geen verbinding met de server.'); });
  });
})();
