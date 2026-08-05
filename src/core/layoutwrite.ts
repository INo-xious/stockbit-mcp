/**
 * Saving a chart layout to the user's Stockbit account.
 *
 * This is the only code in the project that mutates account data beyond a session refresh. It exists
 * under ADR-0003, on the account owner's explicit instruction, and every guard below is one that ADR
 * names as a precondition rather than a nicety.
 *
 * ## The shape of the risk
 *
 * `POST /chartbit/{symbol}/layout` **overwrites**. Stockbit does not merge, does not version, and
 * offers no undo. Whatever the user had drawn is replaced by whatever is sent. So the failure that
 * matters is not "the write errored" — that is recoverable and obvious. It is "the write succeeded
 * and put something wrong there", which is silent and permanent.
 *
 * Everything here is arranged against that one failure:
 *
 *   1. **Snapshot before touching anything.** The current layout is read and written to disk with a
 *      timestamp. A write that cannot snapshot does not proceed — there is no point having a
 *      rollback path that has nothing to roll back to.
 *   2. **Explicit per-call confirmation.** `confirm: true` is required on every call. Never an
 *      environment variable or a config entry: those get set once and forgotten, and the whole risk
 *      is a write nobody meant to make.
 *   3. **Verify by reading back.** Compare what the server now holds against what was sent. The
 *      codec's round-trip test exists so this comparison means something.
 *   4. **Roll back on mismatch.** Restore the snapshot and report both states. An unverified write
 *      left in place is worse than a failed one.
 *   5. **Log every mutation.** Append-only JSONL. A mutation nobody can audit is a mutation nobody
 *      can trust — the same reasoning as the alert log.
 *   6. **Refuse a payload we do not recognise.** Shape-checked, and the codec's corruption check is
 *      hard-enforced rather than defaulted away.
 *
 * ## What this is not
 *
 * It is not "draw a trendline". The TradingView line-tool schema is not known (see
 * `docs/chartbit-layout-format.md`), so the honest scope is round-tripping a layout or changing the
 * fields we understand. `saveChartLayout` will happily persist any plausible layout it is handed;
 * what it will not do is pretend the project can compose drawings it has never seen the schema for.
 */
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getJson, postJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { normalizeSymbol } from "../symbol.js";
import { getRawChartLayout } from "./layout.js";
import { corruptingLiterals, encodeLayoutForSave, isPlausibleLayout, normalizeSeriesIds } from "./layoutcodec.js";
import { invalidateCache } from "./_util.js";

function stockbitDir(): string {
  return process.env.STOCKBIT_STORE_DIR || join(homedir(), ".stockbit");
}

function backupDir(): string {
  return join(stockbitDir(), "layout-backups");
}

export function mutationLogPath(): string {
  return join(stockbitDir(), "layout-mutations.log");
}

export interface SaveResult {
  symbol: string;
  /** Absolute path of the pre-write snapshot. */
  snapshotPath: string;
  /** Bytes the account held before the write. 0 means it was genuinely empty — see `readLayoutBytes`. */
  bytesBefore: number;
  bytesAfter: number;
  /** True when reading the layout back matched what was sent. */
  verified: boolean;
  /**
   * Why verification failed, when it was not simply a mismatch.
   *
   * "could not read it back" and "the server stored something else" are different situations and a
   * caller must be able to tell them apart — the first says nothing about what the account holds.
   */
  verifyError?: string;
  /** Set when verification failed and the snapshot was restored. */
  rolledBack?: boolean;
  /** True when the restore was itself read back and confirmed. */
  rollbackVerified?: boolean;
  /** Set when rollback itself failed — the account is in an unknown state and the user must be told. */
  rollbackFailed?: string;
  /**
   * Set when the write's outcome is genuinely UNKNOWN: the request errored in a way that may still
   * have been applied (a timeout, a proxy 5xx). Never reported as a clean failure.
   */
  outcomeUnknown?: string;
  /** False when the mutation log could not be written — the audit trail has a hole. */
  logged: boolean;
  at: string;
}

/**
 * One append-only line per mutation attempt, written whatever the outcome.
 *
 * Returns whether it succeeded. Not rethrowing is right — a failed log must not mask the outcome of
 * the write it describes — but silently swallowing it would advertise an audit entry that does not
 * exist, so the caller reports `logged: false` instead.
 */
