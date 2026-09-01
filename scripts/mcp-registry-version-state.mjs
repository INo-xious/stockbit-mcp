#!/usr/bin/env node
/**
 * Is this exact version already in the MCP Registry?
 *
 * The sibling of `scripts/npm-version-state.mjs`, for the other registry this project publishes to,
 * and it exists because only half the release pipeline had ever been made idempotent.
 *
 * The npm half asks "is this version already published?" before acting, so a re-run, or the second
 * of two concurrent workflows, correctly does nothing. The MCP Registry half asked nothing: both
 * `publish.yml` and `release.yml` ran `mcp-publisher publish` unconditionally. Observed in
 * production on v1.3.0:
 *
 *     Error: publish failed: server returned status 400: {"title":"Bad Request","status":400,
 *     "detail":"Failed to publish server","errors":[{"message":"invalid version: cannot publish
 *     duplicate version"}]}
 *
 * — a RED run reporting a failure that had in fact already succeeded, minutes earlier, from the
 * other workflow. `npm version <bump> && git push --follow-tags` delivers the commit and the tag in
 * one push with the user's credential, so both workflows start; the shared concurrency group
 * serialises them; the first publishes; the second re-publishes and is refused.
 *
 * The contract is the sibling's, deliberately, so the two read the same way:
 *
 *   stdout `present` + exit 0 — the registry answered, and this version is there.
 *   stdout `absent`  + exit 0 — the registry answered, and this version is not there.
 *   exit 2 + stderr           — COULD NOT DETERMINE. Never, for any reason, invented as either.
 *
 * What the CALLER does with the third outcome is where the two part company, and the reason is that
 * the costs are mirror images:
 *
 *   - For npm, a wrong `absent` publishes something irreversible. So there, undetermined must never
 *     reach the publish, and `set -e` on exit 2 fails the job.
 *   - Here, a wrong `present` SKIPS, and a version silently missing from the registry is the exact
 *     "silent no-op" `publish.yml` is written to forbid. A wrong `absent` merely re-attempts a
 *     publish the registry itself refuses, which costs nothing. So the workflows treat undetermined
 *     as "go ahead and try", and the registry's own duplicate refusal is the backstop.
 *
 * Two facts about the endpoint, both established by querying it rather than by reading about it:
 *
 *   1. `search` is a SUBSTRING match, not an exact one. `io.github.someone/stockbit-mcp` would match
 *      a query for `stockbit-mcp`. So a hit only counts when `server.name` equals the name exactly
 *      and `server.version` equals the version exactly.
 *   2. An unknown server and an unknown version both answer HTTP 200 with `{"servers":[],
 *      "metadata":{"count":0}}` — never a 404. Which is why, unlike the npm sibling, a 404 here is
 *      NOT "absent": this endpoint has no 404 for a real query, so one means the API moved, and
 *      that is undetermined.
 *
 * Usage:
 *   node scripts/mcp-registry-version-state.mjs [--name <name>] [--version <version>]
 *                                               [--registry <url>] [--response-file <path>]
 *                                               [--retries <n>] [--timeout <ms>]
 *
 * `--name` and `--version` default to `server.json` — not `package.json`, because `server.json` is
 * the document `mcp-publisher` actually publishes and it carries its own `version` field.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The two answers that mean "the registry told me". Both exit 0. */
export const PRESENT = "present";
export const ABSENT = "absent";

/**
 * The third outcome. Anything that is not a definite present/absent answer throws this, and the CLI
 * turns it into exit 2 — deliberately not exit 1, so a caller can tell it apart from a shell error.
 */
export class UndeterminedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "UndeterminedError";
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io";

/**
 * Statuses where the registry is reachable but momentarily unwilling. Retrying these is worthwhile;
 * retrying a 400 or a 401 is not. 404 is absent from this set on purpose — see the header: it is
 * not a real answer from this endpoint, so it is undetermined rather than something to retry into.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Name and version as `server.json` declares them. */
export function serverDefaults(root = ROOT) {
  const path = join(root, "server.json");
  let server;
  try {
    server = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new UndeterminedError(`could not read ${path}`, { cause });
  }
  if (server === null || typeof server !== "object" || Array.isArray(server)) {
    throw new UndeterminedError(`${path} is not an object`);
  }
  return { name: server.name, version: server.version };
}

/**
 * The query URL for one name at one version.
 *
 * Both values are percent-encoded rather than concatenated, so neither can add a parameter of its
 * own: the name is data here, exactly like the version. `io.github.owner/name` contains a slash,
 * which is legal inside a query value and must survive as one.
 */
export function searchUrl(name, version, registry = DEFAULT_REGISTRY) {
  const base = `${registry.replace(/\/+$/, "")}/v0/servers`;
  return `${base}?search=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`;
}

function parseBody(text, where) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new UndeterminedError(`${where} did not return valid JSON`, { cause });
  }
}

