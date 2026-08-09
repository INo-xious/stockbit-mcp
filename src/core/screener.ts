/**
 * Stockbit's screener — reads only.
 *
 * The important discovery is that **running a saved screen is a plain GET**. An earlier research
 * pass assumed a POST and therefore that this needed its own ADR; it does not. Listing the user's
 * screens and executing one are both reads, and nothing here creates, edits or saves a screen.
 * Reading is analysis; writing is account state, and `src/http/transport.ts` is where that line is
 * drawn.
 *
 * Verified live 2026-08-09 against an account holding five custom screens; running one returned 18KB
 * of matched companies with their metric values.
 *
 * ## Why this matters more than a generic screener would
 *
 * The metric catalogue is IDX-specific and includes a Bandarmology group — screening criteria that
 * exist because this market has broker-level flow data, and which no TradingView screener can
 * express. A user's own saved screen is also the most direct statement available of what they
 * actually look for, and it is now something the assistant can run rather than ask about.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr, StrOrNum } from "./_util.js";
import { CACHE } from "../config.js";

/* --------------------------------- saved screens --------------------------------- */

const TemplateRow = z
  .object({
    id: StrOrNum,
    name: z.string(),
    type: z.string().optional(),
    favorite: StrOrNum.optional(),
  })
  .passthrough();

const TemplatesResponse = z.object({ data: z.array(TemplateRow) }).passthrough();

export interface ScreenerTemplate {
  id: string;
  name: string;
  /** `TEMPLATE_TYPE_CUSTOM` for the user's own; `TEMPLATE_TYPE_GURU` for Stockbit's built-ins. */
  type: string;
  favorite: boolean;
}

export async function getScreenerTemplates(): Promise<ScreenerTemplate[]> {
  return cached("screener:templates", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("screenerTemplates");
    return parseOr(TemplatesResponse, body, "screener templates").data.map((row) => ({
      id: String(row.id),
      name: row.name,
      type: row.type ?? "TEMPLATE_TYPE_CUSTOM",
      favorite: String(row.favorite ?? "0") !== "0",
    }));
  });
}

/* ---------------------------------- running one ---------------------------------- */

const ResultCell = z
  .object({
    id: StrOrNum.optional(),
    display: z.string().optional(),
    value: z.unknown().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const CalcRow = z
  .object({
    company: z
      .object({ symbol: z.string(), name: z.string().optional(), id: StrOrNum.optional() })
      .passthrough(),
    results: z.array(ResultCell).optional(),
  })
  .passthrough();

const RunResponse = z.object({ data: z.object({ calcs: z.array(CalcRow) }).passthrough() }).passthrough();

export interface ScreenerMatch {
  symbol: string;
  name?: string;
  companyId?: string;
  /** The metric columns the screen projects, as Stockbit formatted them. */
  metrics: Array<{ id?: string; name?: string; display?: string }>;
}

export interface ScreenerRun {
  templateId: string;
  matches: ScreenerMatch[];
  count: number;
}

/**
 * Run a saved screen.
 *
 * `type` must match the template's own — a custom screen run as `TEMPLATE_TYPE_GURU` is not found.
 * It is taken from the template listing rather than guessed, which is why `runScreenerTemplate`
 * accepts it rather than defaulting.
 */
export async function runScreenerTemplate(
  templateId: string,
  type = "TEMPLATE_TYPE_CUSTOM",
  limit?: number,
): Promise<ScreenerRun> {
  const key = `screener:run:${templateId}:${type}:${limit ?? "all"}`;
  return cached(key, CACHE.defaultTtlMs, async () => {
    const body = await getJson("screenerRunTemplate", {
      segments: { templateId },
      params: { type, ...(limit === undefined ? {} : { page: 1, limit }) },
    });
    const calcs = parseOr(RunResponse, body, "screener run").data.calcs;
    const matches = calcs.map((row) => ({
      symbol: row.company.symbol,
      name: row.company.name,
      companyId: row.company.id === undefined ? undefined : String(row.company.id),
      metrics: (row.results ?? []).map((cell) => ({
        id: cell.id === undefined ? undefined : String(cell.id),
        name: cell.name,
        display: cell.display,
      })),
    }));
    return { templateId, matches, count: matches.length };
  });
}

/* -------------------------------- the catalogue -------------------------------- */

/**
 * The screenable-metric catalogue (~52KB) and the index scopes.
 *
 * Returned as-is. The shapes are large, nested and not exhaustively mapped, and projecting them
 * down to a guessed subset is exactly the mistake `getSectors` had already made once — it dropped
 * every field but three, including one its own schema declared.
 */
export async function getScreenerMetrics(): Promise<unknown> {
  return cached("screener:metrics", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("screenerMetrics");
    return parseOr(z.object({ data: z.unknown() }).passthrough(), body, "screener metrics").data;
  });
}

export async function getScreenerPresets(): Promise<unknown> {
  return cached("screener:presets", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("screenerPresets");
    return parseOr(z.object({ data: z.unknown() }).passthrough(), body, "screener presets").data;
  });
}

export async function getScreenerUniverse(): Promise<unknown> {
  return cached("screener:universe", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("screenerUniverse");
    return parseOr(z.object({ data: z.unknown() }).passthrough(), body, "screener universe").data;
  });
}