function logMutation(entry: Record<string, unknown>): boolean {
  try {
    mkdirSync(stockbitDir(), { recursive: true });
    appendFileSync(mutationLogPath(), `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Persist the current layout to disk. Returns the path, or throws — a write cannot proceed without it. */
function writeSnapshot(symbol: string, layout: string, at: string): string {
  mkdirSync(backupDir(), { recursive: true });
  const safeStamp = at.replace(/[:.]/g, "-");
  const path = join(backupDir(), `${symbol}-${safeStamp}.json`);
  writeFileSync(path, layout, "utf8");
  return path;
}

/** Send one layout. Split out so rollback uses exactly the same path the write did. */
async function putLayout(symbol: string, content: string): Promise<void> {
  await postJson("chartbitSaveLayout", { segments: { symbol }, body: { content } });
}

/**
 * Read the stored layout's exact bytes.
 *
 * Goes to `getRawChartLayout`, NOT `getChartLayout`. The latter is a display accessor that omits the
 * blob above 4,000 bytes and caches for a minute; reading the write path through it meant every real
 * chart looked empty, which snapshotted nothing, failed verification unconditionally, and then
 * "restored" an empty string over the user's drawings. A byte-exact operation gets a byte-exact
 * read.
 */
async function readLayoutBytes(symbol: string): Promise<string> {
  return getRawChartLayout(symbol);
}

/** Drop cached reads of this symbol's layout, so a later tool call cannot serve the pre-write state. */
function invalidateLayout(symbol: string): void {
  invalidateCache(`chartlayout:${symbol}`);
}

/* ---------------------------------- the write lock ---------------------------------- */

/** A lock older than this is assumed to belong to a process that died mid-write. */
export const WRITE_LOCK_STALE_MS = 60_000;

/**
 * Serialise writes to one symbol across processes.
 *
 * Two concurrent saves of the same chart would each snapshot the other's pre-state, each verify
 * against the other's bytes, and a rollback would then restore a layout that was never current.
 * `mkdir` is atomic everywhere, unlike check-then-create — the same approach as `src/auth/reflock.ts`,
 * kept separate because that lock guards a token and this one guards a chart.
 *
 * Best-effort by design: a stale lock is broken rather than wedging the feature, and failing to
 * acquire proceeds anyway. The alternative — refusing to write because a lock file exists — turns a
 * crashed process into a permanent outage.
 */
async function acquireWriteLock(symbol: string, timeoutMs = 15_000): Promise<(() => void) | null> {
  const path = join(stockbitDir(), `layout-${symbol}.lock`);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(stockbitDir(), { recursive: true });
      mkdirSync(path);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* a lock we cannot remove will be broken as stale */
        }
      };
    } catch {
      let age: number | null = null;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        age = null;
      }
      if (age !== null && age > WRITE_LOCK_STALE_MS) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* someone else got there first */
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(150);
    }
  }
}

export interface SaveOptions {
  symbol: string;
  /** The layout object to persist. */
  layout: unknown;
  /** Required. Never defaulted, and never read from the environment. */
  confirm: boolean;
  /** Accept Stockbit's lossy series-id substitution. Off by design. */
  allowLossy?: boolean;
}

/**
 * Save a chart layout, with the full ADR-0003 apparatus.
 *
 * Throws before sending anything if the request is not one we are willing to make. Once a write has
 * been sent, the return value describes what happened rather than throwing — the caller needs the
 * snapshot path and the verification result even when it went wrong, and an exception would throw
 * that away.
 */
export async function saveChartLayout(options: SaveOptions): Promise<SaveResult> {
  const symbol = normalizeSymbol(options.symbol);
  const at = new Date().toISOString();

  /* ---- gates, all before any request ---- */

  if (options.confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to overwrite ${symbol}'s saved chart without confirm: true. This replaces the layout ` +
        `on the Stockbit account and cannot be undone there.`,
    );
  }
  if (!isPlausibleLayout(options.layout)) {
    throw new StockbitError(
      "invalid_param",
      "This does not look like a Chartbit layout (expected charts[0].panes[0]). Refusing to send it.",
    );
  }
  // Throws when the payload contains a literal Stockbit's save would silently rewrite.
  const content = encodeLayoutForSave(options.layout, { allowLossy: options.allowLossy });

  // Serialised per symbol. Two concurrent saves would each snapshot the other's pre-state and each
  // verify against the other's write, and a rollback would then restore a layout that was never
  // current. Best-effort, like the refresh lock: failing to acquire proceeds rather than blocking a
  // user who has a stale lock file.
  const release = await acquireWriteLock(symbol);
  try {
    return await performSave({ symbol, content, at, layout: options.layout });
  } finally {
    release?.();
  }
}

