#!/usr/bin/env node
/**
 * Prove that a token rotation carries across to the browser's copy.
 *
 * ## Why this exists
 *
 * Every other check in this repo measures a session that is ALREADY aligned, and confirms nothing
 * disturbed it. None of them rotate, so none of them could see the failure that actually bites:
 * roughly 24 hours after each login the CLI's access token lapses, the next request refreshes, and
 * the refresh retires the pair the browser is holding. Chart goes blank on a session with days left.
 *
 * That is invisible to a green test suite and to a passing multi-symbol run. It needs a test that
 * spends the family on purpose and then asks whether the browser came along.
 *
 *   node scripts/verify-rotation.cjs [--yes]
 *
 * ## What it costs
 *
 * One rotation — the same one that would happen on its own at the access token's expiry. If
 * `alignStoredCredential` works, the browser follows and nothing is lost. If it does not, the website
 * session is retired and a `stockbit-auth login` is needed. That is the honest price of proving it,
 * and it is why `--yes` is required.
 *
 * The check is NOT "did the CLI get a new token" — it always does. It is:
 *   1. the generation changed (a rotation really happened), and
 *   2. the browser's cookie holds the NEW pair, not the retired one, and
 *   3. the new pair kept the same `ses` and `dvc` device binding, and
 *   4. the new token is accepted on a real request.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const REPO = join(__dirname, '..');
const P = (rel) => JSON.stringify(join(REPO, rel));
const node = (code) =>
  execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha = (t) => (t ? createHash('sha256').update(t).digest('hex').slice(0, 8) : '-');

/** Both copies of the pair, by hash and binding. Never prints a token. */
function snapshot() {
  return JSON.parse(
    node(`
      const ws = require(${P('dist/src/auth/websession.js')});
      const { getStore } = require(${P('dist/src/auth/store.js')});
      const { decodeJwt } = require(${P('dist/src/auth/session.js')});
      const ac = require(${P('dist/src/auth/accesscache.js')});
      const s = ws.loadWebSession();
      let ba = null, br = null;
      if (s) {
        const c = s.cookies.find((x) => x.name === 'credentialStorage');
        if (c) {
          let p = null;
          for (const v of [c.value, decodeURIComponent(c.value)]) { try { p = JSON.parse(v); break; } catch {} }
          ba = p && p.state && p.state.access ? p.state.access.token : null;
          br = p && p.state && p.state.refresh ? p.state.refresh.token : null;
        }
      }
      const cliR = getStore('main').get();
      const cached = ac.loadAccess('main', 0);
      const bind = (t) => { try { const d = decodeJwt(t).data || {}; return d.ses + '|' + d.dvc; } catch { return null; } };
      process.stdout.write(JSON.stringify({
        browserAccess: ba, browserRefresh: br,
        cliRefresh: cliR, cliAccess: cached ? cached.token : null,
        jti: (() => { try { return decodeJwt(cliR).jti; } catch { return null; } })(),
        binding: bind(cliR),
      }));
    `),
  );
}

function show(label, s) {
  console.log(`${label}`);
  console.log(`  refresh  cli ${sha(s.cliRefresh)}   browser ${sha(s.browserRefresh)}   ${s.cliRefresh === s.browserRefresh ? 'SAME' : 'DIFFERENT'}`);
  console.log(`  access   cli ${sha(s.cliAccess)}   browser ${sha(s.browserAccess)}   ${s.cliAccess === s.browserAccess ? 'SAME' : 'DIFFERENT'}`);
  console.log(`  jti ${String(s.jti).slice(0, 8)}   binding ${sha(s.binding)}`);
}

const before = snapshot();
show('BEFORE', before);

if (before.cliRefresh !== before.browserRefresh) {
  console.log('\nABORT — the two copies already differ, so a rotation would prove nothing about');
  console.log('        alignment. Run `stockbit-auth login` first.');
  process.exit(2);
}
if (!process.argv.includes('--yes')) {
  console.log('\nThis spends one rotation. Re-run with --yes to proceed.');
  process.exit(0);
}

console.log('\nrotating...');
const refreshed = JSON.parse(
  node(`
    (async () => {
      const { rotateNow } = require(${P('dist/src/auth/session.js')});
      const out = {};
      try { await rotateNow('main'); out.ok = true; }
      catch (e) { out.ok = false; out.error = String(e && e.message).slice(0, 200); }
      process.stdout.write(JSON.stringify(out));
    })();
  `),
);
if (!refreshed.ok) {
  console.log(`  refresh FAILED: ${refreshed.error}`);
  process.exit(1);
}

const after = snapshot();
console.log('');
show('AFTER', after);

const rotated = after.cliRefresh !== before.cliRefresh;
const followed = after.browserRefresh === after.cliRefresh;
const bindingKept = after.binding === before.binding;

const live = JSON.parse(
  node(`
    (async () => {
      const { ensureFresh } = require(${P('dist/src/auth/session.js')});
      const { authenticatedRequest } = require(${P('dist/src/http/transport.js')});
      const r = {};
      try {
        const res = await authenticatedRequest('watchlists', { token: await ensureFresh('main') });
        r.status = res.status; r.ok = res.ok; await res.text();
      } catch (e) { r.ok = false; r.error = String(e && e.message).slice(0, 200); }
      process.stdout.write(JSON.stringify(r));
    })();
  `),
);

console.log('');
console.log(`  1. rotation happened          ${rotated ? 'yes' : 'NO — nothing was spent, this proved nothing'}`);
console.log(`  2. browser followed the pair  ${followed ? 'yes' : 'NO — the cookie holds a retired generation'}`);
console.log(`  3. device binding preserved   ${bindingKept ? 'yes' : 'NO — ses/dvc changed'}`);
console.log(`  4. new token accepted live    ${live.ok ? 'yes' : `NO (${live.status ?? live.error})`}`);
console.log('');

if (rotated && followed && bindingKept && live.ok) {
  console.log('PASS — a rotation carried across to the browser. The 24h expiry no longer logs the chart out.');
  console.log('       Open a chart to confirm the page itself accepts it.');
  process.exit(0);
}
console.log('FAIL — see above. If the browser did not follow, run `stockbit-auth login`.');
process.exit(1);
