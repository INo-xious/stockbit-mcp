/**
 * Symbol validation is the single chokepoint between tool input and a URL path segment, so its
 * rejection set is worth pinning explicitly rather than only via the transport's route tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSymbol, normalizeSymbol } from "../src/symbol.ts";
import { StockbitError } from "../src/http/errors.ts";

test("normalizeSymbol accepts real IDX tickers, indices, and hyphenated boards", () => {
  for (const [input, expected] of [
    ["BBRI", "BBRI"],
    ["bbri", "BBRI"],
    ["  bbri  ", "BBRI"],
    ["IHSG", "IHSG"],
    ["LQ45", "LQ45"],
    ["GOTO", "GOTO"],
    ["BUKA-W", "BUKA-W"],
    ["bbri-r", "BBRI-R"],
    // Surrounding whitespace is stripped, so it never reaches the path. Internal whitespace is
    // rejected below — trimming is a normalization, not a tolerance for separators.
    ["BBRI\n", "BBRI"],
    ["\tBBRI ", "BBRI"],
  ] as const) {
    assert.equal(normalizeSymbol(input), expected);
  }
});

test("normalizeSymbol rejects anything that could change a URL's meaning", () => {
  const rejected = [
    "",
    "   ",
    "../../login/refresh",
    "..",
    ".",
    "BBRI/info",
    "BBRI\\info",
    "BBRI?limit=1",
    "BBRI#frag",
    "BBRI&x=1",
    "BBRI%2F..",
    "%2e%2e",
    "BBRI:8080",
    "BBRI BBCA",
    "BB RI",
    "BBRI\tBBCA",
    "http://evil.test",
    "//evil.test",
    "BBRI_A",
    "BBRI.JK",
    "TOOLONGSYMBOLNAME",
    "-W",
    "BBRI-",
    "BBRI-WARRANT",
  ];
  for (const input of rejected) {
    assert.throws(
      () => normalizeSymbol(input),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      `${JSON.stringify(input)} must be rejected as invalid_param`,
    );
  }
});

test("a rejected Symbol is user error, not upstream schema drift", () => {
  // Misfiling this as schema_drift would send the user hunting for an API change that never
  // happened; invalid tool input should remain distinct from an upstream contract change.
  try {
    normalizeSymbol("../secrets");
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(err instanceof StockbitError);
    assert.equal(err.kind, "invalid_param");
    assert.notEqual(err.kind, "schema_drift");
  }
});

test("isSymbol judges the already-normalized form without throwing", () => {
  assert.equal(isSymbol("BBRI"), true);
  assert.equal(isSymbol("BUKA-W"), true);
  // Lowercase is not a valid Symbol — it is an input that normalizes to one.
  assert.equal(isSymbol("bbri"), false);
  assert.equal(isSymbol("../x"), false);
  assert.equal(isSymbol(""), false);
});
