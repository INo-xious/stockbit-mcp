/**
 * Watch Stockbit's own client fetch the shareholder chart, and report WHERE it puts the token.
 *
 * ## Why this cannot be settled any other way
 *
 * `getShareholders` mints a one-shot token and then sends it as a `token` QUERY PARAMETER, under a
 * comment that always said the placement was unverified. It is wrong: measured 2026-09-01, the
 * chart answers the identical 401 `WebViewToken.FromContext: User Not Found` with a valid token,
 * with no token, and with a junk one. So no VALUE fixes it and the parameter is not what the
 * endpoint reads. The remaining candidates — a header, or a POST body — cannot be told apart by
 * sending more requests of our own, because every one of them fails at the same gate. The only
 * thing that distinguishes them is a request that WORKS, and the only client making one is
 * Stockbit's own page.
 *
 * So this drives a real browser, lets the user sign in, and records what the page does.
 *
 * ## It never prints the token
 *
 * The mint's response body is read, and that value is a live credential. It is used ONLY as a
 * needle: every header value, query parameter and body field of the chart request is compared
 * against it, and what gets printed is the NAME of whatever matched. A location is far more useful
 * than the secret anyway, and a capture log is a thing people paste into issues.
 *
 * Header names are printed in full because they are not secret and the whole answer is likely to
 * be one of them. Header VALUES are never printed — only a shape (`<64 hex>`, `<jwt>`, `<48 chars>`).
 *
 * ## Usage
 *
 *     node --import tsx scripts/capture-shareholders-token.ts [SYMBOL]
 *
 * A window opens on the stored Stockbit profile. Sign in if asked, then open that symbol's
 * ownership / shareholder chart. The script prints its findings and exits when it has seen the
 * chart request, or after the timeout.
 */
import { findBrowser } from "../src/auth/browsers.js";
import { launchDebuggableBrowser } from "../src/auth/launch.js";
import { CDP } from "../src/auth/cdp.js";
import { stockbitPath } from "../src/paths.js";

const SYMBOL = (process.argv[2] ?? "BBRI").toUpperCase();
const TIMEOUT_MS = 8 * 60_000;
const ARM_MS = 5_000;

/** Describe a string without disclosing it. */
function shape(value: string): string {
  const n = value.length;
  if (/^[0-9a-f]{32,}$/i.test(value)) return `<${n} hex chars>`;
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return "<jwt>";
  if (/^Bearer /i.test(value)) return `<Bearer + ${n - 7} chars>`;
  return `<${n} chars>`;
}

/** Header names are safe to show; values never are. */
function headerSummary(headers: Record<string, string>): string[] {
  return Object.entries(headers).map(([k, v]) => `${k}: ${shape(String(v))}`);
}

/**
 * Where does `needle` appear in this request? Names only.
 *
 * Substring rather than equality on header values, because a token presented as `Bearer <token>`
 * or `token=<token>` inside a compound header still answers the question being asked.
 */
function locateNeedle(
  needle: string,
  url: string,
  headers: Record<string, string>,
  postData: string | undefined,
): string[] {
  const found: string[] = [];
  if (needle.length < 8) return found;
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams) if (v.includes(needle)) found.push(`QUERY PARAM \`${k}\``);
  } catch {
    /* not a parseable URL */
  }
  for (const [k, v] of Object.entries(headers)) {
    if (String(v).includes(needle)) found.push(`HEADER \`${k}\``);
  }
  if (postData?.includes(needle)) found.push("POST BODY");
  return found;
}

const bin = findBrowser();
if (!bin) {
  process.stderr.write("No Chromium-family browser found. Install Chrome, or set one up with `stockbit-auth doctor`.\n");
  process.exit(2);
}

const profileDir = stockbitPath("browser-profile");
process.stderr.write(`Opening ${bin}\n  profile: ${profileDir}\n`);

