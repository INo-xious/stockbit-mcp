/**
 * Social / sentiment stream: community posts mentioning a symbol (NOT price data).
 *   GET /stream/v3/symbol/{symbol}
 * Maps to the "market sentiment / news" capability.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr, StrOrNum } from "./_util.js";
import { CACHE } from "../config.js";

const Post = z
  .object({
    stream_id: StrOrNum.optional(),
    content: z.string().optional(),
    content_original: z.string().optional(),
    created_at: z.string().optional(),
    user: z
      .object({ username: z.string().optional(), fullname: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const Response = z.object({ data: z.object({ stream: z.array(Post) }).passthrough() }).passthrough();

export interface StreamPost {
  id?: string;
  content?: string;
  createdAt?: string;
  author?: string;
}

export async function getSentimentStream(symbol: string, limit = 30): Promise<StreamPost[]> {
  const sym = symbol.toUpperCase();
  return cached(`stream:${sym}`, CACHE.defaultTtlMs, async () => {
    const body = await getJson(`/stream/v3/symbol/${sym}`);
    const parsed = parseOr(Response, body, "sentiment stream");
    return parsed.data.stream.slice(0, limit).map((p) => ({
      id: p.stream_id,
      content: p.content_original ?? p.content,
      createdAt: p.created_at,
      author: p.user?.username ?? p.user?.fullname,
    }));
  });
}
