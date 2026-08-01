/**
 * Fundamentals: key statistics and financial ratios.
 *   GET /keystats/{symbol}
 *   GET /keystats/ratio/v1/{symbol}
 * These are large, nested objects whose full shape isn't exhaustively mapped; validate the
 * envelope and return `data` as-is so callers/tools can pick fields.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";

const Envelope = z.object({ data: z.unknown() }).passthrough();

export async function getKeystats(symbol: string): Promise<unknown> {
  const sym = symbol.toUpperCase();
  return cached(`keystats:${sym}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson(`/keystats/${sym}`);
    return parseOr(Envelope, body, "keystats").data;
  });
}

export async function getRatios(symbol: string): Promise<unknown> {
  const sym = symbol.toUpperCase();
  return cached(`ratios:${sym}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson(`/keystats/ratio/v1/${sym}`);
    return parseOr(Envelope, body, "ratios").data;
  });
}
