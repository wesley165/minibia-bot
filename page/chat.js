(function (B) {
  'use strict';

  // Privéberichten opvangen.
  // - Elk bericht komt in het dashboard, met de naam en de tekst.
  // - Standaard negeert de bot chat: hij huntt gewoon door.
  //   Staat config.chat.pause aan, dan pauzeert hij en komt er een melding.
  // - Antwoorden doe je zelf, via het dashboard (opdracht sendPm). De bot
  //   verzint nooit zelf een antwoord.
  if (B.chat) return;

  var hooked = false;
  var inPm = false;        // addPrivateMessage loopt: addMessage niet nog eens melden
  var lastAlert = {};      // afzender -> tijd van laatste melding (1 per minuut)

  function myName() {
    try { return String(window.gameClient.player.name || ''); } catch (e) { return ''; }
  }

  function report(kind, from, text, channel) {
    var E = B.engine;
    if (!E) return;
    var msg = { kind: kind, from: String(from || ''), text: String(text || '').slice(0, 300), channel: String(channel || ''), time: Date.now() };
    E.emit('chat', msg);
    // Chat negeren (standaard): gewoon doorgaan.
    var cfg = E.getConfig ? E.getConfig() : null;
    var pauseOn = !!(cfg && cfg.chat && cfg.chat.pause);
    if (!pauseOn) return;
    // Hooguit één melding per afzender per minuut (het bericht zelf komt wel altijd in het dashboard).
    var key = msg.from.toLowerCase();
    if (lastAlert[key] && msg.time - lastAlert[key] < 60000) return;
    lastAlert[key] = msg.time;
    // Bot pauzeren zodat jij kunt reageren. Healing loopt tijdens de pauze door.
    var paused = false;
    try { if (pauseOn && E.getState() === 'running') { E.pause('pm'); paused = true; } } catch (e) { /* niets */ }
    E.emit('alert', {
      reason: 'pm', action: paused ? 'pause' : 'alert',
      message: 'Privébericht. ' + msg.from + ': "' + msg.text + '". ' +
        (paused ? 'De bot staat op pauze. Antwoord via het dashboard en druk daarna op Doorgaan.' : 'Antwoord via het dashboard.')
    });
  }

  // Privétabblad met de afzender openen in het spel, net als wanneer je zelf
  // op zijn naam klikt. Zo zie je het gesprek apart van Default.
  function openTab(name) {
    var cm = window.gameClient && window.gameClient.interface && window.gameClient.interface.channelManager;
    if (!cm || typeof cm.addPrivateChannel !== 'function') return;
    var ch = cm.getChannel(name);
    if (ch && typeof PrivateChannel !== 'undefined' && ch instanceof PrivateChannel) return; // staat al open
    // Na het huidige bericht, zodat het spel dat eerst netjes afhandelt.
    setTimeout(function () { try { cm.addPrivateChannel(String(name)); } catch (e) { /* niets */ } }, 0);
  }

  function hook() {
    if (hooked) return;
    var cm = window.gameClient && window.gameClient.interface && window.gameClient.interface.channelManager;
    if (!cm || !cm.channels || !cm.channels.length) return;
    var proto = Object.getPrototypeOf(cm.channels[0]);
    if (!proto || typeof proto.addPrivateMessage !== 'function' || typeof proto.addMessage !== 'function') return;
    hooked = true;

    var origPm = proto.addPrivateMessage;
    proto.addPrivateMessage = function (message, name, level) {
      try {
        if (name && String(name).toLowerCase() !== myName().toLowerCase()) {
          report('pm', name, message, this.name);
          openTab(name);
        }
      } catch (e) { /* nooit het spel breken */ }
      inPm = true;
      try { return origPm.apply(this, arguments); } finally { inPm = false; }
    };

    // addMessage niet meer apart voor staff-namen: geen auto-stop meer op GM/CM/Tutor.
    if (B.engine) B.engine.log('Privéberichten worden nu bewaakt.');
  }

  // Zelf antwoorden vanuit het dashboard. De tekst komt altijd van jou.
  // Is er een privétabblad met die speler, dan gaat het via dat tabblad;
  // anders als los privébericht, precies zoals het spel dat zelf doet.
  function sendPm(args) {
    var to = String((args && args.to) || '').trim();
    var text = String((args && args.text) || '').trim().slice(0, 120);
    if (!to || !text) return { ok: false, error: 'Vul een naam en een bericht in.' };
    var g = window.gameClient;
    var cm = g && g.interface && g.interface.channelManager;
    if (!cm || !g.player) return { ok: false, error: 'Wess is niet ingelogd. Probeer het zo nog eens.' };
    var ch = cm.getChannel(to);
    // Alleen een echt privétabblad (geen Default, World of Trade).
    if (ch && !(typeof PrivateChannel !== 'undefined' && ch instanceof PrivateChannel)) ch = null;
    if (ch && typeof cm.__handlePrivateMessageSend === 'function') {
      // Zoals het spel het zelf doet als je typt in een privétabblad.
      cm.__handlePrivateMessageSend(ch, text);
    } else if (typeof ChannelPrivatePacket !== 'undefined') {
      // Geen tabblad open: hetzelfde privébericht dat het spel ook verstuurt.
      g.send(new ChannelPrivatePacket(to, text));
    } else {
      return { ok: false, error: 'Versturen lukt nu niet.' };
    }
    if (B.engine) B.engine.emit('chat', { kind: 'sent', from: myName(), to: ch ? ch.name : to, text: text, channel: 'privé', time: Date.now() });
    return { ok: true };
  }

  B.chat = { sendPm: sendPm };
  if (B.every) B.every(hook, 2000); else setInterval(hook, 2000);
})(window.WJBot = window.WJBot || {});
