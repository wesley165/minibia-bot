(function () {
  'use strict';

  // Inlogpagina: eerste keer wachtwoord aanmaken, daarna inloggen.
  var $ = function (id) { return document.getElementById(id); };

  function msg(text, kind) {
    var el = $('loginMsg');
    el.textContent = text || '';
    el.className = 'login-msg' + (kind ? ' is-' + kind : '');
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 429) throw new Error('Te veel pogingen. Probeer het over een uur opnieuw.');
        if (!r.ok || d.ok === false) throw new Error(d.error || 'Er ging iets mis.');
        return d;
      });
    });
  }

  function busy(form, on) {
    Array.prototype.forEach.call(form.querySelectorAll('button, input'), function (el) { el.disabled = on; });
  }

  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.loggedIn) { location.replace('/'); return; }
      if (s.setup) { $('loginForm').hidden = false; $('loginPw').focus(); }
      else { $('setupForm').hidden = false; $('setupCode').focus(); }
    })
    .catch(function () { msg('Het dashboard is nu niet bereikbaar. Probeer het later opnieuw.', 'error'); });

  $('setupForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = $('setupPw').value;
    if (pw !== $('setupPw2').value) { msg('De twee wachtwoorden zijn niet gelijk.', 'error'); return; }
    if (pw.length < 6) { msg('Kies een wachtwoord van minimaal 6 tekens.', 'error'); return; }
    var form = e.target;
    busy(form, true);
    msg('Even geduld...');
    post('/api/auth/setup', { code: $('setupCode').value, password: pw })
      .then(function () { msg('Wachtwoord aangemaakt. Je bent ingelogd.', 'ok'); location.replace('/'); })
      .catch(function (err) { msg(err.message, 'error'); busy(form, false); });
  });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    busy(form, true);
    msg('Even geduld...');
    post('/api/auth/login', { password: $('loginPw').value })
      .then(function () { location.replace('/'); })
      .catch(function (err) { msg(err.message, 'error'); busy(form, false); $('loginPw').select(); });
  });
})();