let browser;
try {
  browser = await launchDebuggableBrowser({ bin, profileDir, headless: false });
} catch (error) {
  // #6: orphaned Chrome processes holding this user-data-dir block every later launch.
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n` +
      "If that is the 'exited immediately' case, a previous browser is still holding the profile.\n" +
      `Check with:  pgrep -fl "user-data-dir=${profileDir}"\n`,
  );
  process.exit(2);
}

const cdp = await CDP.connect(browser.wsUrl);

/** requestId -> what we saw go out, so a response can be matched back to it. */
const sent = new Map<string, { url: string; method: string; headers: Record<string, string>; postData?: string }>();
/** The minted token, used only as a needle. Never printed. */
let mintedToken: string | undefined;
let reported = false;

const isTokenMint = (url: string) => /\/shareholders\/token/.test(url);
const isChart = (url: string) => /\/shareholders\/.*\/chart/.test(url);

function report(): void {
  if (reported) return;
  const chart = [...sent.values()].find((r) => isChart(r.url));
  if (!chart) return;
  reported = true;

  const out: string[] = [];
  out.push("");
  out.push("=".repeat(72));
  out.push("SHAREHOLDER CHART REQUEST, as Stockbit's own client sends it");
  out.push("=".repeat(72));
  out.push(`method : ${chart.method}`);
  try {
    const u = new URL(chart.url);
    out.push(`path   : ${u.pathname}`);
    out.push(`query  : ${[...u.searchParams.keys()].join(", ") || "(none)"}`);
  } catch {
    out.push(`url    : ${chart.url}`);
  }
  out.push(`body   : ${chart.postData === undefined ? "(none)" : `${chart.postData.length} bytes`}`);
  out.push("headers:");
  for (const line of headerSummary(chart.headers)) out.push(`  ${line}`);

  out.push("");
  if (mintedToken) {
    const where = locateNeedle(mintedToken, chart.url, chart.headers, chart.postData);
    out.push(
      where.length
        ? `>>> THE MINTED TOKEN TRAVELS IN: ${where.join(" and ")}`
        : ">>> The minted token appears NOWHERE in this request. The chart is authorised by " +
          "something else — most likely the ordinary session cookie or bearer — and the mint may " +
          "not gate this call at all.",
    );
  } else {
    out.push(
      "!!! The token mint was never seen, so nothing could be correlated. Header names above are " +
        "still the answer if one of them is obviously the webview token.",
    );
  }
  out.push("=".repeat(72));
  process.stdout.write(`${out.join("\n")}\n`);
}

async function arm(sid?: string): Promise<void> {
  await cdp.send("Network.enable", {}, sid, ARM_MS).catch(() => {});
  if (sid) {
    await cdp
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid, ARM_MS)
      .catch(() => {});
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid, ARM_MS).catch(() => {});
  }
}

cdp.on("Target.attachedToTarget", (p) => void arm((p as { sessionId?: string }).sessionId));

cdp.on("Network.requestWillBeSent", (p) => {
  const params = p as { requestId: string; request?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string } };
  const url = params.request?.url ?? "";
  if (!/shareholders/.test(url)) return;
  sent.set(params.requestId, {
    url,
    method: params.request?.method ?? "?",
    headers: params.request?.headers ?? {},
    postData: params.request?.postData,
  });
  process.stderr.write(`  saw ${params.request?.method ?? "?"} ${url.replace(/token=[^&]+/, "token=<redacted>")}\n`);
});

cdp.on("Network.loadingFinished", (p) => {
  const { requestId } = p as { requestId: string };
  const seen = sent.get(requestId);
  if (!seen) return;
  void (async () => {
    if (isTokenMint(seen.url) && !mintedToken) {
      const body = await cdp.send("Network.getResponseBody", { requestId }, undefined, ARM_MS).catch(() => undefined);
      const text = (body as { body?: string } | undefined)?.body;
      if (text) {
        // Pull the longest token-shaped string out of the mint response. Never printed.
        const candidates = text.match(/[A-Za-z0-9._-]{20,}/g) ?? [];
        mintedToken = candidates.sort((a, b) => b.length - a.length)[0];
        process.stderr.write(`  mint captured (${mintedToken ? shape(mintedToken) : "no token-shaped field"})\n`);
      }
    }
    if (isChart(seen.url)) report();
  })();
});

await arm();
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});

const page = `https://stockbit.com/symbol/${SYMBOL}`;
await cdp.send("Target.createTarget", { url: page }).catch(() => {});

process.stderr.write(
  `\nA window is open at ${page}.\n` +
    "  1. Sign in if it asks.\n" +
    `  2. Open ${SYMBOL}'s OWNERSHIP / shareholder view (the one that draws the holder chart).\n` +
    "  3. Leave it a moment — this exits as soon as it sees the chart request.\n\n",
);

const finished = new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    if (reported) {
      clearInterval(timer);
      resolve();
    }
  }, 250);
  setTimeout(() => {
    clearInterval(timer);
    resolve();
  }, TIMEOUT_MS).unref?.();
  cdp.onClose(() => {
    clearInterval(timer);
    resolve();
  });
});

await finished;
if (!reported) {
  process.stderr.write("\nNo shareholder-chart request was seen before the window closed or timed out.\n");
}
cdp.close();
browser.child.kill();
process.exit(reported ? 0 : 1);
