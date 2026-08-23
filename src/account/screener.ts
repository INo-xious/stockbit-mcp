/**
 * Screener edits: saving a screen, deleting one, and the favourite flag. ADR-0006.
 *
 * ## The one-character difference
 *
 * Saving a screen is the same method and the same path as running an ad-hoc one. The only thing
 * separating "evaluate these rules and persist nothing" from "create a saved screen on this
 * account" is a body field: `save: "0"` against `save: "1"`.
 *
 * `buildScreenBody` in `src/core/screenerrun.ts` types that field as the literal `"0"` so that no
 * assignment can widen it, and a unit test asserts the value. This module does not reach into that
 * function and flip it — it builds its own body, through `buildSavedScreenBody`, and the route it
 * posts to is a SEPARATE row in the table (`screenerSave`, not `screenerRun`) so the write class in
 * `test/transport.test.ts` names it as a mutation rather than letting it ride along under the
 * read-shaped POST.
 *
 * Everything is verified by re-listing the templates, because the create response has not been
 * observed and may or may not carry the new id.
 */
import { deleteJson, postJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { invalidateCache } from "../core/_util.js";
import { getScreenerTemplates } from "../core/screener.js";
import { buildScreenBody, type ScreenRule, type ScreenScope } from "../core/screenerrun.js";
import { verifiedWrite, type AccountResult } from "./log.js";

function invalidate(): void {
  invalidateCache("screener");
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

/** Numeric, matching the transport's own `templateId` validator. See the note in `watchlist.ts`. */
function requireTemplateId(id: string): string {
  const trimmed = String(id ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(trimmed)) {
    throw new StockbitError(
      "invalid_param",
      `${JSON.stringify(id)} is not a screener template id: expected a numeric id.`,
    );
  }
  return trimmed;
}

/** The saved-screen body: the ad-hoc one, with a name and the flag that makes it persist. */
export interface SavedScreenBody {
  save: "1";
  name: string;
  rules: Array<{ metric: string; operator: string; value: string }>;
  scope?: string;
  scopeID?: string;
}

/**
 * Build it.
 *
 * Deliberately a second function rather than a parameter on `buildScreenBody`: a flag that turns a
 * read into a write is exactly the kind of argument that gets passed by accident, and the ad-hoc
 * path keeps its literal-typed `"0"` because nothing can reach it.
 */
export function buildSavedScreenBody(
  name: string,
  rules: readonly ScreenRule[],
  scope?: ScreenScope,
): SavedScreenBody {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new StockbitError("invalid_param", "A saved screen needs a name.");
  if (trimmed.length > 100) {
    throw new StockbitError("invalid_param", `That name is ${trimmed.length} characters; the limit here is 100.`);
  }
  // The rule validation lives in one place. Reimplementing it here is how the two paths drift.
  const { rules: built, scope: builtScope, scopeID } = buildScreenBody(rules, scope);
  return {
    save: "1",
    name: trimmed,
    rules: built,
    ...(builtScope ? { scope: builtScope, scopeID } : {}),
  };
}

/**
 * Save a screen to the account.
 *
 * Verified by re-listing: a template with this name that was not there before. A name that already
 * exists is refused rather than posted, because whether Stockbit replaces or duplicates has not been
 * observed and the two outcomes are very different for someone who curated a screen.
 */
export async function saveScreen(options: {
  name: string;
  rules: readonly ScreenRule[];
  scope?: ScreenScope;
  confirm: boolean;
}): Promise<AccountResult<{ id?: string; name: string }>> {
  const body = buildSavedScreenBody(options.name, options.rules, options.scope);
  requireConfirm(options.confirm, `save the screen "${body.name}" to the account`);

  const before = await getScreenerTemplates();
  const clash = before.find((template) => template.name === body.name);
  if (clash) {
    throw new StockbitError(
      "invalid_param",
      `A saved screen called "${body.name}" already exists (id ${clash.id}). Whether saving over it replaces ` +
        "or duplicates it has never been observed, so nothing was sent. Pick another name, or delete that " +
        "one first with screener_delete.",
    );
  }
  const beforeIds = new Set(before.map((template) => template.id));

  return verifiedWrite({
    action: "screener_save",
    target: body.name,
    lockKey: "screener",
    write: () => postJson("screenerSave", { body }),
    invalidate,
    verify: async () => {
      const after = await getScreenerTemplates();
      const fresh = after.find((template) => !beforeIds.has(template.id) && template.name === body.name);
      const byName = after.find((template) => template.name === body.name);
      return { verified: Boolean(fresh ?? byName), detail: { id: (fresh ?? byName)?.id, name: body.name } };
    },
  });
}

/** Delete a saved screen. Verified by its absence from the re-listed templates. */
export async function deleteScreen(options: {
  templateId: string;
  confirm: boolean;
}): Promise<AccountResult<{ id: string; name?: string }>> {
  const id = requireTemplateId(options.templateId);
  requireConfirm(options.confirm, `delete saved screen ${id}`);

  const before = await getScreenerTemplates();
  const target = before.find((template) => template.id === id);
  if (!target) {
    throw new StockbitError(
      "not_found",
      `No saved screen with id ${id}. Read screener_templates first — nothing was sent.`,
    );
  }
  if (target.type !== "TEMPLATE_TYPE_CUSTOM") {
    // Stockbit's own built-ins are not the user's to delete, and an attempt would either fail or
    // remove something from the whole account's view of the product.
    throw new StockbitError(
      "invalid_param",
      `"${target.name}" is one of Stockbit's built-in screens (${target.type}), not one the user saved. ` +
        "Nothing was sent.",
    );
  }

  return verifiedWrite({
    action: "screener_delete",
    target: `${id} (${target.name})`,
    lockKey: "screener",
    write: () => deleteJson("screenerTemplateDelete", { segments: { templateId: id } }),
    invalidate,
    verify: async () => {
      const still = (await getScreenerTemplates()).some((template) => template.id === id);
      return { verified: !still, detail: { id, name: target.name } };
    },
  });
}

/**
 * Add or remove a screen's favourite flag.
 *
 * The lightest edit here, and still verified: `getScreenerTemplates` carries `favorite` on every
 * row, so there is a real read-back to do rather than a status code to trust.
 */
export async function favoriteScreen(options: {
  templateId: string;
  favorite: boolean;
  confirm: boolean;
}): Promise<AccountResult<{ id: string; favorite: boolean }>> {
  const id = requireTemplateId(options.templateId);
  requireConfirm(
    options.confirm,
    `${options.favorite ? "favourite" : "un-favourite"} saved screen ${id}`,
  );

  return verifiedWrite({
    action: options.favorite ? "screener_favorite_add" : "screener_favorite_remove",
    target: id,
    lockKey: "screener",
    write: () =>
      options.favorite
        ? postJson("screenerFavoriteAdd", { body: { template_id: id } })
        : deleteJson("screenerFavoriteRemove", { body: { template_id: id } }),
    invalidate,
    verify: async () => {
      const found = (await getScreenerTemplates()).find((template) => template.id === id);
      return { verified: found?.favorite === options.favorite, detail: { id, favorite: found?.favorite === true } };
    },
  });
}
