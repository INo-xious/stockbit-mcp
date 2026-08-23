/**
 * Watchlist edits. ADR-0006.
 *
 * The mildest writes in this project, and still confirmed, verified and logged — because a
 * watchlist is not decoration. `scan`, `screener_run` and several workflows take "the user's
 * watchlist" as the universe they sweep, so a symbol quietly added changes what every later answer
 * is about, and a list quietly deleted changes what the user is shown without them ever asking why.
 *
 * ## The one that asks twice
 *
 * `deleteWatchlist` refuses a list that still has symbols in it unless the caller passes a second,
 * differently-named flag. A model that has learned to pass `confirm: true` will pass it here too;
 * the second flag exists so that deleting 116 symbols cannot happen on the same reflex as deleting
 * an empty list the user just made by mistake. The refusal names the count.
 */
import { deleteJson, postJson, putJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { invalidateCache } from "../core/_util.js";
import { getWatchlist, getWatchlists } from "../core/watchlist.js";
import { resolveCompanyId } from "../core/emitten.js";
import { normalizeSymbol } from "../symbol.js";
import { verifiedWrite, type AccountResult } from "./log.js";

/** Everything watchlist-shaped leaves the cache after any edit. */
function invalidate(): void {
  invalidateCache("watchlist");
}

function requireConfirm(confirm: boolean, what: string): void {
  if (confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to ${what} without confirm: true. Ask the user in plain words, naming what changes, and pass ` +
        "it only after they agree to that specific edit.",
    );
  }
}

/**
 * A watchlist id, on its way into a path segment.
 *
 * Numeric, matching the transport's own `watchlistId` validator. Checked here as well so the
 * refusal names the watchlist rather than the route, and so it happens before the read that would
 * otherwise be made on the way to a request that was never going to be sent.
 */
function requireId(id: string, field = "watchlist id"): string {
  const trimmed = String(id ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(trimmed)) {
    throw new StockbitError("invalid_param", `${JSON.stringify(id)} is not a ${field}: expected a numeric id.`);
  }
  return trimmed;
}

function requireName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new StockbitError("invalid_param", "A watchlist needs a name.");
  if (trimmed.length > 100) {
    throw new StockbitError("invalid_param", `That name is ${trimmed.length} characters; the limit here is 100.`);
  }
  return trimmed;
}

/* ---------------------------------- create / rename ---------------------------------- */

/**
 * Create a watchlist.
 *
 * Verified by re-listing and finding one with this name that was not there before — not by trusting
 * the response, which has not been observed and may or may not carry the new id.
 */
export async function createWatchlist(options: {
  name: string;
  description?: string;
  confirm: boolean;
}): Promise<AccountResult<{ id?: string; name: string }>> {
  const name = requireName(options.name);
  requireConfirm(options.confirm, `create the watchlist "${name}"`);

  const before = await listIds();
  return verifiedWrite({
    action: "watchlist_create",
    target: name,
    lockKey: "watchlist",
    write: () => postJson("watchlistCreate", { body: { name, description: options.description ?? "" } }),
    invalidate,
    verify: async () => {
      const after = await getWatchlists();
      const fresh = after.find((list) => !before.has(list.id) && (list.name ?? "") === name);
      const byName = after.find((list) => (list.name ?? "") === name);
      return { verified: Boolean(fresh ?? byName), detail: { id: (fresh ?? byName)?.id, name } };
    },
  });
}

/** Rename a watchlist. Verified by reading the list back and comparing the name. */
export async function renameWatchlist(options: {
  watchlistId: string;
  name: string;
  confirm: boolean;
}): Promise<AccountResult<{ id: string; name: string }>> {
  const id = requireId(options.watchlistId);
  const name = requireName(options.name);
  requireConfirm(options.confirm, `rename watchlist ${id} to "${name}"`);

  return verifiedWrite({
    action: "watchlist_rename",
    target: id,
    lockKey: `watchlist-${id}`,
    write: () => putJson("watchlistRename", { segments: { watchlistId: id }, body: { name } }),
    invalidate,
    verify: async () => {
      const found = (await getWatchlists()).find((list) => list.id === id);
      return { verified: (found?.name ?? "") === name, detail: { id, name: found?.name ?? "" } };
    },
  });
}

/* -------------------------------------- delete -------------------------------------- */

/**
 * Delete a watchlist.
 *
 * Refuses a non-empty list unless `confirmDeleteMembers` is also set. See the module note: the
 * second flag is there because the first one is a reflex.
 */
export async function deleteWatchlist(options: {
  watchlistId: string;
  confirm: boolean;
  confirmDeleteMembers?: boolean;
}): Promise<AccountResult<{ id: string; deletedMembers: number }>> {
  const id = requireId(options.watchlistId);
  requireConfirm(options.confirm, `delete watchlist ${id}`);

  // Read before deciding: the count is the argument, and it has to be the current one.
  const existing = await getWatchlist(id);
  const members = existing.total;
  if (members > 0 && options.confirmDeleteMembers !== true) {
    throw new StockbitError(
      "invalid_param",
      `Watchlist ${id}${existing.name ? ` ("${existing.name}")` : ""} still holds ${members} symbol(s). ` +
        "Deleting it removes all of them and Stockbit offers no undo. Tell the user the count, and pass " +
        "confirm_delete_members: true only if they agree to lose those symbols.",
    );
  }

  return verifiedWrite({
    action: "watchlist_delete",
    target: id,
    lockKey: `watchlist-${id}`,
    write: () => deleteJson("watchlistDelete", { segments: { watchlistId: id } }),
    invalidate,
    verify: async () => {
      const still = (await getWatchlists()).some((list) => list.id === id);
      return { verified: !still, detail: { id, deletedMembers: members } };
    },
  });
}

/* ---------------------------------- members ---------------------------------- */

/**
 * Add a symbol.
 *
 * The wire takes a company id, not a ticker, so the symbol is resolved first — and a symbol that
 * cannot be resolved is refused before anything is sent, rather than posted as an empty id that
 * would add nothing and report success.
 */
export async function addToWatchlist(options: {
  watchlistId: string;
  symbol: string;
  confirm: boolean;
}): Promise<AccountResult<{ symbol: string; companyId: string; total: number }>> {
  const id = requireId(options.watchlistId);
  const symbol = normalizeSymbol(options.symbol);
  requireConfirm(options.confirm, `add ${symbol} to watchlist ${id}`);

  const companyId = await resolveCompanyId(symbol);
  if (!companyId) {
    throw new StockbitError(
      "not_found",
      `${symbol} has no company id on Stockbit, so it cannot be added to a watchlist. Check the ticker.`,
    );
  }

  return verifiedWrite({
    action: "watchlist_add",
    target: `${id}:${symbol}`,
    lockKey: `watchlist-${id}`,
    write: () => postJson("watchlistAddItem", { segments: { watchlistId: id }, body: { company_id: companyId } }),
    invalidate,
    verify: async () => {
      const list = await getWatchlist(id);
      return {
        verified: list.members.some((m) => m.symbol === symbol),
        detail: { symbol, companyId, total: list.total },
      };
    },
  });
}

/**
 * Remove a symbol.
 *
 * The company id comes from the LIST rather than from a quote lookup where it can: the id the
 * watchlist holds is the one the delete path needs, and resolving it independently would be a
 * second guess at the same fact.
 */
export async function removeFromWatchlist(options: {
  watchlistId: string;
  symbol: string;
  confirm: boolean;
}): Promise<AccountResult<{ symbol: string; companyId: string; total: number }>> {
  const id = requireId(options.watchlistId);
  const symbol = normalizeSymbol(options.symbol);
  requireConfirm(options.confirm, `remove ${symbol} from watchlist ${id}`);

  const list = await getWatchlist(id);
  const member = list.members.find((m) => m.symbol === symbol);
  const companyId = member?.companyId ?? (await resolveCompanyId(symbol));
  if (!member) {
    throw new StockbitError(
      "not_found",
      `${symbol} is not in watchlist ${id}, so there is nothing to remove. Nothing was sent.`,
    );
  }
  if (!companyId) {
    throw new StockbitError(
      "not_found",
      `${symbol} is in watchlist ${id} but carries no company id, so the removal cannot be addressed.`,
    );
  }

  return verifiedWrite({
    action: "watchlist_remove",
    target: `${id}:${symbol}`,
    lockKey: `watchlist-${id}`,
    write: () => deleteJson("watchlistRemoveItem", { segments: { watchlistId: id, companyId } }),
    invalidate,
    verify: async () => {
      const after = await getWatchlist(id);
      return {
        verified: !after.members.some((m) => m.symbol === symbol),
        detail: { symbol, companyId, total: after.total },
      };
    },
  });
}

/**
 * Make a watchlist the favourite — the one Stockbit opens on, and the one this server's tools use
 * when no id is given.
 *
 * That second consequence is the reason this is confirmed rather than treated as a preference:
 * changing it silently repoints every later "the user's watchlist" at a different set of symbols.
 */
export async function favoriteWatchlist(options: {
  watchlistId: string;
  confirm: boolean;
}): Promise<AccountResult<{ id: string }>> {
  const id = requireId(options.watchlistId);
  requireConfirm(options.confirm, `make watchlist ${id} the favourite`);

  return verifiedWrite({
    action: "watchlist_favorite",
    target: id,
    lockKey: "watchlist",
    write: () => putJson("watchlistFavorite", { segments: { watchlistId: id } }),
    invalidate,
    verify: async () => {
      const lists = await getWatchlists();
      const found = lists.find((list) => list.id === id);
      // `is_favorite` is a field the index endpoint has actually been observed to carry, so this is
      // a real read-back rather than a hopeful one. A list that comes back without the flag set
      // reports `not-visible` — the write was accepted and did not take.
      return { verified: found?.isFavorite === true, detail: { id } };
    },
  });
}

async function listIds(): Promise<Set<string>> {
  return new Set((await getWatchlists()).map((list) => list.id));
}
