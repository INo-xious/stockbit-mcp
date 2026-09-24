/** Live, read-only protocol sweep. Reports coverage without storing account/market payloads. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { summarizeVerificationFailure, verificationSkipReason, type VerificationFailure } from "./verify-tools-policy.js";

if (!process.argv.includes("--live")) {
  console.error("Usage: npm run verify:tools -- --live [--only name,name] [--output path.json]\n" +
    "Uses your saved session for reads. Never executes account writes, virtual orders, or browser actions.\n" +
    "Run npm test for isolated mutation, confirmation and error-path coverage.");
  process.exit(2);
}
process.env.STOCKBIT_NO_UPDATE_CHECK = "1";
process.env.STOCKBIT_NO_BROWSER = "1";
process.env.STOCKBIT_AUTO_RELOGIN = "0";
const { createServer } = await import("../src/server.js");
const { parseToolProfile } = await import("../src/tools/_profile.js");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const only = flag("--only")?.split(",");
const output = resolve(flag("--output") ?? ".stockbit/verification.json");
const server = createServer({ profile: parseToolProfile("all") });
const client = new Client({ name: "stockbit-verification", version: "1.0.0" });
const [left, right] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(right), client.connect(left)]);

type JsonSchema = { type?: string; enum?: unknown[]; const?: unknown; default?: unknown; minimum?: number;
  anyOf?: JsonSchema[]; properties?: Record<string, JsonSchema>; required?: string[] };
type Row = { name: string; family: unknown; status: string; note?: string; milliseconds?: number } &
  Partial<Pick<VerificationFailure, "errorKind" | "httpStatus" | "protocolCode">>;
const report: Row[] = [];
// Rendering tools always write files. Keep those artifacts in a private temporary directory, away
// from the user's chart/Pine files, and remove them on completion or ordinary termination.
const artifactDir = mkdtempSync(join(tmpdir(), "stockbit-verification-"));
const cleanArtifacts = () => rmSync(artifactDir, { recursive: true, force: true });
const interrupt = () => { cleanArtifacts(); process.exit(130); };
const terminate = () => { cleanArtifacts(); process.exit(143); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
const samples: Record<string, unknown> = {
  symbol: "BBRI", symbols: ["BBRI", "TLKM"], broker_code: "YP", keyword: "BBRI",
  index_code: "LQ45", limit: 5, left: "close", op: ">", right: 0,
  entry_price: 4000, stop_price: 3800, risk_idr: 100000,
};
const overrides: Record<string, Record<string, unknown>> = {
  status: { live: false }, scan: { symbols: ["BBRI"], max_symbols: 1, max_seconds: 20 },
  backtest: { strategy: "sma_cross", bars: 150 }, strategy_compare: { strategies: ["sma_cross"], bars: 150 },
  technicals: { bars: 150 }, timeframe_alignment: { bars: 250 },
  analyze: { bars: 150, include_sentiment: false },
  broker_distribution: { open_in_stockbit: false, save_path: join(artifactDir, "brokers.svg") },
  price_chart: { bars: 150, open_in_stockbit: false, save_path: join(artifactDir, "prices.svg") },
  pine_script: { include_levels: false, save_dir: artifactDir },
  alert_check: { dry_run: true },
  position_size: { risk_idr: 100000 }, trade_book: { symbol: "BBRI", group_by: "1" }, prices_batch: { symbols: ["BBRI"] },
  underwriters: { underwriter_code: "YP" },
  shareholding: { mode: "composition", symbol: "BBRI" },
  screener: { catalogue: true },
};
const discovered: Record<string, unknown> = {};
const prerequisite: Record<string, string> = {
  chartbit_layout: "layout_id", chartbit_drawings: "layout_id", watchlist_symbols: "watchlist_id", watchlist_search: "watchlist_id",
  order_detail: "order_id", stream_post_detail: "post_id", stream_user: "username",
  sector_companies: "sector_id", insider_ownership: "insider", screener_run: "rules",
  eipo_detail: "emiten_code", eipo_status: "emiten_code", eipo_my_order: "emiten_code", eipo_unboxing: "emiten_code",
};

function findValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  if (!Array.isArray(value)) for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  for (const child of Object.values(value)) {
    const found = findValue(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
function sample(key: string, schema: JsonSchema): unknown {
  if (key in discovered) return discovered[key];
  if (key in samples) return samples[key];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.anyOf) for (const alternative of schema.anyOf) {
    const value = sample(key, alternative);
    if (value !== undefined) return value;
  }
  return undefined; // Unknown identifiers are not invented just to make the call run.
}
function learn(name: string, data: unknown): void {
  const mappings: Record<string, [string, string[]][]> = {
    watchlist: [["watchlist_id", ["id", "watchlist_id"]]],
    chartbit_layouts: [["layout_id", ["id"]]],
    orders: [["order_id", ["orderId", "order_id", "id"]]],
    stream: [["post_id", ["stream_id", "post_id"]], ["username", ["username"]]],
    sectors: [["sector_id", ["sector_id", "id"]]],
    insider_transactions: [["insider", ["insiderId", "insider_id"]]],
    eipo_list: [["emiten_code", ["emiten_code"]]],
  };
  for (const [key, wireKeys] of mappings[name] ?? []) {
    const value = findValue(data, wireKeys);
    if (value !== undefined) discovered[key] = value;
  }
  if (name === "screener") {
    // Catalogue groups also have fitem_id (e.g. Size), but are not runnable metrics.
    // Choose the observed Market Cap leaf instead of submitting a group ID as a filter.
    const metricLeaf = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const row = value as Record<string, unknown>;
      if (row.fitem_name === "Market Cap" && ["string", "number"].includes(typeof row.fitem_id)) {
        return String(row.fitem_id);
      }
      for (const child of Object.values(value)) {
        const result = metricLeaf(child);
        if (result !== undefined) return result;
      }
      return undefined;
    };
    const metric = metricLeaf(data);
    if (metric !== undefined) discovered.rules = [{ metric: String(metric), operator: ">", value: 0 }];
  }
}

try {
  const { tools } = await client.listTools();
  const known = new Set(tools.map(t => t.name));
  if (only?.some(name => !known.has(name))) throw new Error("--only contains an unregistered tool");
  for (const tool of tools) {
    if (only && !only.includes(tool.name)) continue;
    const row: Row = { name: tool.name, family: tool._meta?.["stockbit-mcp/family"], status: "not-run" };
    report.push(row);
    const skipReason = verificationSkipReason(tool.name, tool.annotations?.readOnlyHint === true);
    if (skipReason) {
      row.note = skipReason;
      continue;
    }
    const dependency = prerequisite[tool.name];
    if (dependency && discovered[dependency] === undefined) {
      row.status = "blocked";
      row.note = `No verified ${dependency} available from prerequisite reads.`;
      continue;
    }
    const schema = tool.inputSchema as JsonSchema;
    const args: Record<string, unknown> = { ...(overrides[tool.name] ?? {}) };
    // Prefer the published enum over an outdated optional override.
    for (const [key, value] of Object.entries(args)) {
      const values = schema.properties?.[key]?.enum;
      if (values && !values.includes(value)) args[key] = values[0];
    }
    if (dependency) args[dependency] = discovered[dependency];
    for (const key of schema.required ?? []) {
      if (!(key in args)) args[key] = sample(key, schema.properties?.[key] ?? {});
    }
    const missing = Object.keys(args).filter(key => args[key] === undefined);
    if (missing.length) {
      row.status = "blocked"; row.note = `No verified sample for ${missing.join(", ")}.`; continue;
    }
    const start = Date.now();
    try {
      const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 45_000 });
      const texts = (result.content as Array<{ type: string; text?: string }> ?? [])
        .filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(texts); } catch { /* Images may have plain-text captions. */ }
      if (result.isError || parsed.success === false) {
        const detail = typeof parsed.error === "string" ? parsed.error
          : typeof parsed.message === "string" ? parsed.message : texts;
        Object.assign(row, summarizeVerificationFailure(parsed, detail));
      } else {
        row.status = "passed";
        row.note = "MCP call returned successfully; response values were not saved.";
        learn(tool.name, parsed.data ?? parsed);
      }
    } catch (error) {
      Object.assign(row, summarizeVerificationFailure(error));
    }
    row.milliseconds = Date.now() - start;
    console.log(`${row.status.padEnd(8)} ${row.name}${row.status !== "passed" ? `: ${row.note}` : ""}`);
  }
} finally {
  await Promise.allSettled([client.close(), server.close()]);
  cleanArtifacts();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  const counts: Record<string, number> = {};
  for (const row of report) counts[row.status] = (counts[row.status] ?? 0) + 1;
  mkdirSync(dirname(output), { recursive: true });
  // Replace atomically so an existing permissive report/symlink cannot weaken the new file mode.
  const reportDir = mkdtempSync(join(dirname(output), ".verification-report-"));
  try {
    const temporary = join(reportDir, "report.json");
    writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), counts, tools: report }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, output);
  } finally { rmSync(reportDir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ counts, report: output }));
  if (counts.failed) process.exitCode = 1;
}
