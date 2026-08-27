/**
 * The `<scope>` argument: which symbols a watcher is responsible for.
 *
 * Three shapes, per the command spec: an explicit list of stocks, a watchlist, or everything.
 *
 *     /watch BBCA,ANTM   5m  ...     -> explicit
 *     /watch watchlist   5m  ...     -> the user's default watchlist
 *     /watch watchlist:Bandar 5m ... -> a named one
 *     /watch all         5m  ...     -> the whole market
 *
 * ## Parsing is separate from resolving, and that is deliberate
 *
 * {@link parseScope} is pure and cannot fail at runtime; {@link resolveScope} makes network calls.
 * Splitting them means a malformed command is rejected instantly with a useful message, before any
 * request is made, and means the parser is testable with no session and no market.
 *
 * ## What "all" actually means
 *
 * It does NOT mean every listed company. The watcher reads `/order-trade/top-stock`, which returns
 * the hundred most-active symbols in ONE request — and a stock with no turnover cannot print a large
 * transaction, so the names outside that list are precisely the ones with nothing to report. This is
 * a real limitation and {@link describeScope} states it rather than letting "all" imply coverage the
 * watcher does not have.
 *
 * Whether ~100 is the right universe, and what a broader sweep would cost, is an open question with
 * two conflicting measurements behind it. It is not settled here.
 */
import { getWatchlistSymbols } from "../core/watchlist.js";

/** A scope, as written. Pure data — no requests have happened yet. */
export type Scope =
  | { kind: "symbols"; symbols: string[] }
  /** `name` undefined means the user's default watchlist. */
  | { kind: "watchlist"; name?: string }
  | { kind: "all" };

/** A scope after resolution: the actual symbols, or the explicit absence of a filter. */
export interface ResolvedScope {
  scope: Scope;
  /**
   * The symbols to report on, uppercased.
   *
   * NULL means "no filter" — every symbol the poll returns is in scope. This is not the same as an
   * empty array, which means "a filter that matches nothing", and conflating the two is how a
   * watcher ends up silently reporting the entire market to someone who asked about two stocks.
   */
  symbols: string[] | null;
  /** Anything the user should know about how their scope was interpreted. */
  notes: string[];
}

export class ScopeParseError extends Error {
  constructor(readonly token: string, reason: string) {
    super(`Cannot read "${token}" as a scope: ${reason}`);
    this.name = "ScopeParseError";
  }
}

const ALL_WORDS = new Set(["all", "allstocks", "all-stocks", "semua", "market", "*"]);
const WATCHLIST_WORDS = new Set(["watchlist", "watchlists", "wl", "daftar"]);

/**
 * IDX tickers are four letters. Warrants and rights append a suffix — `INET-W2`, `BUMI-R` — and those
 * are real instruments the user may hold, so the shape allows them rather than rejecting anything
 * with a dash.
 */
const SYMBOL = /^[A-Z]{4}(-[A-Z0-9]{1,3})?$/;

/** How many explicit symbols one command may name. */
const MAX_SYMBOLS = 50;

/**
 * Parse the scope token. Pure; throws on anything it cannot read.
 *
 * @param token the scope argument, e.g. `BBCA,ANTM` or `watchlist:Bandar` or `all`
 */
export function parseScope(token?: string | null): Scope {
  const source = (token ?? "").trim();
  if (!source) throw new ScopeParseError("", "name some stocks, a watchlist, or all");

  const normalized = source.toLowerCase().replace(/\s+/g, "");

  if (ALL_WORDS.has(normalized)) return { kind: "all" };

  // `watchlist` or `watchlist:Name`. The name is taken from the ORIGINAL token, not the normalized
  // one, because watchlist names are the user's own words and lowercasing them makes a mess of the
  // error message when the lookup misses.
  const colon = source.indexOf(":");
  const head = (colon === -1 ? source : source.slice(0, colon)).trim().toLowerCase();
  if (WATCHLIST_WORDS.has(head)) {
    const name = colon === -1 ? undefined : source.slice(colon + 1).trim();
    if (colon !== -1 && !name) throw new ScopeParseError(source, "a watchlist name is expected after the colon");
    return { kind: "watchlist", name };
  }

  const parts = source
    .split(/[,\s]+/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  if (!parts.length) throw new ScopeParseError(source, "no symbols found");
  if (parts.length > MAX_SYMBOLS) {
    throw new ScopeParseError(source, `${parts.length} symbols is more than the ${MAX_SYMBOLS} allowed — use a watchlist or "all"`);
  }

  const bad = parts.filter((p) => !SYMBOL.test(p));
  if (bad.length) {
    // Quoting the offending token matters: the usual cause is a stray word from the prompt landing in
    // the scope argument, and seeing it named makes that obvious immediately.
    throw new ScopeParseError(source, `${bad.join(", ")} ${bad.length === 1 ? "is not an" : "are not"} IDX ticker${bad.length === 1 ? "" : "s"}`);
  }

  // Dedupe but keep the order the user typed. Repeats are a typo, not an instruction to report twice.
  return { kind: "symbols", symbols: [...new Set(parts)] };
}

/** Resolve a parsed scope into the symbol set to filter on. Makes network calls for watchlists. */
export async function resolveScope(scope: Scope): Promise<ResolvedScope> {
  if (scope.kind === "all") {
    return {
      scope,
      symbols: null,
      notes: [
        "\"All\" covers the ~100 most active symbols, which is what one request returns. A stock with no turnover cannot print a large transaction, so the names outside that list are the ones with nothing to report.",
      ],
    };
  }

  if (scope.kind === "symbols") {
    return { scope, symbols: scope.symbols, notes: [] };
  }

  const symbols = (await getWatchlistSymbols(scope.name)).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const notes: string[] = [];

  if (!symbols.length) {
    // An empty watchlist resolves to an empty filter, which correctly reports nothing. Saying so is
    // the difference between "the market is quiet" and "you are watching nothing".
    notes.push(
      scope.name
        ? `Watchlist "${scope.name}" is empty, so nothing is being watched.`
        : "Your watchlist is empty, so nothing is being watched.",
    );
  }

  return { scope, symbols, notes };
}

/** How to say a scope back to a person. */
export function describeScope(resolved: ResolvedScope): string {
  const { scope, symbols } = resolved;
  if (scope.kind === "all") return "the ~100 most active symbols";
  if (scope.kind === "watchlist") {
    const which = scope.name ? `watchlist "${scope.name}"` : "your watchlist";
    return `${which} (${symbols?.length ?? 0} symbol${symbols?.length === 1 ? "" : "s"})`;
  }
  return (symbols ?? []).join(", ");
}

/**
 * Whether a symbol is in scope.
 *
 * Null means no filter — see {@link ResolvedScope.symbols} for why that is distinct from empty.
 */
export function inScope(resolved: ResolvedScope, symbol: string): boolean {
  if (resolved.symbols === null) return true;
  return resolved.symbols.includes(symbol.trim().toUpperCase());
}
