(function (B) {
  'use strict';

  // Waarschuwen bij de anti-bot-controle, ook als de bot gestopt is.
  // De bot lost de controle NOOIT op; dit stuurt alleen een melding zodat
  // je hem zelf kunt doen. Twee signalen:
  //  1. de vooraankondiging in de chat ("An anti-bot verification will appear in 10 seconds")
  //  2. het venster zelf (captcha-modal) staat open
  if (B.captchawatch) return;

  var CHECK_MS = 1000;
  var lastAlert = 0;
  var GAP_MS = 60000;          // hooguit één melding per minuut
  var observer = null;

  function alert(message) {
    var now = Date.now();
    if (now - lastAlert < GAP_MS) return;
    lastAlert = now;
    try {
      if (B.engine && typeof B.engine.emit === 'function') {
        B.engine.emit('alert', { reason: 'captcha', action: 'alert', message: message });
      }
    } catch (e) { /* niets */ }
  }

  // Vooraankondiging in de chat opvangen.
  function watchChat() {
    if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
    observer = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var added = list[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          var t = added[j] && added[j].textContent;
          if (t && /anti-bot (verification|check)/i.test(t)) {
            // Alleen naar een rustige plek lopen; de quiz zelf blijft voor Wesley.
            try { if (B.engine && B.engine.quizComing) B.engine.quizComing(); } catch (e) { /* niets */ }
            alert('Quiz komt eraan (of staat open). Ik loop naar een plek zonder monsters. Doe hem zelf.');
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function check() {
    try {
      watchChat();
      if (B.api && B.api.modalVisible && B.api.modalVisible('captcha-modal')) {
        alert('Quiz staat open. Doe hem zelf, de bot doet niets.');
      }
    } catch (e) { /* volgende keer weer */ }
  }

  B.captchawatch = { check: check };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
