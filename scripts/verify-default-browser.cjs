#!/usr/bin/env node
/**
 * Prove the server works in whatever browser the USER actually has — not in Chrome specifically.
 *
 * ## Why this exists
 *
 * The browser candidate table is a preference order with Chrome first, and preference order is the
 * wrong question to ask on someone else's machine. Measured on the machine this was written on: the
 * OS default was Opera, Chrome was installed for unrelated reasons, and `findBrowser()` returned
 * Chrome — so charting opened a browser the user does not use, holding a profile they never see, and
 * asked them to log in to Stockbit a second time inside it. A public user with no Chrome at all was
 * the case that made it obvious.
 *
 * Unit tests can pin the ORDERING. They cannot answer the question that actually matters: *can this
 * browser be driven?* Chartbit speaks the Chrome DevTools Protocol, and "Chromium-based" is not a
 * guarantee that remote debugging is reachable — some builds restrict it. So this launches each
 * drivable browser it finds, for real, and makes it evaluate something.
 *
 *   node scripts/verify-default-browser.cjs
 *
 * Every launch uses a THROWAWAY profile. It never touches `~/.stockbit/browser-profile`, never logs
 * in, and never opens the user's real session — so it is safe to run on a schedule.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const REPO = join(__dirname, '..');
const P = (rel) => JSON.stringify(join(REPO, rel));
const node = (code) =>
  execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* ------------------------------- selection ------------------------------- */

const info = JSON.parse(
  node(`
    const b = require(${P('dist/src/auth/browsers.js')});
    const dflt = b.defaultBrowserPath();
    process.stdout.write(JSON.stringify({
      dflt,
      family: dflt ? b.familyForPath(dflt) : null,
      chosen: b.findBrowser(),
      advice: b.defaultBrowserAdvice(),
      list: b.findBrowsers(),
    }));
  `),
);

console.log('BROWSER SELECTION');
console.log(`  OS default : ${info.dflt ?? '(none detected)'}${info.family ? ` [${info.family}]` : ''}`);
console.log(`  chosen     : ${info.chosen ?? '(none)'}`);

// A machine with no browser at all is a legitimate state; everything except charting still works.
if (info.list.length === 0) {
  console.log('  (no browsers found — nothing to drive, and that is not a failure)');
} else {
  // The invariant that must hold everywhere: never hand back something that cannot be driven.
  check(
    'findBrowser returns only a drivable browser',
    info.chosen === null || info.list.find((b) => b.path === info.chosen)?.supported === true,
  );

  // Drivable must always sort above un-drivable, or the line above could pick Firefox.
  let seenUnsupported = false;
  let ordered = true;
  for (const b of info.list) {
    if (!b.supported) seenUnsupported = true;
    else if (seenUnsupported) ordered = false;
  }
  check('drivable browsers sort above un-drivable ones', ordered);

  if (info.dflt && info.family === 'chromium') {
    check(
      'a drivable OS default is the one chosen',
      info.chosen && info.chosen.toLowerCase() === info.dflt.toLowerCase(),
      `chose ${info.chosen}`,
    );
    check('no advice is offered when the default works', info.advice === null);
  } else if (info.dflt) {
    // Safari or Firefox. Not an error — a recommendation, and it must name what to install.
    check('an un-drivable default is explained', typeof info.advice === 'string' && info.advice.length > 0);
    check(
      'the advice names the protocol and says the rest still works',
      Boolean(info.advice && /Chrome DevTools Protocol/.test(info.advice) && /unaffected|Everything else/.test(info.advice)),
    );
  }
}

/* ------------------------- can each one be driven? ------------------------- */

console.log('');
console.log('LIVE DRIVE (throwaway profile — never touches the real session)');

for (const b of info.list.filter((x) => x.supported)) {
  let out;
  try {
    out = node(`
      (async () => {
        const { launchDebuggableBrowser } = require(${P('dist/src/auth/launch.js')});
        const { CDP } = require(${P('dist/src/auth/cdp.js')});
        const { mkdtempSync, rmSync } = require('node:fs');
        const { tmpdir } = require('node:os');
        const { join } = require('node:path');
        const profile = mkdtempSync(join(tmpdir(), 'sb-drive-'));
        const r = { ok: false };
        let launched = null, cdp = null;
        try {
          launched = await launchDebuggableBrowser({ bin: ${JSON.stringify(b.path)}, profileDir: profile, headless: true });
          cdp = await CDP.connect(launched.wsUrl);
          const t = await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, 15000);
          const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, undefined, 15000);
          const e = await cdp.send('Runtime.evaluate', { expression: '6*7', returnByValue: true }, a.sessionId, 15000);
          r.ok = e && e.result && e.result.value === 42;
        } catch (err) {
          r.error = String(err && err.message).slice(0, 140);
        } finally {
          try { cdp && cdp.close(); } catch {}
          try { launched && launched.child.kill(); } catch {}
          try { rmSync(profile, { recursive: true, force: true }); } catch {}
        }
        process.stdout.write(JSON.stringify(r));
      })();
    `);
  } catch (err) {
    out = JSON.stringify({ ok: false, error: String(err.message).slice(0, 140) });
  }
  const r = JSON.parse(out);
  check(`${b.name} is CDP-drivable${b.isDefault ? '  (the OS default)' : ''}`, r.ok, r.error);
}

/* ------------------------------- login age ------------------------------- */

console.log('');
console.log('STATUS REPORTS THE LOGIN AGE');

const status = JSON.parse(
  node(`
    (async () => {
      const { collectStatus, formatStatus } = require(${P('dist/src/status.js')});
      const rep = await collectStatus();
      process.stdout.write(JSON.stringify({ store: rep.store, text: formatStatus(rep) }));
    })();
  `),
);

check('the report carries loggedInAt and loginAgeHours', 'loggedInAt' in status.store && 'loginAgeHours' in status.store);
check('the terminal output has a "Last login" line', /Last login\s+\S/.test(status.text), (/Last login\s+(.+)/.exec(status.text) || [])[1]);
check('it never renders NaN or a 1970 age', !/NaN|Invalid Date|56\.\d year/.test(status.text));
check('the report names the OS default browser', 'defaultBrowser' in status.store);

console.log('');
if (failures === 0) {
  console.log('PASS — the server drives whatever browser this machine actually has.');
  process.exit(0);
}
console.log(`FAIL — ${failures} check(s) failed.`);
process.exit(1);
