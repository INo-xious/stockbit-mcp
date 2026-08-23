/**
 * Watchlist and screener edits. ADR-0006.
 *
 * Nine writes, none of which touches money, all of which change what later answers are ABOUT — the
 * watchlist is the universe several tools sweep, and a saved screen is the most direct statement
 * the user has made about what they look for.
 *
 * The annotations are graded rather than uniform. Adding a symbol is reversible in the Stockbit app
 * in two taps and is marked `destructiveHint: false`; deleting a list with 116 symbols in it is not,
 * and is marked true. Marking everything destructive teaches a client to ignore the flag, which
 * makes the two deletions here less visible rather than more.
 */
import { z } from "zod";
import {
  addToWatchlist,
  createWatchlist,
  deleteWatchlist,
  favoriteWatchlist,
  removeFromWatchlist,
  renameWatchlist,
} from "../account/watchlist.js";
import { deleteScreen, favoriteScreen, saveScreen } from "../account/screener.js";
import { accountLogPath, type AccountResult } from "../account/log.js";
import { watchlistScope, type ScreenOperator } from "../core/screenerrun.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

const CONFIRM = z
  .boolean()
  .optional()
  .describe("Must be true. Ask the user in plain words first, naming exactly what changes.");

const OUTCOME_NOTE =
  "READ `outcome`: `ok` means the change was made AND seen when the account was read back. " +
  "`not-visible` means it was accepted but is not there, `outcome-unknown` means the read-back " +
  "failed. Nothing here rolls back — each of these is one action a person can reverse in the " +
  "Stockbit app, and undoing a change we could not read would be a second blind write. Relay " +
  "`message` rather than reporting success.";

/** The prose the tool layer adds to a core result. One wording for all nine. */
function describe(result: AccountResult<unknown>, done: string): Record<string, unknown> {
  const message =
    result.outcome === "ok"
      ? `${done}, confirmed by reading the account back.`
      : (result.outcomeUnknown ??
        `${done} could not be confirmed${result.error ? `: ${result.error}` : "."} Check in the Stockbit app.`);
  return {
    ...result,
    message,
    ...(result.logged
      ? { auditLog: result.logPath }
      : {
          auditGap:
            `This edit could NOT be written to ${accountLogPath()}. The change itself is unaffected, but ` +
            "there is no audit line for it — tell the user.",
        }),
  };
}

