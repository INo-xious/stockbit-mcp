import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRefresh } from "../src/auth/login.ts";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig-part";

test("extractRefresh finds a top-level `refresh` JWT (the /login/v6/social shape)", () => {
  assert.equal(extractRefresh({ access: "x", refresh: JWT }), JWT);
});

test("extractRefresh finds a nested refresh_token JWT", () => {
  assert.equal(extractRefresh({ data: { data: { refresh_token: JWT } } }), JWT);
});

test("extractRefresh ignores non-JWT and unrelated fields", () => {
  assert.equal(extractRefresh({ refresh: "not-a-jwt", wskey: "abc123" }), null);
  assert.equal(extractRefresh({ token: JWT }), null); // `token`, not refresh — skip
  assert.equal(extractRefresh("string"), null);
  assert.equal(extractRefresh(null), null);
});

test("extractRefresh handles cyclic objects safely", () => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  assert.equal(extractRefresh(o), null);
});
