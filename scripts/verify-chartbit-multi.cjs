#!/usr/bin/env node
/**
 * Prove Chartbit across MANY symbols, not one.
 *
 * A single chart opening proves very little. It was the second symbol that exposed the real problem
 * last time: BBRI drew fine, ANTM came back blank, and the cause was a stale MCP process from before
 * the fix rotating the token family out from under the browser. One sample would have shipped that.
 *
 * So this walks a list, and between symbols it does the thing that used to break everything — a CLI
 * call in a SEPARATE process — then checks the browser and the CLI are still on the same token
 * generation. A pass means every symbol opened, drew, and left the session intact.
 *
 *   node scripts/verify-chartbit-multi.cjs [--symbols BBRI,ANTM,INET,TLKM,BBCA,GOTO] [--keep]
 *
 * Draws one clearly-labelled level per symbol and removes it again unless --keep is passed, so the
 * user's own chart is left as it was found.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const REPO = join(__dirname, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SYMBOLS = arg('--symbols', 'BBRI,ANTM,INET,TLKM,BBCA,GOTO').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = process.argv.includes('--keep');

function node(code) {
  return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Are the browser and the CLI on the same token generation? */
function generations() {
  const out = node(`
    const ws=require(${JSON.stringify(join(REPO, 'dist/src/auth/websession.js'))});
    const {getStore}=require(${JSON.stringify(join(REPO, 'dist/src/auth/store.js'))});
    const {decodeJwt}=require(${JSON.stringify(join(REPO, 'dist/src/auth/session.js'))});
    const s=ws.loadWebSession();
    let b=null;
    try{ b=decodeJwt(JSON.parse(decodeURIComponent(s.cookies.find(x=>x.name==='credentialStorage').value)).state.refresh.token).jti; }catch{}
    let c=null;
    try{ c=decodeJwt(getStore('main').get()).jti; }catch{}
    const h=ws.webSessionHealth();
    process.stdout.write(JSON.stringify({browser:b,cli:c,days:h.refreshHoursLeft===null?null:h.refreshHoursLeft/24}));
  `);
  return JSON.parse(out);
}

/**
 * One CLI call in a fresh process — the step that used to revoke the browser's session.
 *
 * This used to call `ensureFresh` and nothing else, which made it a probe that could not fail. With a
 * warm access-token cache `ensureFresh` returns from disk and issues ZERO requests: it never presents
 * the token, so it never meets the 401 that triggers rotation, and the step this test exists to
 * exercise did not happen. It also swallowed every error and its return value was discarded, so a
 * green run and a broken session were indistinguishable.
 *
 * Now it SPENDS the token: a real authenticated read against `/watchlist`, whose HTTP status is the
 * observation. 401 is the interesting case — it is what drives `forceRefresh`, and therefore the only
 * path on which a CLI call can rotate the family out from under the chart.
 */
function cliCall() {
  try {
    const out = node(`
      (async () => {
        const { ensureFresh } = require(${JSON.stringify(join(REPO, 'dist/src/auth/session.js'))});
        const { authenticatedRequest } = require(${JSON.stringify(join(REPO, 'dist/src/http/transport.js'))});
        const r = { ok: false };
        try {
          const token = await ensureFresh('main');
          const res = await authenticatedRequest('watchlists', { token });
          r.status = res.status;
          r.ok = res.ok;
          await res.text();
        } catch (e) {
          r.error = String(e && e.message).slice(0, 200);
        }
        process.stdout.write(JSON.stringify(r));
      })();
    `);
    return JSON.parse(out);
  } catch (err) {
    return { ok: false, error: String(err.message).slice(0, 200) };
  }
}

