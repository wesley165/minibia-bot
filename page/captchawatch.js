(function (B) {
  'use strict';

  // Anti-bot-controle (quiz). Deze module doet twee dingen:
  //   1. SIGNALEN: vooraankondiging in de chat opvangen, het quizvenster
  //      herkennen (modal óf .captcha-element) en per tick melden aan de
  //      engine, zodat die naar een veilige plek kan lopen.
  //   2. ZELF OPLOSSEN: de bot probeert de quiz zelf te beantwoorden.
  //      - Rekensommen ("wat is 7 + 3?") worden ter plaatse uitgerekend.
  //      - Veldvermenigvuldiging (raster van vormen: kies het vakje met de
  //      meeste X's) wordt zelf geteld.
  //      - Meerkeuzevragen gaan via de AI-oplosser (engine.quizAskAi): de
  //      vraag + opties worden naar Claude gestuurd en het gekozen antwoord
  //      wordt aangeklikt.
  //      - Een wachtwoordquiz kunnen we niet raden: die blijft voor jou.
  //      Lukt oplossen niet of duurt het te lang, dan logt de engine uit.
  if (B.captchawatch) return;

  var CHECK_MS = 1000;
  var GAP_MS = 60000;          // hooguit één melding per minuut per soort
  var ANNOUNCE_RE = /anti-?bot|wachtwoord van je account|verificatie verschijnt|verification will appear/i;
  var QUIZ_DONE_RE = /verification (is )?(complete|passed|succes|correct)|captcha (opgelost|vervolledigd)/i;
  var PW_RE = /wachtwoord van|password of your|account.?wachtwoord/i;
  var CLICK_RE = /click|klik|touch|tik |aanraak|checkbox|vink/i;
  var CHOICE_RE = /kies|choose|select|antwoord|answer|welk|which/i;

  var lastAlert = {};          // key -> tijdstip van laatste melding
  var lastClickAt = 0;         // wanneer voor het laatst iets aangeklikt is (wacht op reactie)
  var clicksThisQuiz = 0;      // aantal klikken deze quiz (eindige gok-lijst)
  var guessIdx = 0;            // volgende gok uit de restlijst
  var roots = [];              // elementen die we observeren
  var modalWasOpen = false;
  var announceAt = 0;          // wanneer voor het laatst een vooraankondiging werd gezien
  var signals = [];            // { at, text } van tekst die met de quiz te maken heeft
  var solvedOnce = false;      // deze quizpoging al een oplossing geprobeerd?
  var solveTimer = 0;          // uitgestelde poging (DOM moet eerst renderen)
  var attemptsAt = 0;          // tijd van de vorige poging (herhalingsinterval)
  var ATTEMPT_GAP_MS = 4000;   // maximaal één DOM-poging per 4 s
  var CLICK_SETTLE_MS = 2500;  // na een klik: zo lang wachten op de reactie van het spel
  var MAX_GUESS_CLICKS = 16;   // eindige gok-lijst: daarna niet blijven klikken (wacht tot uitloggen)
  var AI_WAIT_UNTIL = 0;       // tot dit moment wachten op het AI-antwoord
  var AI_WAIT_MS = 25000;      // AI mag er maximaal zo lang over doen

  function alertKeyed(key, message) {
    var now = Date.now();
    if (lastAlert[key] && now - lastAlert[key] < GAP_MS) return;
    lastAlert[key] = now;
    try {
      if (B.engine && typeof B.engine.emit === 'function') {
        B.engine.emit('alert', { reason: 'captcha', action: 'alert', message: message });
      }
    } catch (e) { /* niets */ }
  }

  function remember(text) {
    if (!text) return;
    var t = String(text).trim();
    if (!t || t.length > 400) return;
    signals.push({ at: Date.now(), text: t });
    if (signals.length > 12) signals.shift();
  }

  // "Resolve quizzes" (dashboard): aan = de bot probeert zelf op te lossen.
  // Zonder engine-signaal: standaard aan.
  function resolveOn() {
    if (B.engine && typeof B.engine.quizResolveOn === 'function') {
      try { return !!B.engine.quizResolveOn(); } catch (e) { /* niets */ }
    }
    return true;
  }

  // Het spel kan het quizvenster op twee manieren tonen: via de modal-laag
  // met id 'captcha-modal', of (nieuwe UI) als element met klasse 'captcha'.
  function quizElement() {
    try {
      if (B.api && B.api.modalVisible && B.api.modalVisible('captcha-modal')) {
        return document.getElementById('captcha-modal');
      }
    } catch (e) { /* volgende keer weer */ }
    try {
      var els = document.querySelectorAll('.captcha, [id*="captcha" i], [class*="captcha" i]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) return el;
      }
    } catch (e) { /* niets */ }
    return null;
  }

  function quizVisible() {
    return !!quizElement();
  }

  function visibleRect(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    } catch (e) { return false; }
  }

  function clickEl(el) {
    try {
      el.scrollIntoView && el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    } catch (e) { return false; }
  }

  // ---------- Lezen van het quizvenster ----------

  // Knoppen/opties die als antwoord dienen kunnen (in volgorde van specifiekeid):
  // echte buttons, radio/checkbox-inputs, en klikbare lijst-items.
  function answerOptions(el) {
    var out = [];
    if (!el) return out;
    try {
      var btns = el.querySelectorAll('button, [role="button"], [role="radio"], input[type="radio"], input[type="checkbox"], li, .option, [class*="option" i], [data-answer]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (!b || !visibleRect(b)) continue;
        // Sluitknoppen en bevestigingsknoppen apart behandelen.
        var act = String(b.getAttribute && b.getAttribute('action') || '').toLowerCase();
        if (act === 'logout' || act === 'cancel' || act === 'close') continue;
        var label = '';
        try {
          label = String(b.textContent || b.value || b.getAttribute('data-answer') || '').trim().replace(/\s+/g, ' ');
        } catch (e) { label = ''; }
        if (!label && b.tagName === 'INPUT') label = String(b.name || b.id || '');
        out.push({ el: b, label: label, kind: b.tagName });
      }
    } catch (e) { /* niets */ }
    return out;
  }

  function confirmButton(el) {
    if (!el) return null;
    try {
      var cands = el.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < cands.length; i++) {
        var t = String(cands[i].textContent || '').trim().toLowerCase();
        if (/^(verstuur|verzenden|bevestig|doorgaan|continue|submit|send|ok|ja|yes|confirm)$/.test(t) && visibleRect(cands[i])) {
          return cands[i];
        }
      }
    } catch (e) { /* niets */ }
    return null;
  }

  function quizText(el) {
    var text = '';
    try { text = String((el && el.textContent) || ''); } catch (e) { text = ''; }
    return text.replace(/\s+/g, ' ').trim();
  }

  // ---------- Oplosstrategieën ----------

  // 1. Rekensom: "wat is 7 + 3", "hoeveel is 12 * 4", "what is 9 - 2?"
  var MATH_RE = /(wat is|hoeveel is|bereken|what is|calculate|solve)\s*\W*(-?\d+)\s*([+\-*x×÷])\s*(-?\d+)/i;
  function mathAnswer(text) {
    var m = MATH_RE.exec(text);
    if (!m) return null;
    var a = Number(m[2]), b = Number(m[4]);
    var op = m[3];
    var r = null;
    if (op === '+') r = a + b;
    else if (op === '-') r = a - b;
    else if (op === '*' || op === 'x' || op === '×') r = a * b;
    else if (op === '÷' || op === '/') r = b !== 0 ? a / b : null;
    if (r === null || !isFinite(r)) return null;
    return String(Math.round(r * 1000) / 1000);
  }

  // Kiest uit de opties degene die (exact) gelijk is aan het verwachte antwoord.
  function pickByValue(options, valueStr) {
    var want = String(valueStr).trim().toLowerCase();
    for (var i = 0; i < options.length; i++) {
      var l = options[i].label.toLowerCase().replace(/[.,]/g, '').trim();
      if (l === want) return options[i];
    }
    // Losse cijfers op de tegels (geen labels)? Typ het antwoord in een input.
    var inputs = [];
    for (var j = 0; j < options.length; j++) {
      if (options[j].el.tagName === 'INPUT') inputs.push(options[j].el);
    }
    if (inputs.length === 1) {
      try {
        var inp = inputs[0];
        inp.focus();
        inp.value = want;
        inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return { el: inp, typed: true };
      } catch (e) { /* niets */ }
    }
    return null;
  }

  // 2. Veldvermenigvuldiging: raster van klikbare cellen met vormen.
  //    Vraag: "vermenigvuldig het aantal X's in het veld met zichzelf" o.s.w.
  //    Strategie: tel per vormtype het aantal cellen en klik het vakje met de
  //    grootste aantallen (dat is bij dit type quiz bijna altijd het doel).
  var GRID_RE = /vermenigvuldig|multiply|field|veld|aantal .{0,20} in het (veld|grid)|kruisjes|shape/i;
  function gridCells(el) {
    var cells = [];
    try {
      var cand = el.querySelectorAll('[class*="cell" i], [class*="tile" i], [class*="box" i], td, canvas, svg, img');
      for (var i = 0; i < cand.length; i++) {
        var c = cand[i];
        if (!visibleRect(c)) continue;
        var r = c.getBoundingClientRect();
        // Cel-achtig: ongeveer vierkant en klein.
        if (r.width >= 8 && r.width <= 120 && Math.abs(r.width - r.height) < r.width * 0.6) {
          cells.push({ el: c, x: r.left, y: r.top, w: r.width, area: r.width * r.height, cls: String(c.className || ''), tag: c.tagName });
        }
      }
    } catch (e) { /* niets */ }
    return cells;
  }

  function solveGrid(el) {
    var cells = gridCells(el);
    if (cells.length < 4) return false;
    // Groepeer op "vorm": class-naam + relatieve grootte. Gelijksoortige
    // cellen horen bij elkaar; we zoeken de groep met de meeste leden.
    var groups = {};
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var key = c.cls + '|' + Math.round(c.w / 4);
      (groups[key] || (groups[key] = [])).push(c);
    }
    var bestKey = null, bestLen = 0;
    for (var k in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, k) && groups[k].length > bestLen) {
        bestLen = groups[k].length; bestKey = k;
      }
    }
    if (!bestKey || bestLen < 2) return false;
    var group = groups[bestKey];
    // Klik de cel die het verst van het midden van het raster afstaat: bij
    // dit type quiz wijst de vraag meestal naar een specifiek uiterst vakje,
    // en een buiten-cel is de veiligste gok zonder visuele analyse.
    var cx = 0, cy = 0;
    for (var j = 0; j < group.length; j++) { cx += group[j].x; cy += group[j].y; }
    cx /= group.length; cy /= group.length;
    var far = null, farD = -1;
    for (var m = 0; m < group.length; m++) {
      var d = Math.abs(group[m].x - cx) + Math.abs(group[m].y - cy);
      if (d > farD) { farD = d; far = group[m]; }
    }
    if (!far) return false;
    if (!clickEl(far.el)) return false;
    var cf = confirmButton(el);
    if (cf) clickEl(cf);
    return true;
  }

  // Klikpoging registreren: daarna even wachten op de reactie van het spel
  // (nieuw venster, bevestigingsknop, of het venster gaat weg = gegokt goed).
  function markClick() {
    lastClickAt = Date.now();
    clicksThisQuiz++;
  }

  // Laatste redmiddel: eendimensionale tikquiz ("klik op ...") zonder leesbare
  // opties. Klik één voor één alle klikbare elementen in het quizvak af, met
  // een pauze ertussen zodat we per gok kunnen zien of het venster dichtgaat.
  // Bevestigingsknoppen laten we overslaan totdat er niets anders meer over is.
  function clickNextGuess(el) {
    var opts = answerOptions(el);
    var real = [];
    for (var i = 0; i < opts.length; i++) {
      var l = opts[i].label.toLowerCase();
      if (/^(verstuur|verzenden|bevestig|doorgaan|continue|submit|send|ok|ja|yes|confirm|sluit|close|annuleer|cancel)$/.test(l)) continue;
      real.push(opts[i]);
    }
    var pool = real.length ? real : opts;
    if (!pool.length) return false;
    if (guessIdx >= pool.length) guessIdx = 0;   // rondje klaar: opnieuw beginnen
    var pick = pool[guessIdx++];
    if (!pick || !clickEl(pick.el)) return false;
    markClick();
    alertKeyed('solve-guess', 'Tikquiz: ik klik de mogelijkheden één voor één af (' + guessIdx + '/' + pool.length + ').');
    return true;
  }

  // Beslist en handelt. Geeft: 'none' (niets te doen), 'working' (poging
  // gedaan, resultaat nog onzeker), 'human' (kan niet automatisch).
  function trySolve(el) {
    var now = Date.now();
    if (now - attemptsAt < ATTEMPT_GAP_MS) return 'working';
    // Net iets aangeklikt? Geef het spel de kans om te reageren voordat we
    // verder gaan (anders klikken we losse antwoorden door elkaar heen).
    if (lastClickAt && now - lastClickAt < CLICK_SETTLE_MS) return 'working';
    if (now < AI_WAIT_UNTIL) return 'working';
    // "Resolve quizzes" staat uit in het dashboard: niet zelf proberen.
    // De engine logt dan netjes uit (quizPauseTick).
    if (B.engine && typeof B.engine.quizResolveOn === 'function' && !B.engine.quizResolveOn()) return 'off';
    var text = quizText(el);
    remember(text);

    // Wachtwoordquiz: alleen de eigenaar kent het wachtwoord.
    if (PW_RE.test(text)) return 'human';
    try {
      if (el.querySelector && el.querySelector('input[type="password"]')) return 'human';
    } catch (e) { /* niets */ }

    attemptsAt = now;
    var options = answerOptions(el);

    // 1. Rekensom: zelf uitrekenen en het juiste antwoord aanklikken.
    var ans = mathAnswer(text);
    if (ans !== null) {
      var pick = pickByValue(options, ans);
      if (pick) {
        if (!pick.typed) {
          if (!clickEl(pick.el)) return 'working';
          markClick();
        }
        var cf = confirmButton(el);
        if (cf) { clickEl(cf); markClick(); }
        alertKeyed('solve-math', 'Quiz was een rekensom (' + ans + '). Ik heb het antwoord ingevuld.');
        return 'working';
      }
      // Som maar geen matching optie: val door naar de AI.
    }

    // 2. Raster/veld-vraag: tellen en klikken.
    if (GRID_RE.test(text) && options.length >= 4) {
      if (solveGrid(el)) {
        markClick();
        alertKeyed('solve-grid', 'Veldquiz: ik heb geteld en een vakje gekozen.');
        return 'working';
      }
    }

    // 3. Meerkeuze: vraag + opties naar de AI (Claude). De engine regelt
    //    het netwerkdeel; hier klikken we het teruggekregen antwoord.
    if (options.length >= 2 && B.engine && typeof B.engine.quizAskAi === 'function') {
      var labels = [];
      for (var i = 0; i < options.length; i++) {
        if (options[i].label) labels.push({ idx: i, label: options[i].label, el: options[i].el });
      }
      if (labels.length >= 2) {
        AI_WAIT_UNTIL = now + AI_WAIT_MS;
        B.engine.quizAskAi(text, labels.map(function (l) { return l.label; }), function (choiceIdx) {
          try {
            AI_WAIT_UNTIL = 0;
            if (choiceIdx == null || choiceIdx < 0 || choiceIdx >= labels.length) return;
            var q = quizElement();
            if (!q) return;                       // venster al weg: klaar
            var opts2 = answerOptions(q);
            // Opties kunnen van volgorde veranderd zijn; match op label.
            var target = null;
            for (var k = 0; k < opts2.length; k++) {
              if (opts2[k].label === labels[choiceIdx].label) { target = opts2[k]; break; }
            }
            if (!target && opts2[choiceIdx]) target = opts2[choiceIdx];
            if (!target) return;
            if (!clickEl(target.el)) return;
            markClick();
            var cf2 = confirmButton(q);
            if (cf2) { clickEl(cf2); markClick(); }
            alertKeyed('solve-ai', 'Meerkeuzequiz: ik heb "' + labels[choiceIdx].label + '" gekozen.');
          } catch (e) { /* niets */ }
        });
        return 'working';
      }
    }

    // 4. Tikwerk ("klik op ...") zonder leesbare meerkeuze-opties: klik de
    //    mogelijkheden één voor één af. Bevestigingsknoppen worden pas aan
    //    het eind van de lijst geprobeerd. Maximaal MAX_GUESS_CLICKS keer:
    //    daarna wachten we op de uitlog-timer van de engine.
    if (CLICK_RE.test(text) && clicksThisQuiz < MAX_GUESS_CLICKS) {
      if (clickNextGuess(el)) return 'working';
    }

    return 'working'; // nog niet geslaagd; volgende ronde opnieuw proberen
  }

  function resetSolveState() {
    solvedOnce = false;
    solveTimer = 0;
    attemptsAt = 0;
    AI_WAIT_UNTIL = 0;
    lastClickAt = 0;
    clicksThisQuiz = 0;
    guessIdx = 0;
  }

  // Wat voor quiz staat er? (voor meldingen en logs)
  function quizKind(el) {
    var text = quizText(el);
    if (!text) return 'onbekend';
    if (PW_RE.test(text)) return 'wachtwoord';
    var ans = mathAnswer(text);
    if (ans !== null) return 'rekensom';
    if (GRID_RE.test(text)) return 'veldquiz';
    if (CLICK_RE.test(text)) return 'tikwerk';
    if (CHOICE_RE.test(text)) return 'meerkeuze';
    try {
      if (el && el.querySelector && el.querySelector('input[type="password"], input[type="text"]')) return 'wachtwoord';
      if (el && el.querySelector && el.querySelector('input[type="checkbox"], input[type="radio"], button')) return 'meerkeuze';
    } catch (e) { /* niets */ }
    return 'onbekend';
  }

  // Vooraankondiging in de chat opvangen.
  function handleText(t) {
    if (!t) return;
    var s = String(t);
    if (ANNOUNCE_RE.test(s)) {
      announceAt = Date.now();
      remember(s);
      // Naar een veilige plek lopen; het oplossen begint zodra het venster open staat.
      try { if (B.engine && B.engine.quizComing) B.engine.quizComing(); } catch (e) { /* niets */ }
      alertKeyed('announce', 'Quiz komt eraan. Ik loop naar een plek zonder monsters en maak me klaar om hem zelf op te lossen.');
      return;
    }
    if (QUIZ_DONE_RE.test(s)) {
      remember(s);
      try { if (B.engine && B.engine.quizCleared) B.engine.quizCleared(); } catch (e) { /* niets */ }
      alertKeyed('done', 'Quiz is beantwoord. De bot hervat zodra het venster weg is.');
    }
  }

  // Nieuwe tekst in het spel: alles wat naar een quiz ruikt onthouden, want
  // de engine gebruikt die signalen om te beslissen of uitloggen beter is.
  function scanNode(n) {
    if (!n) return;
    try {
      if (n.nodeType === 3) { handleText(n.textContent); return; }
      if (n.nodeType !== 1) return;
      var txt = n.textContent;
      if (typeof txt === 'string' && txt) handleText(txt);
    } catch (e) { /* niets */ }
  }

  function watchChat() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    if (roots.indexOf(document.body) !== -1) return;
    var obs = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var added = list[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) scanNode(added[j]);
      }
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
      roots.push(document.body);
    } catch (e) { /* body nog niet klaar: volgende tick weer */ }
  }

  function check() {
    try {
      watchChat();
      var el = quizElement();
      var open = !!el;
      if (open) {
        var kind = quizKind(el);
        // Veiligheidsnet: de chat-aankondiging is misschien door een haperende
        // observer gemist. Zolang het venster open is, houdt de engine de
        // veilige plek in de gaten (quizComing verlengt de voorbereiding).
        if (Date.now() - announceAt > 15000) {
          try { if (B.engine && B.engine.quizComing) B.engine.quizComing(); } catch (e) { /* niets */ }
        }
        if (kind === 'wachtwoord') {
          alertKeyed('human', 'Er staat een wachtwoordquiz open. Die kan ik niet invullen; typ hem in het spel.');
          return;
        }
        // Eerste poging uitstellen: het DOM moet nog renderen.
        if (!solvedOnce && !solveTimer) {
          solvedOnce = true;
          solveTimer = setTimeout(function () {
            solveTimer = 0;
            try {
              var q = quizElement();
              if (q) {
                var res = trySolve(q);
                if (res === 'human') alertKeyed('human', 'Deze quiz kan ik niet zelf oplossen; typ het antwoord in het spel.');
              }
            } catch (e) { /* niets */ }
          }, resolveOn() ? 1200 : 150);
        } else if (solvedOnce) {
          // Blijf periodiek proberen zolang het venster open staat (AI-ronde,
          // nieuwe DOM, of bevestigingsknop die nog ontbrak).
          var res2 = trySolve(el);
          if (res2 === 'human') {
            alertKeyed('human', 'Deze quiz kan ik niet zelf oplossen; typ het antwoord in het spel.');
          }
        }
      } else if (modalWasOpen) {
        // Was de wegkomst van een eigen klik? Dan heeft de laatste gok
        // blijkbaar gewerkt (of het spel heeft de quiz herstart).
        var msg = clicksThisQuiz > 0 && Date.now() - lastClickAt < 15000
          ? 'Het quizvenster is weg na mijn klik-pogingen — quiz overleefd. De bot hervat vanzelf.'
          : 'Het quizvenster is weg. De bot hervat vanzelf.';
        try { if (B.engine && B.engine.quizCleared) B.engine.quizCleared(); } catch (e) { /* niets */ }
        alertKeyed('gone', msg);
        resetSolveState();
      }
      modalWasOpen = open;
    } catch (e) { /* volgende keer weer */ }
  }

  B.captchawatch = {
    check: check,
    quizVisible: quizVisible,
    quizKind: function () { return quizKind(quizElement()); },
    // Laatste quiz-teksten (voor het log en voor de engine).
    signals: function () { return signals.slice(-6); }
  };
  if (B.every) B.every(check, CHECK_MS); else setInterval(check, CHECK_MS);
})(window.WJBot = window.WJBot || {});
