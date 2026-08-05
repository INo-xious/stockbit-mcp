/**
 * The user's own saved chart layout and drawings.
 *
 * ## Why this is a read and stays a read
 *
 * ADR-0002 rejects Chartbit *writes* and, in the same sentence, keeps its reads in scope: seeing
 * the markup a user has already drawn is useful analysis context. Knowing they have a trendline at
 * 3,200 changes what an assistant should say about 3,200.
 *
 * It is also the primitive any future write would need first. A write increment must snapshot
 * before it mutates, and this is that snapshot — so building it now is not speculative, it is the
 * half that carries no risk.
 *
 * ## What was measured
 *
 * `GET /chartbit/:symbol/layout` answers 200 with `{ data: { layout: string } }`. Across every
 * symbol tried on this account the layout was the **empty string** — no drawings saved. That is a
 * real answer, not a failure, and it is reported as `hasLayout: false` rather than as an error.
 *
 * It also means the serialization format is currently **unknown**: an empty string reveals nothing
 * about how a populated one is encoded. Anyone tempted to add the write should note that writing a
 * guessed format into this field would corrupt the user's chart state, and that a real saved layout
 * must be captured first.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";

const LayoutResponse = z
  .object({ data: z.object({ layout: z.string().optional() }).passthrough() })
  .passthrough();

const InitialResponse = z
  .object({
    data: z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        type: z.string().optional(),
        timezone: z.string().optional(),
        ticker: z.string().optional(),
        exchange: z.string().optional(),
        country: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface ChartLayout {
  symbol: string;
  /** False when nothing has been drawn and saved for this symbol. */
  hasLayout: boolean;
  /** Bytes of the stored layout blob. */
  length: number;
  /** Parsed layout when it is JSON; otherwise null and `raw` carries it. */
  parsed: unknown;
  /** The stored value, included only when it is short enough to be useful in a response. */
  raw?: string;
  /** Chart metadata Stockbit reports for the symbol. */
  meta: {
    name?: string;
    description?: string;
    type?: string;
    timezone?: string;
    exchange?: string;
    country?: string;
  };
}

/** Above this, the raw blob is summarised rather than returned — it is chart state, not prose. */
const MAX_RAW = 4000;

/**
 * The stored layout string, complete and uncached.
 *
 * `getChartLayout` is a *display* accessor: it omits `raw` above `MAX_RAW` so a tool response is not
 * flooded with chart state, and it caches so three questions about a symbol cost one round trip.
 * Both of those are wrong for a caller that needs the actual bytes.
 *
 * This exists because reading the bytes through the display accessor was a real, catastrophic bug:
 * the write path took `raw ?? ""`, so for any layout over 4000 bytes it believed the account held
 * nothing — snapshotting an empty file, failing verification unconditionally, and then "restoring"
 * the empty string over the user's real chart while reporting that nothing had changed. A truncating
 * read and a byte-exact operation must not share an entry point.
 */
export async function getRawChartLayout(symbolInput: string): Promise<string> {
  const symbol = normalizeSymbol(symbolInput);
  const body = await getJson("chartbitLayout", { segments: { symbol } });
  return parseOr(LayoutResponse, body, "chart layout").data.layout ?? "";
}

/**
 * Read a symbol's saved chart layout plus its chart metadata.
 *
 * Cached briefly: a layout changes only when the user saves one, and an assistant asking about
 * three symbols in a row should not cost three round trips for data that cannot have moved.
 */
export async function getChartLayout(symbolInput: string): Promise<ChartLayout> {
  const symbol = normalizeSymbol(symbolInput);

  const [layoutBody, initialBody] = await Promise.all([
    cached(`chartlayout:${symbol}`, CACHE.brokerSummaryTtlMs, () =>
      getJson("chartbitLayout", { segments: { symbol } }),
    ),
    cached(`chartinitial:${symbol}`, CACHE.brokerSummarySettledTtlMs, () =>
      getJson("chartbitInitial", { segments: { symbol } }),
    ),
  ]);

  const layout = parseOr(LayoutResponse, layoutBody, "chart layout").data.layout ?? "";
  const meta = parseOr(InitialResponse, initialBody, "chart metadata").data;

  let parsed: unknown = null;
  if (layout) {
    try {
      parsed = JSON.parse(layout);
    } catch {
      // Not JSON — reported as such rather than guessed at. `raw` carries whatever it is.
      parsed = null;
    }
  }

  return {
    symbol,
    hasLayout: layout.length > 0,
    length: layout.length,
    parsed,
    raw: layout && layout.length <= MAX_RAW ? layout : undefined,
    meta: {
      name: meta.name,
      description: meta.description,
      type: meta.type,
      timezone: meta.timezone,
      exchange: meta.exchange,
      country: meta.country,
    },
  };
}