interface SaveContext {
  symbol: string;
  content: string;
  at: string;
  layout: unknown;
}

async function performSave({ symbol, content, at }: SaveContext): Promise<SaveResult> {
  /* ---- snapshot ---- */

  let before: string;
  let snapshotPath: string;
  try {
    before = await readLayoutBytes(symbol);
    snapshotPath = writeSnapshot(symbol, before, at);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logMutation({ at, symbol, outcome: "aborted-no-snapshot", error: message });
    throw new StockbitError(
      "upstream",
      `Could not snapshot ${symbol}'s current layout, so the write was not attempted: ${message}`,
    );
  }

  /* ---- write ---- */

  try {
    await putLayout(symbol, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    invalidateLayout(symbol);

    // The request errored — but a timeout, an abort, or a 5xx from a proxy that already forwarded
    // the POST can all mean the mutation LANDED. Reporting a clean failure would be a guess, so read
    // back and find out. Only a definite "the account is unchanged" is reported as a failure.
    let landed: boolean | undefined;
    let after = "";
    try {
      after = await readLayoutBytes(symbol);
      landed = normalizeSeriesIds(after) === content;
    } catch {
      landed = undefined;
    }

    if (landed === false) {
      const logged = logMutation({
        at, symbol, outcome: "write-failed", snapshotPath, bytesBefore: before.length, error: message,
      });
      void logged;
      throw err;
    }

    // Either it landed despite the error, or we cannot tell. Both are reported, never thrown as a
    // plain failure — the caller must know the account may have changed.
    const logged = logMutation({
      at, symbol,
      outcome: landed ? "landed-despite-error" : "outcome-unknown",
      snapshotPath, bytesBefore: before.length, bytesAfter: after.length, error: message,
    });
    return {
      symbol, snapshotPath,
      bytesBefore: before.length, bytesAfter: after.length,
      verified: Boolean(landed),
      outcomeUnknown: landed
        ? undefined
        : `The write errored (${message}) and the layout could not be read back, so it is unknown whether it was applied. The previous layout is at ${snapshotPath}.`,
      logged,
      at,
    };
  }

  invalidateLayout(symbol);

  /* ---- verify ---- */

  let after = "";
  let verified = false;
  let verifyError: string | undefined;
  try {
    after = await readLayoutBytes(symbol);
    // Compare against the normalised form: that is what the server was given.
    verified = normalizeSeriesIds(after) === content;
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
  }

  if (verified) {
    const logged = logMutation({
      at, symbol, outcome: "ok", snapshotPath, bytesBefore: before.length, bytesAfter: after.length,
    });
    return {
      symbol, snapshotPath,
      bytesBefore: before.length, bytesAfter: after.length,
      verified: true, logged, at,
    };
  }

  /* ---- roll back ---- */

  // A read-back that THREW says nothing about what the account holds. Rolling back on that basis
  // would be a second blind write, and if the first one was fine it would be the destructive one.
  if (verifyError) {
    const logged = logMutation({
      at, symbol, outcome: "unverifiable", snapshotPath, bytesBefore: before.length, verifyError,
    });
    return {
      symbol, snapshotPath,
      bytesBefore: before.length, bytesAfter: 0,
      verified: false, verifyError,
      outcomeUnknown:
        `The write was accepted but could not be read back (${verifyError}), so it is unknown what ${symbol} now holds. ` +
        `No rollback was attempted, because restoring on an unread state could overwrite a correct write. ` +
        `The previous layout is at ${snapshotPath}.`,
      logged, at,
    };
  }

  // Nothing to undo when the account already holds the snapshot. Two ways that happens: the write
  // was silently not persisted (Stockbit answers 200 and stores nothing in some cases), or it was
  // rejected after the fact. Sending a "restore" here would be a pointless write — and when `before`
  // is empty it is a guaranteed failure, because the server rejects an empty `content` outright
  // ("Silahkan Periksa permintaan"). Observed live: it reported rollback-failed and warned that the
  // account might be in an unexpected state, when the account was exactly as the user left it.
  if (after === before) {
    const logged = logMutation({
      at, symbol, outcome: "not-persisted", snapshotPath, bytesBefore: before.length, bytesAfter: after.length,
    });
    return {
      symbol, snapshotPath,
      bytesBefore: before.length, bytesAfter: after.length,
      verified: false,
      rolledBack: true,
      rollbackVerified: true,
      outcomeUnknown:
        `Stockbit accepted the write for ${symbol} but the layout read back unchanged, so it was not stored. ` +
        `Nothing was altered — the account still holds exactly what it did before.`,
      logged, at,
    };
  }

  let rollbackFailed: string | undefined;
  let rollbackVerified = false;
  try {
    // Restoring an empty layout is legitimate ONLY because `before` is now the true byte count from
    // an untruncated read — when this went through the display accessor, "" meant "large layout" and
    // this line was the thing that destroyed it.
    await putLayout(symbol, before);
    invalidateLayout(symbol);
    // The restore gets the same scrutiny as the write: a 2xx does not prove the right bytes landed,
    // which is the entire reason the verify step above exists.
    const restored = await readLayoutBytes(symbol);
    rollbackVerified = restored === before;
  } catch (err) {
    rollbackFailed = err instanceof Error ? err.message : String(err);
  }

  const logged = logMutation({
    at, symbol,
    outcome: rollbackFailed ? "rollback-failed" : rollbackVerified ? "rolled-back" : "rollback-unverified",
    snapshotPath, bytesBefore: before.length, bytesAfter: after.length,
    rollbackError: rollbackFailed,
  });

  return {
    symbol, snapshotPath,
    bytesBefore: before.length, bytesAfter: after.length,
    verified: false,
    rolledBack: !rollbackFailed,
    rollbackVerified,
    rollbackFailed,
    logged,
    at,
  };
}

/* ------------------------------- named layouts (templates) ------------------------------- */

const TemplateList = z
  .object({ data: z.array(z.object({ name: z.string().optional() }).passthrough()).nullable().optional() })
  .passthrough();

export interface TemplateSaveResult {
  name: string;
  /** Names already present before the save. */
  before: string[];
  after: string[];
  /** True when the name appears in the list read back afterwards. */
  verified: boolean;
  /** True when a template of this name already existed — the save REPLACES it. */
  replacedExisting: boolean;
  logged: boolean;
  at: string;
}

/** The saved named layouts on the account. */
export async function listChartTemplates(): Promise<string[]> {
  const body = await getJson("chartbitTemplates");
  const parsed = TemplateList.safeParse(body);
  if (!parsed.success) return [];
  return (parsed.data.data ?? []).map((t) => t.name ?? "").filter(Boolean);
}

/**
 * Save a layout under a name.
 *
 * Additive rather than destructive, which changes the safety story: there is no slot being
 * overwritten, so no snapshot-and-rollback is needed. What IS needed is telling the user when a name
 * already exists, because saving over it replaces that template — so `replacedExisting` is read
 * before the write and reported.
 *
 * Note the payload differs from the per-symbol route: Stockbit's client sends
 * `{name, content: JSON.stringify(layout)}` here WITHOUT the series-id substitution it applies to
 * `saveLayout`. Reproduced faithfully rather than unified, because the server is the authority on
 * which form it expects.
 */
export async function saveChartTemplate(options: {
  name: string;
  layout: unknown;
  confirm: boolean;
}): Promise<TemplateSaveResult> {
  const at = new Date().toISOString();
  const name = options.name.trim();

  if (options.confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to save a chart template without confirm: true. This writes a named layout to the Stockbit account.`,
    );
  }
  if (!name) throw new StockbitError("invalid_param", "A template needs a name");
  if (!isPlausibleLayout(options.layout)) {
    throw new StockbitError(
      "invalid_param",
      "This does not look like a Chartbit layout (expected charts[0].panes[0]). Refusing to send it.",
    );
  }

  const before = await listChartTemplates();
  const replacedExisting = before.includes(name);

  await postJson("chartbitSaveTemplate", { body: { name, content: JSON.stringify(options.layout) } });

  const after = await listChartTemplates();
  const verified = after.includes(name);
  const logged = logMutation({
    at, symbol: `template:${name}`,
    outcome: verified ? "template-saved" : "template-not-persisted",
    bytesBefore: before.length, bytesAfter: after.length, replacedExisting,
  });

  return { name, before, after, verified, replacedExisting, logged, at };
}

/** Literals that would be rewritten on save, for a caller that wants to check before committing. */
export function inspectPayload(layout: unknown): { plausible: boolean; wouldRewrite: string[] } {
  let serialized = "";
  try {
    serialized = JSON.stringify(layout) ?? "";
  } catch {
    serialized = "";
  }
  return { plausible: isPlausibleLayout(layout), wouldRewrite: corruptingLiterals(serialized) };
}
