/**
 * Turning what someone typed into a filter the code can enforce.
 *
 * The command ends in a free-text prompt, and the temptation is to hand that prompt to a model on
 * every interval and let it decide what counts. That is the wrong shape twice over: it is a fresh
 * judgement each time, so the same market produces different answers, and none of the judgements are
 * written down anywhere they can be reviewed.
 *
 * So the prompt is compiled ONCE, into data, by the deterministic code below. From then on plain
 * comparisons enforce it. The compiled result is echoed back to the user before anything runs,
 * because the prompt is the single easiest place for this tool to quietly do something other than
 * what was asked.
 *
 * ## Honest downgrades
 *
 * Some prompts ask for things the data cannot support. "Watch for bandar accumulation" is the
 * important one: IDX closed broker codes in live running trade on 6 December 2021, so broker
 * identity is end-of-day only and no real-time answer exists. The compiler does not silently ignore
 * that request and it does not pretend to serve it — it records a downgrade note that the caller must
 * show. A tool that quietly drops half a request is worse than one that refuses it.
 */
import type { Severity, SignalKind } from "./signals.js";

export type Side = "buy" | "sell" | "both";

export interface WatchSpec {
  /** Which detectors are enabled. Empty means "all of them". */
  kinds: SignalKind[];
  side: Side;
  /** Rupiah floor from the prompt, or null for the detector default. */
  minValue: number | null;
  severityFloor: Severity;
  /** Extra symbols named inside the prompt itself, beyond the scope argument. */
  symbols: string[];
  /** Requests that cannot be served as asked, and what happens instead. */
  downgrades: string[];
  /** One sentence per decision, for echoing back. */
  interpretation: string[];
}

const ALL_KINDS: SignalKind[] = [
  "value-surge",
  "band-approach",
  "book-imbalance",
  "wall-change",
  "awakening",
  "uma-flag",
  "floor-locked",
];

/**
 * Rupiah magnitude words, Indonesian and English.
 *
 * `m` is deliberately absent as a bare suffix: in Indonesian "M" means miliar (10^9) while in English
 * it reads as million (10^6), and guessing wrong is a thousandfold error on a money floor. A bare
 * "m" therefore falls through to the explicit words below rather than being resolved by coin flip.
 */
const MAGNITUDES: [RegExp, number][] = [
  [/\b(miliar|milyar|billion|bn)\b/i, 1e9],
  [/\b(juta|jt|million)\b/i, 1e6],
  [/\b(ribu|rb|thousand|k)\b/i, 1e3],
];

/**
 * Parse a money floor like "1 miliar", "300jt", "Rp 500 juta", "2 billion".
 *
 * The suffix is checked SEPARATELY from the following words, because "300jt" has no word boundary
 * between the digits and the unit — a `\b`-anchored pattern silently fails to match it and the whole
 * floor is dropped, which reads as "no floor was asked for".
 */
