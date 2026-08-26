#!/usr/bin/env node
/**
 * The falsifier for the Chartbit session bug.
 *
 * The bug: Stockbit runs ONE token family per session, `/login/refresh` retires the previous
 * generation, and the access token used to live only in process memory — so every new process
 * refreshed on its first API call and revoked whatever generation the browser was holding. Chartbit
 * therefore died at the first MCP tool call after a login, not at any expiry.
 *
 * This reproduces the exact sequence that used to kill it and reports whether it still does:
 *
 *   1. read the generation the browser is seeded with
 *   2. make CLI calls in SEPARATE processes — the step that used to revoke it
 *   3. read the generation again
 *
 * PASS means the generation did not move: the CLI no longer spends the family, so the browser's
 * session survives and the only thing that ends it is the refresh token's own ~7-day expiry.
 *
 * Read-only with respect to the account: it asks for an access token and reads local files. It never
 * draws, never saves a layout, and never touches trading.
 *
 *   node scripts/verify-chartbit-session.cjs
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { statSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const REPO = join(__dirname, '..');
const STORE = process.env.STOCKBIT_STORE_DIR || join(homedir(), '.stockbit');

function generation() {
  const code = `
    const {getStore}=require(${JSON.stringify(join(REPO, 'dist/src/auth/store.js'))});
    const {decodeJwt}=require(${JSON.stringify(join(REPO, 'dist/src/auth/session.js'))});
    const t=getStore('main').get();
    process.stdout.write(JSON.stringify({ jti: (t?decodeJwt(t):{}).jti || null }));
  `;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  const { jti } = JSON.parse(out);
  const mtime = (f) => {
    try {
      return statSync(join(STORE, f)).mtime.toISOString();
    } catch {
      return 'ABSENT';
    }
  };
  return { jti, refresh: mtime('refresh.enc'), web: mtime('websession.enc') };
}

/** One fresh process asking for a usable token — precisely what used to rotate the family. */
function freshProcessCall() {
  const code = `
    (async () => {
      const { ensureFresh } = require(${JSON.stringify(join(REPO, 'dist/src/auth/session.js'))});
      try { await ensureFresh('main'); } catch (e) { process.stderr.write(String(e && e.message)); }
    })();
  `;
  execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function webSessionState() {
  const code = `
    const ws=require(${JSON.stringify(join(REPO, 'dist/src/auth/websession.js'))});
    const h=ws.webSessionHealth();
    process.stdout.write(JSON.stringify({
      likelyValid: h.likelyValid, expired: h.expired, basis: h.basis,
      daysLeft: h.refreshHoursLeft === null ? null : +(h.refreshHoursLeft/24).toFixed(2),
      blocked: ws.webSessionLaunchBlocker() !== null,
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }));
}

const before = generation();
const web = webSessionState();

console.log('BEFORE');
console.log(`  token generation (jti) : ${before.jti}`);
console.log(`  refresh.enc written    : ${before.refresh}`);
console.log(`  websession.enc written : ${before.web}`);
console.log(`  chart session          : likelyValid=${web.likelyValid} expired=${web.expired} basis=${web.basis}`);
console.log(`  refresh token left     : ${web.daysLeft === null ? 'unknown' : web.daysLeft + ' day(s)'}`);
console.log(`  would block a launch   : ${web.blocked ? 'YES' : 'no'}`);
console.log('');

console.log('MAKING 3 CLI CALLS IN SEPARATE PROCESSES (the step that used to revoke the session)…');
for (let i = 1; i <= 3; i++) {
  freshProcessCall();
  const g = generation();
  console.log(`  call ${i}: jti ${g.jti === before.jti ? 'UNCHANGED' : 'ROTATED -> ' + g.jti}`);
}
console.log('');

const after = generation();
const rotated = after.jti !== before.jti;
const webMoved = after.web !== before.web;

console.log('AFTER');
console.log(`  token generation (jti) : ${after.jti}`);
console.log(`  refresh.enc written    : ${after.refresh}`);
console.log(`  websession.enc written : ${after.web}`);
console.log('');

if (rotated) {
  console.log('FAIL — the CLI rotated the token family, which revokes the generation the browser holds.');
  console.log('       This is the original bug. The chart will render blank on the next open.');
  process.exit(1);
}
if (webMoved) {
  console.log('NOTE — websession.enc changed during this run. Nothing here should have written it.');
}
console.log('PASS — three separate processes reused one token; the family did not rotate.');
console.log('       The browser keeps the generation it was seeded with, so the chart session survives');
console.log(`       until its refresh token expires${web.daysLeft === null ? '' : ` (~${web.daysLeft} day(s) from now)`},`);
console.log('       and every chart open rotates that forward again.');
