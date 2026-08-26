/**
 * The harvest and the logout, against a REAL browser, with no Stockbit involved.
 *
 * Two things in the already-signed-in ladder cannot be proved by a unit test, and both of them are
 * the kind of assumption that is right until it is not:
 *
 *   1. that `captureWebSession` really does read a cookie a page just set, in the shape
 *      `readCredentialStorage` expects — the two were written against a documented shape, never
 *      against a live browser round trip;
 *   2. that `Storage.clearDataForOrigin` actually clears it. That call is what the auto-logout tier
 *      is built on, and if it silently does nothing, the ladder's second rung re-opens the login
 *      page on a profile that is still signed in and the user watches it land in the app again.
 *
 * So: a `node:http` fixture on 127.0.0.1 sets a `credentialStorage` cookie in the observed shape, a
 * real Chromium loads it, and the REAL capture, reader and clear run against it. Modelled on the
 * chart-widget test in `test/chartbit.test.ts` and the capture self-test in `src/auth/doctor.ts`.
 *
 * `hostFilter` is the seam that makes this possible — the real predicate drops a 127.0.0.1 cookie,
 * as it should. It is the same kind of seam `captureViaBrowserLogin`'s `isTokenUrl` already is.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-webharvest-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CDP } from "../src/auth/cdp.ts";
import { launchDebuggableBrowser } from "../src/auth/launch.ts";
import { findBrowser } from "../src/auth/browsers.ts";
import { removeDirWithRetry } from "../src/auth/tempdir.ts";
import { captureWebSession, readCredentialStorage } from "../src/auth/websession.ts";
import { clearBrowserSession } from "../src/auth/login.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const browser = findBrowser();

/** A refresh token in the shape the site's cookie carries. Unsigned; nothing here verifies it. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.c2ln`;
}

const REFRESH = jwt({ exp: 2_000_000_000, iat: 1_700_000_000, sub: "harvest-fixture" });

/**
 * A page that installs the observed cookie shape, plus a Local Storage key so the capture's other
 * half is exercised too. The cookie is set by the page rather than by CDP on purpose: that is how
 * the real one arrives, and a `document.cookie` write is the part a `Storage.getCookies` read has
 * to see.
 */
const FIXTURE_PAGE = `<!doctype html>
<html><body><div id="app">signed in</div><script>
var blob = encodeURIComponent(JSON.stringify({
  state: { access: "access-token-placeholder", refresh: ${JSON.stringify(REFRESH)}, user: { id: 1 } },
  version: 0
}));
document.cookie = "credentialStorage=" + blob + "; path=/";
try { localStorage.setItem("stockbit-fixture-key", "fixture-value"); } catch (e) {}
window.__ready = true;
</script></body></html>`;

/** 127.0.0.1 stands in for stockbit.com. See the file note on why the seam exists. */
const localHost = (domain: string): boolean => domain.replace(/^\./, "") === "127.0.0.1";

test(
  "the browser's own credential is captured, read, and then cleared",
  { skip: browser ? false : "no drivable browser" },
  async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FIXTURE_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const profile = mkdtempSync(join(tmpdir(), "stockbit-webharvest-profile-"));

    const launched = await launchDebuggableBrowser({ bin: browser!, profileDir: profile, headless: true });
    const cdp = await CDP.connect(launched.wsUrl);

    try {
      const target = (await cdp.send("Target.createTarget", { url: `${origin}/` })) as { targetId: string };
      const attached = (await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })) as { sessionId: string };
      const sid = attached.sessionId;
      await cdp.send("Runtime.enable", {}, sid, 5_000).catch(() => {});

      // Wait for the page's own script to have run, rather than for a fixed delay.
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        const r = (await cdp.send(
          "Runtime.evaluate",
          { expression: "Boolean(window.__ready)", returnByValue: true },
          sid,
          5_000,
        )) as { result?: { value?: boolean } };
        ready = r.result?.value === true;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, "the fixture page never finished running its script");

      /* ---------------------------- capture, then read ---------------------------- */

      const captured = await captureWebSession(cdp, { hostFilter: localHost });
      assert.ok(captured, "the capture must find the cookie the page just set");
      assert.ok(
        captured!.cookies.some((c) => c.name === "credentialStorage"),
        "and specifically the one the credential lives in",
      );

      const harvested = readCredentialStorage(captured!, { hostFilter: localHost });
      assert.equal(
        harvested,
        REFRESH,
        "the reader must get the same token back out of a cookie a real browser round-tripped",
      );

      /* --------------------------------- clear --------------------------------- */

      const how = await clearBrowserSession(cdp, origin, sid);
      assert.notEqual(how, "failed", "the auto-logout tier is built on this call working");
      assert.equal(
        how,
        "origin",
        "the origin-scoped call must be the one that ran — at BROWSER level Chromium answers " +
          "'Internal error' and this silently fell through to the browser-wide fallback, which " +
          "clears everything rather than one origin",
      );

      const afterClear = await captureWebSession(cdp, { hostFilter: localHost });
      const stillThere = afterClear ? readCredentialStorage(afterClear, { hostFilter: localHost }) : null;
      assert.equal(
        stillThere,
        null,
        "after clearing, the credential must be gone — otherwise the ladder re-opens the login page " +
          "on a profile that is still signed in and the user watches it land in the app again",
      );
    } finally {
      cdp.close();
      launched.child.kill();
      server.close();
      await removeDirWithRetry(profile);
    }
  },
);