export function parseMoney(text: string): number | null {
  const m = /(?:rp\s*)?(\d+(?:[.,]\d+)?)\s*([a-z]*)/i.exec(text);
  if (!m) return null;
  const amount = Number(m[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // A unit glued straight onto the number: "300jt", "2bn".
  const glued = (m[2] ?? "").toLowerCase();
  if (glued) {
    for (const [re, mult] of MAGNITUDES) {
      if (re.test(` ${glued} `)) return amount * mult;
    }
  }

  // Otherwise a separate word after it: "300 juta".
  const tail = text.slice(m.index + m[0].length);
  for (const [re, mult] of MAGNITUDES) {
    if (re.test(tail)) return amount * mult;
  }
  return null;
}

const has = (t: string, ...words: string[]): boolean => words.some((w) => t.includes(w));

/**
 * Compile a free-text prompt into a spec.
 *
 * Unrecognised prompts produce a spec with every detector enabled, and say so. That is the right
 * default: a user who typed something the compiler does not understand should get the full picture
 * and a note, not silence.
 */
export function compilePrompt(prompt: string | null | undefined): WatchSpec {
  const raw = (prompt ?? "").trim();
  const t = raw.toLowerCase();

  const kinds = new Set<SignalKind>();
  const interpretation: string[] = [];
  const downgrades: string[] = [];
  let side: Side = "both";
  let minValue: number | null = null;
  let severityFloor: Severity = "watch";

  if (!raw) {
    return {
      kinds: [...ALL_KINDS],
      side: "both",
      minValue: null,
      severityFloor: "watch",
      symbols: [],
      downgrades: [],
      interpretation: ["No prompt given, so every signal is enabled at default thresholds."],
    };
  }

  // --- what to watch for -------------------------------------------------
  if (has(t, "big buy", "big money", "transaksi besar", "beli besar", "big transaction", "borong", "akumulasi besar")) {
    kinds.add("value-surge");
    interpretation.push("Watching for unusually large money arriving (value surge).");
  }
  if (has(t, "dump", "dumping", "buang", "dilepas", "distribusi", "jual besar", "sell off", "selloff")) {
    kinds.add("value-surge");
    side = "sell";
    interpretation.push("Watching the sell side specifically.");
  }
  if (has(t, "ara", "auto reject atas", "limit up", "mentok atas")) {
    kinds.add("band-approach");
    interpretation.push("Watching how close price is to the auto-reject ceiling (ARA).");
  }
  if (has(t, "arb", "auto reject bawah", "limit down", "gocap", "nyangkut", "floor")) {
    kinds.add("floor-locked");
    kinds.add("band-approach");
    interpretation.push("Watching the auto-reject floor (ARB), including being locked on it.");
  }
  if (has(t, "bid", "offer", "antrian", "order book", "orderbook", "imbalance", "tebal", "tipis")) {
    kinds.add("book-imbalance");
    interpretation.push("Watching one-sided depth at the top of the order book.");
  }
  if (has(t, "wall", "dinding", "ditarik", "withdraw", "spoof", "layering")) {
    kinds.add("wall-change");
    interpretation.push("Watching for resting depth appearing or being withdrawn.");
    if (has(t, "spoof", "layering")) {
      downgrades.push(
        "Reported as \"depth withdrawn\", never as spoofing: you can observe an order leaving, not the intent behind it, and IDX books carry no per-order participant id.",
      );
    }
  }
  if (has(t, "tiba-tiba rame", "biasanya sepi", "sepi", "wake", "awakening", "unusual volume", "rame")) {
    kinds.add("awakening");
    interpretation.push("Watching for normally quiet names trading heavily.");
  }
  if (has(t, "uma", "unusual market activity", "notasi", "notation")) {
    kinds.add("uma-flag");
    interpretation.push("Watching IDX's own UMA and notation flags.");
  }

  // --- the request that cannot be served -------------------------------
  if (has(t, "bandar", "bandarmology", "bandarmologi", "broker", "akumulasi bandar")) {
    downgrades.push(
      "Broker/bandar activity cannot be watched live: IDX closed broker codes in running trade on 6 December 2021, so that data is end-of-day only. It is available as next-morning context, not as an alert.",
    );
  }

  // --- how loud ---------------------------------------------------------
  if (has(t, "huge", "besar sekali", "sangat besar", "only wake", "wake me", "bangunkan", "penting saja", "urgent")) {
    severityFloor = "critical";
    interpretation.push("Only the most severe alerts will be sent.");
  }

  // --- money floor ------------------------------------------------------
  const ignore = /(?:ignore|abaikan|skip|di ?bawah|under|below|minimal|min)\s+([^,.;]*)/i.exec(raw);
  if (ignore) {
    const floor = parseMoney(ignore[1]);
    if (floor) {
      minValue = floor;
      interpretation.push(`Ignoring anything below Rp ${floor.toLocaleString("en-US")}.`);
    }
  }

  // --- symbols named inside the prompt ---------------------------------
  const symbols = [...new Set((raw.toUpperCase().match(/\b[A-Z]{4}(?:-[A-Z0-9]{1,3})?\b/g) ?? []))].filter(
    // Four-letter English words that are not tickers turn up constantly in these prompts.
    (s) => !["THAT", "WHEN", "WITH", "FROM", "THIS", "SAJA", "YANG", "KALO", "KALAU", "ADA", "TELL", "ONLY", "SHOW", "LOTS"].includes(s),
  );
  if (symbols.length) interpretation.push(`Symbols named in the prompt: ${symbols.join(", ")}.`);

  const enabled = kinds.size ? [...kinds] : [...ALL_KINDS];
  if (!kinds.size) {
    interpretation.push(
      "No specific signal was recognised in the prompt, so every signal is enabled — you will get the full picture rather than silence.",
    );
  }

  return { kinds: enabled, side, minValue, severityFloor, symbols, downgrades, interpretation };
}

/** Render the compiled spec for the user to confirm before anything runs. */
export function describeSpec(spec: WatchSpec): string[] {
  const lines = [...spec.interpretation];
  if (spec.side !== "both") lines.push(`Side: ${spec.side}.`);
  lines.push(`Signals enabled: ${spec.kinds.join(", ")}.`);
  if (spec.severityFloor !== "watch") lines.push(`Severity floor: ${spec.severityFloor}.`);
  for (const d of spec.downgrades) lines.push(`NOTE: ${d}`);
  return lines;
}