export function registerAccountWriteTools(define: Definer): void {
  /* -------------------------------- watchlist -------------------------------- */

  define.write(
    "watchlist_create",
    "Create a new watchlist on the user's Stockbit account.\n" +
      "Requires `confirm: true` after asking the user. Verified by re-listing the watchlists and " +
      "finding one with this name — the create response is not trusted for that.\n" +
      OUTCOME_NOTE,
    {
      name: z.string().describe("The new list's name"),
      description: z.string().optional().describe("Optional description"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const result = await createWatchlist({
          name: String(a.name),
          description: a.description ? String(a.description) : undefined,
          confirm: a.confirm === true,
        });
        return describe(result, `Watchlist "${a.name}" was created`);
      }),
    { destructiveHint: false, idempotentHint: false },
  );

  define.write(
    "watchlist_rename",
    "Rename one of the user's watchlists. Requires `confirm: true` after asking.\n" +
      "Verified by reading the list of watchlists back and comparing the name.\n" +
      OUTCOME_NOTE,
    {
      watchlist_id: z.string().describe("The list's id, from the `watchlists` tool"),
      name: z.string().describe("The new name"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const result = await renameWatchlist({
          watchlistId: String(a.watchlist_id),
          name: String(a.name),
          confirm: a.confirm === true,
        });
        return describe(result, `The watchlist was renamed to "${a.name}"`);
      }),
    { destructiveHint: false, idempotentHint: true },
  );

  define.write(
    "watchlist_delete",
    "DELETE one of the user's watchlists, and everything in it. Stockbit offers no undo.\n" +
      "This tool asks TWICE on purpose. `confirm: true` is the ordinary gate; if the list still " +
      "holds symbols, it refuses and tells you HOW MANY, and only `confirm_delete_members: true` " +
      "gets past that. Tell the user the count and let them decide — do not set the second flag on " +
      "the same reflex as the first.\n" +
      OUTCOME_NOTE,
    {
      watchlist_id: z.string().describe("The list's id, from the `watchlists` tool"),
      confirm: CONFIRM,
      confirm_delete_members: z
        .boolean()
        .optional()
        .describe("Required when the list is not empty. The user must have agreed to losing those symbols."),
      },
    async (a) =>
      runTool(async () => {
        const result = await deleteWatchlist({
          watchlistId: String(a.watchlist_id),
          confirm: a.confirm === true,
          confirmDeleteMembers: a.confirm_delete_members === true,
        });
        return describe(result, `Watchlist ${a.watchlist_id} was deleted`);
      }),
    { destructiveHint: true, idempotentHint: true },
  );

  define.write(
    "watchlist_add",
    "Add a symbol to one of the user's watchlists. Requires `confirm: true` after asking.\n" +
      "The wire takes a company id rather than a ticker, so the symbol is resolved first; a ticker " +
      "that resolves to nothing is refused before anything is sent rather than added as an empty " +
      "id that would report success and change nothing.\n" +
      "Worth remembering that several tools take 'the user's watchlist' as the universe they " +
      "sweep, so this changes what a later scan is about.\n" +
      OUTCOME_NOTE,
    {
      watchlist_id: z.string().describe("The list's id, from the `watchlists` tool"),
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const result = await addToWatchlist({
          watchlistId: String(a.watchlist_id),
          symbol: String(a.symbol),
          confirm: a.confirm === true,
        });
        return describe(result, `${String(a.symbol).toUpperCase()} was added to the watchlist`);
      }),
    { destructiveHint: false, idempotentHint: true },
  );

  define.write(
    "watchlist_remove",
    "Remove a symbol from one of the user's watchlists. Requires `confirm: true` after asking.\n" +
      "A symbol that is not in the list is reported as such and nothing is sent — that is an answer, " +
      "not a failure.\n" +
      OUTCOME_NOTE,
    {
      watchlist_id: z.string().describe("The list's id, from the `watchlists` tool"),
      symbol: z.string().describe("IDX ticker to remove"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const result = await removeFromWatchlist({
          watchlistId: String(a.watchlist_id),
          symbol: String(a.symbol),
          confirm: a.confirm === true,
        });
        return describe(result, `${String(a.symbol).toUpperCase()} was removed from the watchlist`);
      }),
    { destructiveHint: true, idempotentHint: true },
  );

  define.write(
    "watchlist_favorite",
    "Make a watchlist the favourite — the one Stockbit opens on, and the one THIS SERVER uses when " +
      "a tool is asked for 'the user's watchlist' without an id.\n" +
      "That second consequence is why it is confirmed rather than treated as a preference: it " +
      "silently repoints every later scan at a different set of symbols. Say so when you ask.\n" +
      OUTCOME_NOTE,
    { watchlist_id: z.string().describe("The list's id, from the `watchlists` tool"), confirm: CONFIRM },
    async (a) =>
      runTool(async () => {
        const result = await favoriteWatchlist({
          watchlistId: String(a.watchlist_id),
          confirm: a.confirm === true,
        });
        return describe(result, `Watchlist ${a.watchlist_id} is now the favourite`);
      }),
    { destructiveHint: false, idempotentHint: true },
  );

  /* --------------------------------- screener --------------------------------- */

  define.write(
    "screener_save",
    "SAVE a screen to the user's account, so it appears in their screener alongside the ones they " +
      "built by hand.\n" +
      "Distinct from `screener_run`, which evaluates rules and persists nothing. The only " +
      "difference on the wire is one body field, which is exactly why they are separate tools.\n" +
      "A name that already exists is REFUSED rather than posted: whether Stockbit replaces or " +
      "duplicates has never been observed, and those are very different outcomes for someone who " +
      "curated a screen. Pick another name or delete the old one first.\n" +
      "Verified by re-listing the saved screens.\n" +
      OUTCOME_NOTE,
    {
      name: z.string().describe("What to call the saved screen"),
      rules: z
        .array(
          z.object({
            metric: z.string().describe("Metric id from the screener catalogue"),
            operator: z.string().describe("Comparison operator"),
            value: z.union([z.string(), z.number()]).describe("The value to compare against"),
          }),
        )
        .describe("The rules, combined with AND. There is no OR."),
      watchlist_id: z.string().optional().describe("Scope the screen to a watchlist's members"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const rules = (a.rules as Array<{ metric: string; operator: string; value: string | number }>).map(
          (rule) => ({ ...rule, operator: rule.operator as ScreenOperator }),
        );
        const result = await saveScreen({
          name: String(a.name),
          rules,
          scope: a.watchlist_id ? watchlistScope(String(a.watchlist_id)) : undefined,
          confirm: a.confirm === true,
        });
        return describe(result, `The screen "${a.name}" was saved`);
      }),
    { destructiveHint: false, idempotentHint: false },
  );

  define.write(
    "screener_delete",
    "DELETE one of the user's saved screens. Stockbit offers no undo.\n" +
      "Only the user's own screens can be deleted — Stockbit's built-ins are refused by name, " +
      "because they are not the user's to remove.\n" +
      "Verified by re-listing the saved screens and confirming it is gone.\n" +
      OUTCOME_NOTE,
    {
      template_id: z.string().describe("The screen's id, from `screener_templates`"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const result = await deleteScreen({ templateId: String(a.template_id), confirm: a.confirm === true });
        return describe(result, `Saved screen ${a.template_id} was deleted`);
      }),
    { destructiveHint: true, idempotentHint: true },
  );

  define.write(
    "screener_favorite",
    "Mark a saved screen as a favourite, or clear the mark. The lightest edit here, and still " +
      "confirmed and verified — `screener_templates` carries the flag, so there is a real read-back " +
      "rather than a status code to trust.\n" +
      OUTCOME_NOTE,
    {
      template_id: z.string().describe("The screen's id, from `screener_templates`"),
      favorite: z.boolean().describe("true to favourite it, false to clear the mark"),
      confirm: CONFIRM,
    },
    async (a) =>
      runTool(async () => {
        const result = await favoriteScreen({
          templateId: String(a.template_id),
          favorite: a.favorite === true,
          confirm: a.confirm === true,
        });
        return describe(result, `Saved screen ${a.template_id} was ${a.favorite ? "favourited" : "un-favourited"}`);
      }),
    { destructiveHint: false, idempotentHint: true },
  );
}