function openDrawCheck(symbol) {
  const code = `
    (async () => {
      const driver = require(${JSON.stringify(join(REPO, 'dist/src/chartbit/driver.js'))});
      const out = { symbol: ${JSON.stringify(symbol)} };
      try {
        const st = await driver.openChart({ symbol: ${JSON.stringify(symbol)} });
        out.opened = true; out.widgetKey = st.widgetKey ?? null;
      } catch (e) { out.opened = false; out.error = String(e && e.message).slice(0, 220); }
      if (out.opened) {
        try {
          const r = await driver.drawAnnotations({
            symbol: ${JSON.stringify(symbol)},
            anchorDate: new Date().toISOString().slice(0,10),
            replace: true,
            annotations: [{ kind: 'level', price: 1, label: 'multi-symbol session check' }],
          });
          out.drawn = r && typeof r.drawn === 'number' ? r.drawn : null;
          out.failed = r && r.failed ? r.failed.length : null;
        } catch (e) { out.drawn = 0; out.drawError = String(e && e.message).slice(0, 220); }
        ${KEEP ? '' : `
        try { await driver.clearDrawings({ symbol: ${JSON.stringify(symbol)}, scope: 'ours' }); out.cleaned = true; }
        catch { out.cleaned = false; }`}
      }
      process.stdout.write(JSON.stringify(out));
    })();
  `;
  try {
    return JSON.parse(node(code));
  } catch (err) {
    return { symbol, opened: false, error: String(err.message).slice(0, 220) };
  }
}

const start = generations();
console.log('START');
console.log(`  browser ${String(start.browser).slice(0, 8)}  cli ${String(start.cli).slice(0, 8)}  ${start.browser === start.cli ? 'ALIGNED' : 'DIVERGED'}`);
console.log(`  refresh token: ${start.days === null ? 'unknown' : start.days.toFixed(2) + ' day(s)'}`);
console.log('');

if (start.browser !== start.cli) {
  console.log('ABORT — the browser is on a retired generation. Log in first; this test would only');
  console.log('        re-measure a session that is already dead, which proves nothing.');
  process.exit(2);
}

const rows = [];
for (const symbol of SYMBOLS) {
  process.stdout.write(`${symbol.padEnd(6)} `);
  const r = openDrawCheck(symbol);
  const g = generations();
  const aligned = g.browser === g.cli;
  const ok = r.opened && r.drawn > 0 && aligned;
  rows.push({ symbol, ...r, aligned, ok });
  console.log(
    `open=${r.opened ? 'yes' : 'NO '} draw=${r.drawn ?? '-'} failed=${r.failed ?? '-'} session=${aligned ? 'aligned' : 'DIVERGED'} ${ok ? 'PASS' : 'FAIL'}`,
  );
  if (!r.opened && r.error) console.log(`       ${r.error}`);
  if (r.drawError) console.log(`       ${r.drawError}`);

  // The step that used to break everything, between symbols. Its RESULT is now checked: a swallowed
  // failure here is what let an earlier run report a healthy session it had never actually tested.
  const call = cliCall();
  const g2 = generations();
  if (!call.ok) {
    console.log(`       !! the CLI read failed (${call.status ?? call.error}) — the token was not accepted`);
    rows[rows.length - 1].ok = false;
  }
  if (g2.browser !== g2.cli) {
    console.log(`       !! a CLI call DIVERGED the generation — this is the original bug`);
    rows[rows.length - 1].ok = false;
  }
}

const end = generations();
console.log('');
console.log('END');
console.log(`  browser ${String(end.browser).slice(0, 8)}  cli ${String(end.cli).slice(0, 8)}  ${end.browser === end.cli ? 'ALIGNED' : 'DIVERGED'}`);
console.log(`  refresh token: ${end.days === null ? 'unknown' : end.days.toFixed(2) + ' day(s)'}`);
console.log('');

const passed = rows.filter((r) => r.ok).length;
console.log(`${passed}/${rows.length} symbols passed`);
const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.symbol).join(', '));
  process.exit(1);
}
console.log('PASS — every symbol opened, drew, and left the session intact across CLI calls.');
