'use strict';
// AI-antwoorden op privéberichten (Claude / Anthropic).
// Wordt aangeroepen vanuit main.js wanneer er een inkomend chatbericht is.

const fs = require('fs');
const path = require('path');

const STAFF_RE = /^(gm|cm|god|tutor)\b/i;
const DEFAULT_SYSTEM = [
  'Je bent een gewone Minibia-speler (Tibia-achtig online spel).',
  'Je krijgt een privébericht en formuleert één kort, natuurlijk antwoord.',
  'Regels:',
  '- Maximaal 1 à 2 zinnen, max ~120 tekens.',
  '- Geen markdown, geen emoji-spam, geen "als AI"-taal.',
  '- Klink als een normale speler: vriendelijk, rustig, niet verdacht.',
  '- Geef geen bot- of script-informatie prijs.',
  '- Als de ander een GM/CM/Tutor is: beleefd en kort meewerken, geen excuses verzinnen.'
].join(' ');

/**
 * @param {object} opts
 * @param {string} opts.root          project root
 * @param {() => object} opts.getConfig  actuele config ophalen
 * @param {(name: string, args?: object) => Promise} opts.command  bridge.command
 * @param {(msg: string) => void} opts.log
 */
function createAiReply({ root, getConfig, command, log }) {
  const pending = new Map(); // fromLower -> timeout id
  const lastReplyAt = new Map(); // fromLower -> timestamp
  const manualUntil = new Map(); // fromLower -> timestamp (handmatig geantwoord: AI even overslaan)

  function chatCfg() {
    const c = getConfig() || {};
    return (c.chat && c.chat.aiReply) || {};
  }

  function apiKey() {
    const cfg = chatCfg();
    return process.env.ANTHROPIC_API_KEY || cfg.apiKey || '';
  }

  function shouldReply(payload) {
    const cfg = chatCfg();
    if (!cfg.enabled) return false;
    if (!payload || typeof payload !== 'object') return false;
    if (payload.kind === 'sent') return false; // eigen berichten
    const from = String(payload.from || '').trim();
    if (!from) return false;
    if (cfg.onlyStaff !== false && !STAFF_RE.test(from)) return false;
    if (!apiKey()) {
      log('[ai-reply] Geen API-key (ANTHROPIC_API_KEY of config.chat.aiReply.apiKey).');
      return false;
    }
    const key = from.toLowerCase();
    const now = Date.now();
    // Recent handmatig geantwoord: AI even stil.
    if (manualUntil.get(key) && manualUntil.get(key) > now) return false;
    // Cooldown per afzender.
    const cool = Number(cfg.cooldownMs) > 0 ? Number(cfg.cooldownMs) : 15000;
    if (lastReplyAt.get(key) && now - lastReplyAt.get(key) < cool) return false;
    return true;
  }

  function loadHistory(from, limit) {
    const file = path.join(root, 'data', 'chat.jsonl');
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } catch (e) {
      return [];
    }
    const who = String(from).toLowerCase();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const m = JSON.parse(lines[i]);
        const other = m.kind === 'sent' ? String(m.to || '').toLowerCase() : String(m.from || '').toLowerCase();
        if (other !== who) continue;
        out.push(m);
      } catch (e) { /* skip */ }
    }
    return out.reverse();
  }

  function buildMessages(payload, history) {
    const lines = [];
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (m.kind === 'sent') lines.push('Jij: ' + String(m.text || ''));
      else lines.push(String(m.from || 'Zij') + ': ' + String(m.text || ''));
    }
    // Zorg dat het laatste inkomende bericht erin staat.
    const last = history[history.length - 1];
    if (!last || last.kind === 'sent' || String(last.text) !== String(payload.text)) {
      lines.push(String(payload.from) + ': ' + String(payload.text || ''));
    }
    return lines.join('\n');
  }

  async function callClaude(userText, systemPrompt) {
    const cfg = chatCfg();
    const model = cfg.model || 'claude-opus-5-5';
    const maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 150;
    const key = apiKey();

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        system: systemPrompt || DEFAULT_SYSTEM,
        messages: [{ role: 'user', content: userText }]
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Anthropic HTTP ' + res.status + ': ' + body.slice(0, 200));
    }
    const data = await res.json();
    const parts = (data.content || []).filter((p) => p.type === 'text').map((p) => p.text);
    let text = parts.join(' ').trim();
    // Opschonen: geen aanhalingstekens eromheen, geen markdown, kort houden.
    text = text.replace(/^["'«»]+|["'«»]+$/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 120) text = text.slice(0, 117).trim() + '…';
    return text;
  }

  function cancelPending(from) {
    const key = String(from || '').toLowerCase();
    const t = pending.get(key);
    if (t) {
      clearTimeout(t);
      pending.delete(key);
    }
  }

  /** Markeer dat de speler zelf heeft geantwoord → geplande AI-reply voor die afzender annuleren. */
  function noteManualSent(payload) {
    if (!payload || payload.kind !== 'sent') return;
    const to = String(payload.to || '').trim();
    if (!to) return;
    cancelPending(to);
    const cool = Number(chatCfg().manualSuppressMs) > 0 ? Number(chatCfg().manualSuppressMs) : 30000;
    manualUntil.set(to.toLowerCase(), Date.now() + cool);
  }

  function schedule(payload) {
    if (!shouldReply(payload)) return;
    const from = String(payload.from).trim();
    const key = from.toLowerCase();
    cancelPending(from);

    const cfg = chatCfg();
    let delay = Number(cfg.delayMs);
    if (!(delay >= 0)) delay = 2000;
    // Lichte randomisatie zodat het minder robotachtig voelt.
    const jitter = Number(cfg.jitterMs) >= 0 ? Number(cfg.jitterMs) : 800;
    if (jitter > 0) delay += Math.floor(Math.random() * (jitter + 1));

    const timer = setTimeout(async () => {
      pending.delete(key);
      if (!shouldReply(payload)) return;
      try {
        const historyLimit = Number(cfg.historyLimit) > 0 ? Number(cfg.historyLimit) : 6;
        const history = loadHistory(from, historyLimit);
        const conversation = buildMessages(payload, history);
        const prompt =
          'Conversatie met ' + from + ':\n' +
          conversation +
          '\n\nSchrijf alleen jouw volgende antwoord (geen naam-prefix).';
        const system = cfg.systemPrompt || DEFAULT_SYSTEM;
        log('[ai-reply] Claude vraagt antwoord voor ' + from + '…');
        const answer = await callClaude(prompt, system);
        if (!answer) {
          log('[ai-reply] Leeg antwoord van Claude, niets verstuurd.');
          return;
        }
        // Nogmaals check: misschien handmatig geantwoord tijdens de API-call.
        if (manualUntil.get(key) && manualUntil.get(key) > Date.now()) {
          log('[ai-reply] Overslaan: jij hebt intussen zelf geantwoord aan ' + from + '.');
          return;
        }
        lastReplyAt.set(key, Date.now());
        log('[ai-reply] Antwoord aan ' + from + ': "' + answer + '"');
        const res = await command('sendPm', { to: from, text: answer });
        if (res && res.ok === false) {
          log('[ai-reply] sendPm mislukt: ' + (res.error || 'onbekend'));
        }
      } catch (err) {
        log('[ai-reply] Fout: ' + (err && err.message ? err.message : err));
      }
    }, delay);

    pending.set(key, timer);
  }

  /** Aanroepen bij elk chat-event uit de bot. */
  function onChat(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'sent') {
      noteManualSent(payload);
      return;
    }
    schedule(payload);
  }

  return { onChat, cancelPending };
}

module.exports = { createAiReply };
