/**
 * Financial statements.
 *   GET /findata-view/company/financial?symbol=&data_type=&report_type=&statement_type=
 * The full response is very large (~1.3MB incl. an html_report blob). We validate the envelope,
 * strip the html_report, and return the structured pieces so tool output stays context-friendly.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";

export interface FinancialOptions {
  symbol: string;
  /** Integer enums per the frontend; defaults chosen to return an annual income statement. */
  dataType?: number; // data_type
  reportType?: number; // report_type
  statementType?: number; // statement_type
}

const Response = z
  .object({
    data: z
      .object({
        currency: z.array(z.string()).optional(),
        default_currency: z.string().optional(),
        rounding_value: z.unknown().optional(),
        data_tables: z.unknown().optional(),
        html_report: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface Financials {
  currency?: string[];
  defaultCurrency?: string;
  roundingValue?: unknown;
  dataTables?: unknown;
}

export async function getFinancials(opts: FinancialOptions): Promise<Financials> {
  const sym = normalizeSymbol(opts.symbol);
  const params = {
    symbol: sym,
    data_type: opts.dataType ?? 1,
    report_type: opts.reportType ?? 2,
    statement_type: opts.statementType ?? 1,
  };
  const key = `financials:${JSON.stringify(params)}`;
  return cached(key, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("financial", { params });
    const { data } = parseOr(Response, body, "financials");
    // Drop html_report — it's a huge presentational blob unsuitable for tool output.
    return {
      currency: data.currency,
      defaultCurrency: data.default_currency,
      roundingValue: data.rounding_value,
      dataTables: data.data_tables,
    };
  });
}
