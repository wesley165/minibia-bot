'use strict';

// Inloggen op het dashboard met een eigen wachtwoord.
// - Eerste keer: wachtwoord aanmaken. Dat vraagt een eenmalige aanmaakcode
//   (DASHBOARD_PASSWORD uit .env), zodat niet iemand anders je voor is.
// - Daarna: inloggen met het eigen wachtwoord. Je krijgt een sessie-cookie
//   die 30 dagen geldig is.
// Het wachtwoord wordt alleen als scrypt-hash bewaard (data/auth.json).
// Zonder aanmaakcode en zonder auth.json staat inloggen uit (alleen lokaal gebruik).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'wjsess';
const SESSION_DAYS = 30;
const MIN_LENGTH = 6; // minimaal 6 tekens (keuze van Wesley); de server blokkeert na 5 foute pogingen

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function createAuth({ root, setupCode }) {
  const authFile = path.join(root, 'data', 'auth.json');
  const sessFile = path.join(root, 'data', 'sessions.json');
  let sessions = readJson(sessFile, []).filter((s) => s && s.exp > Date.now());

  function isSetup() { return fs.existsSync(authFile); }

  // Moet je inloggen? Alleen als er een wachtwoord is, of een aanmaakcode.
  function required() { return isSetup() || !!setupCode; }

  function saveSessions() {
    sessions = sessions.filter((s) => s.exp > Date.now());
    writeAtomic(sessFile, sessions);
  }

  function newSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.push({ h: sha(token), exp: Date.now() + SESSION_DAYS * 86400000 });
    saveSessions();
    return token;
  }

  function tokenFrom(req) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
    return m ? m[1] : null;
  }

  function check(req) {
    if (!required()) return true;
    const t = tokenFrom(req);
    if (!t) return false;
    const h = sha(t);
    return sessions.some((s) => s.h === h && s.exp > Date.now());
  }

  function cookie(token, secure) {
    const parts = [COOKIE + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + SESSION_DAYS * 86400];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function clearCookie(secure) {
    return COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (secure ? '; Secure' : '');
  }

  // Eerste keer: eigen wachtwoord aanmaken met de aanmaakcode.
  function setup(code, pw) {
    if (isSetup()) return { ok: false, error: 'Er is al een wachtwoord. Log in.' };
    if (setupCode && !same(code || '', setupCode)) return { ok: false, error: 'De aanmaakcode klopt niet.', badCode: true };
    if (String(pw || '').length < MIN_LENGTH) return { ok: false, error: 'Kies een wachtwoord van minimaal ' + MIN_LENGTH + ' tekens.' };
    const salt = crypto.randomBytes(16).toString('hex');
    writeAtomic(authFile, { salt, hash: hashPassword(pw, salt), createdAt: new Date().toISOString() });
    sessions = [];
    return { ok: true, token: newSession() };
  }

  function login(pw) {
    const a = readJson(authFile, null);
    if (!a) return { ok: false, error: 'Er is nog geen wachtwoord. Maak er eerst een aan.' };
    if (!same(hashPassword(pw || '', a.salt), a.hash)) return { ok: false, error: 'Wachtwoord klopt niet.', badPassword: true };
    return { ok: true, token: newSession() };
  }

  function logout(req) {
    const t = tokenFrom(req);
    if (!t) return;
    const h = sha(t);
    sessions = sessions.filter((s) => s.h !== h);
    saveSessions();
  }

  // Wachtwoord wijzigen (ingelogd): oud wachtwoord nodig. Alle andere sessies vervallen.
  function change(oldPw, newPw) {
    const a = readJson(authFile, null);
    if (!a || !same(hashPassword(oldPw || '', a.salt), a.hash)) return { ok: false, error: 'Je huidige wachtwoord klopt niet.', badPassword: true };
    if (String(newPw || '').length < MIN_LENGTH) return { ok: false, error: 'Kies een wachtwoord van minimaal ' + MIN_LENGTH + ' tekens.' };
    const salt = crypto.randomBytes(16).toString('hex');
    writeAtomic(authFile, { salt, hash: hashPassword(newPw, salt), createdAt: new Date().toISOString() });
    sessions = [];
    return { ok: true, token: newSession() };
  }

  return { isSetup, required, check, setup, login, logout, change, cookie, clearCookie };
}

module.exports = { createAuth };
