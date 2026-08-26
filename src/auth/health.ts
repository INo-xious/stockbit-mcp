/**
 * What happened last time a credential was used.
 *
 * ## The honest starting point
 *
 * **You cannot prove a refresh token is live without spending it.** Spending it rotates the family,
 * which ends the user's website session — so the one command people run first when something looks
 * wrong was the command that broke the other half of their setup. `status --live` was that, and the
 * tool description sold it as "one request … to prove it still works".
 *
 * So stop inferring validity and start *recording* it. An expiry in a JWT payload is a claim about
 * time, not a statement of validity: a token can be revoked, or superseded by another login, and not
 * one byte of the payload changes. But every refresh this project makes already knows the answer.
 * Writing that down costs nothing and is the only way `status` can say "revoked" at **zero
 * requests**.
 *
 * ## What is in the file, and what is deliberately not
 *
 * `~/.stockbit/session-health.json`, mode 0600, **plaintext** — because it holds nothing worth
 * encrypting, and a diagnostic file a user is asked to paste into a public issue should be one they
 * can read first. Per slot: when the last refresh succeeded, when the last one failed, the HTTP
 * status, a short reason, and a **fingerprint** of the token that was presented.
 *
 * **No tokens. Not truncated, not encoded, not "just the first few characters".** The fingerprint is
 * `sha256:` plus eight hex characters of a digest — see `fingerprint.ts` for why that is not a
 * credential. It exists for exactly one job: telling *"the token that failed is the token you still
 * have"* from *"it has been replaced since"*. That distinction is the whole feature; without it a
 * recorded failure is just an old error message, and `status` would say "revoked" about a token the
 * user replaced ten minutes ago.
 *
 * `test/health.test.ts` asserts the serialised file contains nothing JWT-shaped and no substring of
 * any token that went through it.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileDir, writeFileAtomic, type StoreSlot } from "./store.js";
import { tokenFingerprint } from "./fingerprint.js";
import { redact } from "../redact.js";

const FILE_NAME = "session-health.json";

/** One recorded outcome. Never carries a token. */
export interface RefreshRecord {
  /** ISO timestamp. */
  at: string;
  /** Fingerprint of the token that was PRESENTED — never the token. */
  token: string;
  /** HTTP status, when the failure had one. Absent for a transport failure. */
  status?: number;
  /** A short redacted reason. Absent on success. */
  reason?: string;
}

export interface SlotHealth {
  lastOk?: RefreshRecord;
  lastFailure?: RefreshRecord;
}

export type HealthJournal = Partial<Record<StoreSlot, SlotHealth>>;

/**
 * What `status` can say about a slot without spending anything.
 *
 * `failing` is the one that did not exist before and is the reason for the file: a token that is
 * present, unexpired, and that Stockbit rejected the last time it was offered — with the fingerprint
 * still matching, so it is the same token and not one that has been replaced since.
 */
export type SlotHealthState = "not-stored" | "expired" | "failing" | "ok" | "unknown";

export function sessionHealthPath(): string {
  return join(fileDir(), FILE_NAME);
}

export function readHealthJournal(): HealthJournal {
  try {
    const path = sessionHealthPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HealthJournal;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A journal that cannot be read is no journal. It is diagnostics; nothing depends on it.
    return {};
  }
}

function write(journal: HealthJournal): void {
  try {
    mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
    writeFileAtomic(sessionHealthPath(), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"));
  } catch {
    // Recording is best-effort by definition: this runs beside a refresh that has already
    // succeeded or already failed, and neither outcome should change because a diagnostic file
    // could not be written.
  }
}

/** Record that a refresh with `token` succeeded. Never throws. */
export function recordRefreshOk(slot: StoreSlot, token: string): void {
  const journal = readHealthJournal();
  const entry = journal[slot] ?? {};
  entry.lastOk = { at: new Date().toISOString(), token: tokenFingerprint(token) };
  journal[slot] = entry;
  write(journal);
}

/**
 * Record that a refresh with `token` was rejected. Never throws.
 *
 * `reason` goes through `redact` on the way in, not on the way out. A failure reason can quote a
 * URL and a URL can carry a token, and this file is written once and read many times — including by
 * a user pasting it into a public issue.
 */
export function recordRefreshFailure(
  slot: StoreSlot,
  token: string,
  status: number | undefined,
  reason: string,
): void {
  const journal = readHealthJournal();
  const entry = journal[slot] ?? {};
  entry.lastFailure = {
    at: new Date().toISOString(),
    token: tokenFingerprint(token),
    ...(status === undefined ? {} : { status }),
    reason: redact(reason).slice(0, 200),
  };
  journal[slot] = entry;
  write(journal);
}

/** Forget everything recorded for a slot, or for all of them. Called by `logout`. */
export function clearSessionHealth(slot?: StoreSlot): void {
  if (!slot) {
    try {
      if (existsSync(sessionHealthPath())) writeFileAtomic(sessionHealthPath(), Buffer.alloc(0));
    } catch {
      /* best effort */
    }
    return;
  }
  const journal = readHealthJournal();
  if (!(slot in journal)) return;
  delete journal[slot];
  write(journal);
}

/**
 * Derive a slot's health from what is stored and what was recorded.
 *
 * The ordering matters and each rung answers a different question:
 *
 *   - nothing stored, or stored and expired — the payload alone settles it, no journal needed.
 *   - **`failing`**: a rejection recorded after the last success, whose fingerprint still matches
 *     the token that is there now. This is the revoked case, and it is visible at zero requests.
 *     The fingerprint check is what stops it firing about a token the user has since replaced.
 *   - `ok`: a success recorded for the token that is there now.
 *   - `unknown`: something is stored, and nothing has been recorded about *this* token. That is the
 *     ordinary state on a fresh install, and it is reported as ignorance rather than as health.
 */
export function slotHealthState(
  slot: StoreSlot,
  token: string | null,
  expired: boolean,
  journal: HealthJournal = readHealthJournal(),
): SlotHealthState {
  if (!token) return "not-stored";
  if (expired) return "expired";

  const entry = journal[slot];
  if (!entry) return "unknown";
  const fingerprint = tokenFingerprint(token);
  const failure = entry.lastFailure;
  const ok = entry.lastOk;

  const failedAfterSuccess =
    failure && (!ok || Date.parse(failure.at) >= Date.parse(ok.at));
  if (failedAfterSuccess && failure!.token === fingerprint) return "failing";
  if (ok && ok.token === fingerprint) return "ok";
  return "unknown";
}

/** The recorded event that explains a slot's state, so `status` can quote a time. */
export function lastEventFor(slot: StoreSlot, journal: HealthJournal = readHealthJournal()): RefreshRecord | null {
  const entry = journal[slot];
  if (!entry) return null;
  const { lastOk, lastFailure } = entry;
  if (lastOk && lastFailure) return Date.parse(lastFailure.at) >= Date.parse(lastOk.at) ? lastFailure : lastOk;
  return lastFailure ?? lastOk ?? null;
}
