/**
 * A short, one-way name for a token — so two places can agree they mean the same credential without
 * either of them holding it.
 *
 * Two things need this and neither may store a token:
 *
 *   - the access cache, to know whether the access token on disk was minted from the refresh token
 *     that is there NOW. Without it, logging in as a second account leaves the previous account's
 *     access token cached and usable for a day.
 *   - the session-health journal, to tell *"the token that failed is the token you still have"*
 *     from *"it has been replaced since"* — which is what lets `status` report a revoked session at
 *     zero requests.
 *
 * **Eight hex characters of a SHA-256.** That is 32 bits: enough that two different tokens
 * colliding is a curiosity rather than a plan, and far too little to be worth attacking. It is not
 * a credential, it is not JWT-shaped, it contains no substring of the token, and it is not
 * reversible — a JWT's own header is public and its payload is base64, so what secrecy a token has
 * lives in the signature, and eight hex characters of a digest of the whole thing reveal nothing
 * usable about any of it.
 *
 * The `sha256:` prefix is there so a reader of `session-health.json` can see at a glance that the
 * value is a digest and not a truncated token. `test/accesscache.test.ts` and the health tests both
 * assert the output is not JWT-shaped and is not a substring of the input.
 */
import { createHash } from "node:crypto";

/** How many hex characters of the digest to keep. See the module note on why it is this short. */
const FINGERPRINT_HEX = 8;

export function tokenFingerprint(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, FINGERPRINT_HEX)}`;
}
