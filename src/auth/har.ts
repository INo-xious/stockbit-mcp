/**
 * HAR import — the universal capture route.
 *
 * Some browsers cannot be driven at all: Safari exposes no reachable debugging protocol to third
 * parties (the WebKit Inspector transport is an Apple-entitled XPC service), and Firefox removed
 * CDP in v141. Rather than ship a per-browser automation matrix, this path inverts the problem:
 * the user logs in however they like, in whatever browser they like, exports the network log, and
 * we read the token out of the file. Every modern DevTools can produce a HAR with response bodies.
 *
 * SECURITY. A login HAR is the single most sensitive artifact in this system. It contains the
 * user's plaintext password in `request.postData` on a native login, every session cookie (Safari
 * and Firefox sanitize nothing), Authorization headers, and the refresh token itself. Therefore:
 * parse in memory, extract only the one field we need, never log any part of a HAR entry, never
 * copy the file anywhere, and offer to shred the original afterwards. Nothing in this module writes
 * a HAR or any of its contents to disk or to a log.
 */
import { readFileSync, statSync } from "node:fs";
import { refreshFromRawBody, tokenUrlAllowed } from "./capture.js";

/** Refuse absurd inputs rather than OOM. A login-flow HAR is typically 5-50 MB. */
export const MAX_HAR_BYTES = 256 * 1024 * 1024;

export interface HarMatch {
  refresh: string;
  /** The URL the token came from — safe to show; it carries no secret. */
  url: string;
  /** Index in log.entries, for a diagnostic that names the entry without dumping it. */
  entryIndex: number;
}

export interface HarScanReport {
  totalEntries: number;
  /** Entries whose URL is an allowed token source. */
  candidateUrls: string[];
  /** Candidates that carried no body — the classic "Copy all as HAR" mistake. */
  candidatesWithoutBody: number;
  match: HarMatch | null;
}

interface HarEntry {
  request?: { url?: unknown };
  response?: {
    content?: { text?: unknown; encoding?: unknown; mimeType?: unknown };
  };
}

/**
 * Scan a parsed HAR for a main-session refresh token.
 *
 * Returns a report rather than a bare token so the CLI can explain *why* nothing was found — the
 * three real-world failures (wrong export command, log cleared by the OAuth redirect, logged in
 * with a flow that never issues a main-session token) are indistinguishable from a null return.
 */
export function scanHar(har: unknown): HarScanReport {
  const entries = (har as { log?: { entries?: unknown } })?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(
      "That file is not a HAR archive (no `log.entries` array). Export it from the browser's " +
        "Network panel using the download/export button.",
    );
  }

  const report: HarScanReport = {
    totalEntries: entries.length,
    candidateUrls: [],
    candidatesWithoutBody: 0,
    match: null,
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as HarEntry;
    const url = entry?.request?.url;
    if (typeof url !== "string" || !tokenUrlAllowed(url)) continue;

    report.candidateUrls.push(url);

    const content = entry?.response?.content;
    const text = content?.text;
    if (typeof text !== "string" || !text) {
      // Present but body-less: "Copy all as HAR" in Chrome, or a body over Firefox's 1 MiB cap.
      report.candidatesWithoutBody++;
      continue;
    }

    const refresh = refreshFromRawBody(text, content?.encoding === "base64");
    if (refresh) {
      report.match = { refresh, url, entryIndex: i };
      return report;
    }
  }

  return report;
}

/** Read + parse a HAR file from disk, with a size guard. Never logs the contents. */
export function scanHarFile(path: string): HarScanReport {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
  if (size > MAX_HAR_BYTES) {
    throw new Error(
      `HAR file is ${(size / 1024 / 1024).toFixed(0)} MB, over the ${MAX_HAR_BYTES / 1024 / 1024} MB limit. ` +
        "Clear the Network log immediately before logging in so only the login requests are captured.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // The parser's own message is NOT interpolated. V8 quotes the offending source text in
    // SyntaxError messages ("Unexpected token 'h', \"hunter2\"... is not valid JSON"), so echoing
    // it would print a fragment of a file that holds the user's password and cookies — exactly what
    // this module promises never to do. Only the character offset is safe to pass through.
    const position = err instanceof Error ? /position (\d+)/.exec(err.message)?.[0] : undefined;
    throw new Error(
      `${path} is not valid JSON${position ? ` (at ${position})` : ""}. ` +
        "Re-export it from the Network panel using the download button.",
    );
  }
  return scanHar(parsed);
}

/**
 * Human-facing guidance when a scan finds nothing. Each branch maps to a distinct real mistake, so
 * the user is told what to change rather than just "not found".
 */
export function explainMiss(report: HarScanReport): string {
  if (report.totalEntries === 0) {
    return "The HAR has no entries at all — the Network panel was empty when you exported it.";
  }
  if (report.candidateUrls.length === 0) {
    return (
      `Scanned ${report.totalEntries} entries; none were a Stockbit login response.\n` +
      "  • Enable 'Preserve log' BEFORE logging in — the login redirect clears the log by default.\n" +
      "  • Make sure you completed the login while the Network panel was recording.\n" +
      "  • Google/Facebook login does not currently work on Stockbit's site; use username + password."
    );
  }
  if (report.candidatesWithoutBody > 0) {
    return (
      `Found ${report.candidateUrls.length} login response(s), but ${report.candidatesWithoutBody} had no body.\n` +
      "  • In Chrome/Edge use the Export (download) button — 'Copy all as HAR' omits response bodies.\n" +
      "  • In Firefox check devtools.netmonitor.har.includeResponseBodies is true (default)."
    );
  }
  return (
    `Found ${report.candidateUrls.length} login response(s) but no refresh token in any of them. ` +
    "The login may not have completed successfully."
  );
}
