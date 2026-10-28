'use strict';
// Meldingen via ntfy (telefoon) en via het bureaublad van de Mac.
// Fouten worden alleen gelogd, nooit gegooid.

const https = require('https');
const { execFile } = require('child_process');

let settings = { ntfyTopic: '', desktop: true };

// Instellingen uit config.notify zetten.
function configure(notifyCfg) {
  settings = Object.assign({ ntfyTopic: '', desktop: true }, notifyCfg || {});
}

// Haalt tekens weg die niet in een HTTP-header mogen.
function headerSafe(text) {
  return String(text || '').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

function sendNtfy(topic, title, message, priority) {
  return new Promise((resolve) => {
    const cleanTopic = String(topic).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cleanTopic)) {
      console.error('[notify] ntfy-topic is ongeldig. Gebruik alleen letters, cijfers, - en _.');
      return resolve(false);
    }
    const body = Buffer.from(String(message || ''), 'utf8');
    const req = https.request({
      method: 'POST',
      hostname: 'ntfy.sh',
      path: '/' + encodeURIComponent(cleanTopic),
      headers: {
        'Title': headerSafe(title) || 'Minibia-bot',
        'Priority': priority || 'default',
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length
      },
      timeout: 10000
    }, (res) => {
      res.resume();
      if (res.statusCode >= 300) console.error('[notify] ntfy gaf status', res.statusCode);
      resolve(res.statusCode < 300);
    });
    req.on('timeout', () => req.destroy(new Error('time-out')));
    req.on('error', (err) => {
      console.error('[notify] ntfy mislukt:', err.message);
      resolve(false);
    });
    req.end(body);
  });
}

// Tekst veilig maken voor een AppleScript-string.
function appleString(text) {
  return '"' + String(text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
}

function sendDesktop(title, message) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    const script = 'display notification ' + appleString(message) +
      ' with title ' + appleString(title || 'Minibia-bot') + ' sound name "Glass"';
    execFile('osascript', ['-e', script], { timeout: 10000 }, (err) => {
      if (err) console.error('[notify] bureaubladmelding mislukt:', err.message);
      resolve(!err);
    });
  });
}

// notify({ title, message, priority }). priority: 'urgent' voor captcha en death.
async function notify({ title, message, priority } = {}) {
  const jobs = [];
  try {
    if (settings.ntfyTopic) jobs.push(sendNtfy(settings.ntfyTopic, title, message, priority));
    if (settings.desktop) jobs.push(sendDesktop(title, message));
    await Promise.all(jobs);
  } catch (err) {
    console.error('[notify] fout:', err.message);
  }
}

module.exports = { configure, notify };
