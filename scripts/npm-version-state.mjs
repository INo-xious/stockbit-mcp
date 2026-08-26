#!/usr/bin/env node
/**
 * Is this exact version already on the npm registry?
 *
 * The publish workflows used to ask that inline, as
 * `if node -e "…process.exit(d.versions['$version'] ? 0 : 1)"`, and it had two defects a release
 * pipeline cannot afford:
 *
 *   1. It FAILED OPEN. Every non-zero exit landed in the `else` branch and was read as "not
 *      published yet" — which means "publish it". A missing file, malformed JSON, a syntax error or
 *      an OOM all voted to publish. Observed: `zod@3.23.8`, a version that unquestionably exists,
 *      reported "publish" because the temp file could not be read. An internal error must never be
 *      able to authorise an irreversible push to a public registry.
 *   2. The version was INTERPOLATED INTO JAVASCRIPT SOURCE. A version containing a quote closed the
 *      string literal, which is a correctness bug on its own and — via defect 1 — turned a syntax
 *      error into a publish.
 *
 * So the contract here has THREE outcomes rather than two, and the third one is the entire point:
 *
 *   stdout `present` + exit 0 — the registry answered, and this version is there.
 *   stdout `absent`  + exit 0 — the registry answered, and this version is not there.
 *   exit 2 + stderr           — COULD NOT DETERMINE. Never, for any reason, `absent`.
 *
 * Callers read the WORD, not the exit code, so `set -e` turns "could not determine" into a failed
 * job instead of a publish.
 *
 * Usage:
 *   node scripts/npm-version-state.mjs [--name <name>] [--version <version>]
 *                                      [--registry <url>] [--registry-file <path>]
 *                                      [--retries <n>] [--timeout <ms>]
 *
 * `--name` and `--version` default to package.json and are overridable so this is testable without
 * mutating the repo. `--registry-file` reads a packument from disk instead of over the network, so
 * the tests need no registry.
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
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Statuses where the registry is reachable but momentarily unwilling. Retrying these is worthwhile;
 * retrying a 401 or a 400 is not, and retrying a 404 would be wrong — it is a real answer.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Name and version as this repository declares them. */
export function packageDefaults(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return { name: pkg.name, version: pkg.version };
}

/**
 * The packument URL for a package name.
 *
 * `@scope/name` is ONE path segment on the registry: the `@` stays and the slash is percent-encoded.
 * Everything is encoded rather than concatenated so a name can never add a path segment or a query
 * string of its own — the name is data here, exactly like the version.
 */
export function packumentUrl(name, registry = DEFAULT_REGISTRY) {
  const segment = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${registry.replace(/\/+$/, "")}/${segment}`;
}

function parsePackument(text, where) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new UndeterminedError(`${where} did not return valid JSON`, { cause });
  }
}

/**
 * Decide present/absent from an already-parsed packument.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `versions[version]`: the truthiness test this
 * replaces answered "present" for `constructor`, `toString`, `__proto__` and every other
 * Object.prototype key, because those resolve up the prototype chain. A version is a KEY to look up,
 * never code and never a property path.
 *
 * A body with no `versions` map is NOT treated as "no versions, therefore absent". Every real
 * packument has one, so its absence means this is some other document — an error envelope, a
 * fully-unpublished placeholder — and inferring absence from it is precisely the fail-open this
 * script exists to remove.
 */
export function stateFromPackument(packument, version) {
  if (packument === null || typeof packument !== "object" || Array.isArray(packument)) {
    throw new UndeterminedError("the registry returned a body that is not a packument object");
  }
  const { versions } = packument;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
    throw new UndeterminedError("the registry returned a document with no `versions` map");
  }
  return Object.prototype.hasOwnProperty.call(versions, version) ? PRESENT : ABSENT;
}

/**
 * Ask the registry whether `name@version` exists.
 *
 * Resolves to PRESENT or ABSENT. Throws `UndeterminedError` for everything else — including every
 * failure mode that used to mean "publish".
 */
export async function npmVersionState({
  name,
  version,
  registry = DEFAULT_REGISTRY,
  registryFile,
  fetch: fetchImpl = globalThis.fetch,
  retries = 2,
  timeoutMs = 15000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof name !== "string" || name === "") {
    throw new UndeterminedError("no package name to look up");
  }
  if (typeof version !== "string" || version === "") {
    throw new UndeterminedError("no version to look up");
  }

  // Offline mode, for the tests: a packument read from disk. An unreadable or malformed file is
  // "could not determine", never "absent" — that substitution is the original bug.
  if (registryFile !== undefined) {
    let text;
    try {
      text = readFileSync(registryFile, "utf8");
    } catch (cause) {
      throw new UndeterminedError(`could not read the packument file ${registryFile}`, { cause });
    }
    return stateFromPackument(parsePackument(text, registryFile), version);
  }

  const url = packumentUrl(name, registry);
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

    // The package has never been published at all. This is the legitimate first-publish case, and
    // the only error-shaped answer allowed to mean "absent".
    if (response.status === 404) return ABSENT;

    if (response.status === 200) {
      return stateFromPackument(parsePackument(await response.text(), url), version);
    }

    lastProblem = `${url} answered HTTP ${response.status}, which is neither 200 nor 404`;
    if (RETRYABLE_STATUS.has(response.status) && attempt <= retries) {
      await sleep(attempt * 1000);
      continue;
    }
    throw new UndeterminedError(lastProblem);
  }

  throw new UndeterminedError(lastProblem);
}

const FLAGS = new Set(["--name", "--version", "--registry", "--registry-file", "--retries", "--timeout"]);

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
      case "--registry-file":
        options.registryFile = value;
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
    const state = await npmVersionState({ ...packageDefaults(), ...options });
    out.write(`${state}\n`);
    return 0;
  } catch (error) {
    err.write(`npm-version-state: ${error?.message ?? error}\n`);
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
