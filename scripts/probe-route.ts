/**
 * One ad-hoc request against one declared route, printed raw.
 *
 * ## Why this exists
 *
 * Five Phase-4 tools cannot be settled by reading code: what `trade_book` calls its grouping key,
 * which values it takes, where the shareholder chart wants its minted token, whether
 * `/chartbit/chart-drawings` accepts a chart id decoded out of a layout. CLAUDE.md's rule for all
 * of them is the same — "Settling one takes a live call, not an edit" — and until now there was no
 * way to make one. None of the five bins offers it: `stockbit-auth` does credential lifecycle,
 * `stockbit-live` and `stockbit-batch` call fixed readers, and `stockbit-batch probe` writes the
 * PROJECTED payload rather than the wire body, which is the half a projection bug hides in.
 *
 * ## What it does and does not permit
 *
 * It reaches Stockbit through `getJson`, so it goes through the closed route table like everything
 * else: a route NAME is the only way to name a host and a path, and an unknown name is refused
 * here with the list. It cannot invent an endpoint. What it can do that no tool can is send a
 * query parameter no tool declares — which needs no route-table edit and no ADR, because
 * `RouteSpec` constrains host, method, template and auth kind and says nothing about params.
 *
 * That is the whole point: probing a candidate parameter is exactly how `order_by` and the plural
 * `symbols` on running trade were settled on 2026-08-28.
 *
 * ## Reading the output
 *
 * The body is printed whole and unprojected, and a failure prints its status and message rather
 * than a stack — a 400 naming a parameter IS the result you came for. Everything goes through
 * `redactValue`/`redact` first: the shareholder chart takes its token as a query parameter, so the
 * URL of that probe contains a credential, and a probe log is a thing people paste.
 *
 * ## Usage
 *
 *     node --import tsx scripts/probe-route.ts <routeName> [key=value ...] [--segment name=value]
 *
 *     node --import tsx scripts/probe-route.ts tradeBook symbol=BBRI group_by=1
 *     node --import tsx scripts/probe-route.ts runningTrade order_by=1 symbols=BBRI limit=101
 *     node --import tsx scripts/probe-route.ts chartbitDrawings layout_id=8801 chart_id=1
 *     node --import tsx scripts/probe-route.ts shareholdingCompanies --segment companyId=134
 *
 * Repeat a key to send it repeated rather than joined (`data_mode=A data_mode=B`), which is the
 * form this API reads.
 */
import { getJson } from "../src/http/client.js";
import { ROUTES, type RouteName, type QueryParams, type Segments } from "../src/http/transport.js";
import { StockbitError } from "../src/http/errors.js";
import { redact, redactValue } from "../src/redact.js";

function fail(message: string): never {
  process.stderr.write(`${redact(message)}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const routeName = argv[0];
if (!routeName || routeName === "--help" || routeName === "-h") {
  fail(
    "usage: probe-route.ts <routeName> [key=value ...] [--segment name=value]\n" +
      `known routes: ${Object.keys(ROUTES).sort().join(", ")}`,
  );
}
if (!(routeName in ROUTES)) {
  // Named rather than sent. A typo'd route is the one mistake this script must not turn into a
  // request to a path nobody meant.
  const near = Object.keys(ROUTES)
    .filter((n) => n.toLowerCase().includes(routeName.toLowerCase().slice(0, 6)))
    .sort();
  fail(`Unknown route ${JSON.stringify(routeName)}.${near.length ? ` Did you mean: ${near.join(", ")}` : ""}`);
}

const route = ROUTES[routeName as RouteName];
const params: QueryParams = {};
const segments: Segments = {};

for (let i = 1; i < argv.length; i++) {
  const arg = argv[i] as string;
  if (arg === "--segment") {
    const pair = argv[++i];
    if (!pair?.includes("=")) fail("--segment needs name=value");
    const [name, ...rest] = pair.split("=");
    (segments as Record<string, string>)[name as string] = rest.join("=");
    continue;
  }
  if (!arg.includes("=")) fail(`Expected key=value, got ${JSON.stringify(arg)}`);
  const [key, ...rest] = arg.split("=");
  const value = rest.join("=");
  const existing = params[key as string];
  // A repeated key becomes a repeated parameter, because this API reads only the first item out of
  // a comma-joined list and answers 200 — a narrower answer rather than an error.
  params[key as string] =
    existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [String(existing), value];
}

process.stderr.write(`${route.method} ${route.host}${route.template}  (auth: ${route.auth})\n`);

try {
  const body = await getJson(routeName as RouteName, { segments, params });
  process.stdout.write(`${JSON.stringify(redactValue(body), null, 2)}\n`);
} catch (error) {
  if (error instanceof StockbitError) {
    // The interesting case. A 400 that names the parameter it wanted is the answer, not a crash.
    process.stderr.write(
      `${JSON.stringify({ kind: error.kind, status: error.status, message: redact(error.message) }, null, 2)}\n`,
    );
    process.exit(1);
  }
  throw error;
}
