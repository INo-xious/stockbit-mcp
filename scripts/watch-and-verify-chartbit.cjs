#!/usr/bin/env node
/**
 * Wait for a genuinely NEW login, then run the end-to-end Chartbit proof unattended.
 *
 * The verification this completes needs a session the server has not revoked, and minting one means
 * a human typing credentials into a browser. Rather than have that human come back and say "now",
 * this waits for the new credential to appear and then runs the sequence that used to break:
 *
 *     CLI calls in separate processes  ->  open a chart  ->  draw  ->  screenshot
 *
 * "New" is judged by the refresh token's `expired_at` CHANGING, not by the file's mtime. A login that
 * times out still re-captures whatever the browser holds and rewrites the file, which is exactly how
 * a dead session came to look freshly captured at 11:02 — mtime is not evidence of a new credential.
 *
 * Draws on BBRI deliberately: never the user's own watchlist charts, and never saves the layout.
 *
 *   node scripts/watch-and-verify-chartbit.cjs [--timeout-min 240] [--symbol BBRI]
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { appendFileSync } = require('node:fs');

const REPO = join(__dirname, '..');
const STORE = process.env.STOCKBIT_STORE_DIR || join(homedir(), '.stockbit');
const LOG = join(STORE, 'chartbit-verify.log');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SYMBOL = arg('--symbol', 'BBRI');
const TIMEOUT_MIN = Number(arg('--timeout-min', '240'));
const POLL_MS = 15_000;

function say(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try {
    appendFileSync(LOG, msg + '\n');
  } catch {
    /* logging must never be the thing that fails this */
  }
}

function node(code) {
  return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The refresh token's expiry — the only reliable marker that a NEW credential was minted. */
function credentialFingerprint() {
  try {
    const out = node(`
      const ws=require(${JSON.stringify(join(REPO, 'dist/src/auth/websession.js'))});
      const s=ws.loadWebSession();
      if(!s){process.stdout.write('{}');}
      else{
        const c=s.cookies.find(x=>x.name==='credentialStorage');
        let r=null;
        try{ r=JSON.parse(decodeURIComponent(c.value)).state.refresh.expired_at; }catch{}
        process.stdout.write(JSON.stringify({refreshExpiry:r}));
      }
    `);
    return JSON.parse(out).refreshExpiry || null;
  } catch {
    return null;
  }
}

async function main() {
  say(`watching for a new login (symbol ${SYMBOL}, giving up after ${TIMEOUT_MIN} min)`);
  const before = credentialFingerprint();
  say(`current refresh expiry: ${before ?? 'none'} — waiting for this to CHANGE`);

  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let now = before;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    now = credentialFingerprint();
    if (now && now !== before) break;
  }

  if (!now || now === before) {
    say('TIMED OUT — no new credential appeared. Nothing was verified.');
    process.exit(2);
  }

  say(`NEW credential detected. refresh now expires ${now}`);
  say('running the sequence that used to break it…');

  // 1. CLI calls in separate processes — the step that used to revoke the browser's session.
  for (let i = 1; i <= 3; i++) {
    try {
      node(`
        (async () => {
          const { ensureFresh } = require(${JSON.stringify(join(REPO, 'dist/src/auth/session.js'))});
          await ensureFresh('main');
        })();
      `);
      say(`  CLI call ${i}: done`);
    } catch (err) {
      say(`  CLI call ${i}: FAILED — ${String(err.message).slice(0, 120)}`);
    }
  }

  // 2. Open a chart and draw. This is the part that was blank before.
  const drawScript = `
    (async () => {
      const driver = require(${JSON.stringify(join(REPO, 'dist/src/chartbit/driver.js'))});
      const out = {};
      try {
        const state = await driver.openChart({ symbol: ${JSON.stringify(SYMBOL)} });
        out.opened = true;
        out.widgetKey = state.widgetKey;
        out.notes = state.notes;
      } catch (e) { out.opened = false; out.error = String(e && e.message).slice(0, 300); }
      if (out.opened) {
        try {
          await driver.drawAnnotations({
            symbol: ${JSON.stringify(SYMBOL)},
            annotations: [{ kind: 'level', price: 1, label: 'chartbit session verification' }],
          });
          out.drew = true;
        } catch (e) { out.drew = false; out.drawError = String(e && e.message).slice(0, 300); }
      }
      process.stdout.write(JSON.stringify(out));
    })();
  `;
  let result = {};
  try {
    result = JSON.parse(node(drawScript));
  } catch (err) {
    result = { opened: false, error: String(err.message).slice(0, 300) };
  }

  say(`  chart opened : ${result.opened ? 'YES' : 'NO'}`);
  if (result.notes && result.notes.length) say(`  notes        : ${result.notes.join(' | ')}`);
  if (result.error) say(`  open error   : ${result.error}`);
  if (result.opened) say(`  drawing      : ${result.drew ? 'LANDED' : 'FAILED — ' + (result.drawError || '')}`);

  // 3. Did the CLI calls or the chart open cost us the session?
  const after = credentialFingerprint();
  say(`  refresh expiry after: ${after}`);
  say(`  session survived    : ${after ? 'YES' : 'NO — the credential is gone'}`);

  const pass = result.opened && result.drew;
  say(pass ? 'PASS — the chart opened and the drawing landed AFTER CLI calls.' : 'FAIL — see above.');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  say(`watcher crashed: ${String(err && err.message)}`);
  process.exit(3);
});