/**
 * Decide present/absent from an already-parsed search response.
 *
 * An empty `servers` array IS a real answer — the endpoint returns exactly that for a version it
 * does not have, and for a server it has never heard of. A body with no `servers` ARRAY is not: a
 * response that omits it is some other document, an error envelope or a moved API, and inferring
 * "absent" from it would be the fail-open this pair of scripts exists to remove.
 *
 * The comparison is exact on both fields because `search` matches substrings, so the array can
 * legitimately contain a DIFFERENT server whose name merely contains this one's.
 */
export function stateFromSearch(body, name, version) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new UndeterminedError("the registry returned a body that is not a search response object");
  }
  const { servers } = body;
  if (!Array.isArray(servers)) {
    throw new UndeterminedError("the registry returned a document with no `servers` array");
  }
  const hit = servers.some((entry) => {
    const server = entry === null || typeof entry !== "object" ? undefined : entry.server;
    if (server === null || typeof server !== "object") return false;
    return server.name === name && server.version === version;
  });
  return hit ? PRESENT : ABSENT;
}

/**
 * Ask the registry whether `name@version` is published.
 *
 * Resolves to PRESENT or ABSENT. Throws `UndeterminedError` for everything else.
 */
export async function mcpRegistryVersionState({
  name,
  version,
  registry = DEFAULT_REGISTRY,
  responseFile,
  fetch: fetchImpl = globalThis.fetch,
  retries = 2,
  timeoutMs = 15000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof name !== "string" || name === "") {
    throw new UndeterminedError("no server name to look up");
  }
  if (typeof version !== "string" || version === "") {
    throw new UndeterminedError("no version to look up");
  }

  // Offline mode, for the tests: a search response read from disk. An unreadable or malformed file
  // is "could not determine", never a guess in either direction.
  if (responseFile !== undefined) {
    let text;
    try {
      text = readFileSync(responseFile, "utf8");
    } catch (cause) {
      throw new UndeterminedError(`could not read the response file ${responseFile}`, { cause });
    }
    return stateFromSearch(parseBody(text, responseFile), name, version);
  }

  const url = searchUrl(name, version, registry);
  let lastProblem = `${url} was never reached`;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // Transport: DNS, TLS, a reset connection, the timeout above. Reported distinctly from "the
      // registry answered something unexpected" because they need different human responses.
      lastProblem = `could not reach ${url} (transport failure: ${cause?.message ?? cause})`;
      if (attempt <= retries) {
        await sleep(attempt * 1000);
        continue;
      }
      throw new UndeterminedError(lastProblem, { cause });
    }

    if (response.status === 200) {
      return stateFromSearch(parseBody(await response.text(), url), name, version);
    }

    lastProblem = `${url} answered HTTP ${response.status}, and this endpoint answers 200 for every real query`;
    if (RETRYABLE_STATUS.has(response.status) && attempt <= retries) {
      await sleep(attempt * 1000);
      continue;
    }
    throw new UndeterminedError(lastProblem);
  }

  throw new UndeterminedError(lastProblem);
}

const FLAGS = new Set(["--name", "--version", "--registry", "--response-file", "--retries", "--timeout"]);

/** Flags in either `--flag value` or `--flag=value` form. Unknown flags are a hard error. */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (!FLAGS.has(flag)) {
      throw new UndeterminedError(`unknown argument ${JSON.stringify(token)}`);
    }
    const value = eq === -1 ? argv[(i += 1)] : token.slice(eq + 1);
    if (value === undefined) {
      throw new UndeterminedError(`${flag} needs a value`);
    }
    switch (flag) {
      case "--name":
        options.name = value;
        break;
      case "--version":
        options.version = value;
        break;
      case "--registry":
        options.registry = value;
        break;
      case "--response-file":
        options.responseFile = value;
        break;
      case "--retries":
      case "--timeout": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          throw new UndeterminedError(`${flag} needs a non-negative number, not ${JSON.stringify(value)}`);
        }
        if (flag === "--retries") options.retries = n;
        else options.timeoutMs = n;
        break;
      }
    }
  }
  return options;
}

/** Returns the process exit code rather than calling `process.exit`, so it is callable from a test. */
export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  try {
    const options = parseArgs(argv);
    // The defaults are read only for whichever of name/version the caller did not supply, so a
    // fully-specified call never needs server.json to exist.
    const needsDefaults = options.name === undefined || options.version === undefined;
    const defaults = needsDefaults ? serverDefaults() : {};
    const state = await mcpRegistryVersionState({ ...defaults, ...options });
    out.write(`${state}\n`);
    return 0;
  } catch (error) {
    err.write(`mcp-registry-version-state: ${error?.message ?? error}\n`);
    return 2;
  }
}

/**
 * Run only when invoked as a program. Importing this from a test must not exit the test runner, and
 * the realpath comparison keeps that true through symlinks and Windows path casing.
 */
function invokedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return pathToFileURL(realpathSync(process.argv[1])).href === self;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main();
}
