/**
 * Strict command-line validation for the shipped CLIs — `stockbit-auth`, `stockbit-live`,
 * `stockbit-alerts`, `stockbit-batch`, and `stockbit-mcp`.
 *
 * Exists because of 2026-08-29: `stockbit-auth login --help` opened a real browser login, harvested
 * the signed-in session and overwrote the stored credential. Every bin read its flags with bespoke
 * `argv.includes("--x")` checks, so a token nobody asked about — `--help` included — was invisible.
 * The command you were asking ABOUT is the command that RAN. The same hole in `stockbit-live` made
 * `--help` start a scan, and in `stockbit-alerts` it started the long-lived daemon.
 *
 * The rule is the one `STOCKBIT_TOOLS` already enforces (`src/tools/_profile.ts`): **an unknown
 * token is an error, not a shrug.** Each bin declares, per command, every flag it reads and how many
 * positionals it takes; anything else is refused with a message that names the bad token, names
 * everything that command accepts, and points at `--help`. Help itself is answered here, BEFORE any
 * handler runs, so asking about a command can never execute it.
 *
 * This module is deliberately import-free and side-effect-free: the specs live next to the domains
 * (`src/auth/cli.ts`, `src/live/cli.ts`, `src/alerts/cli.ts`) and tests exercise both without
 * touching a bin, a store, a browser or the network. The bins own their exit conventions — auth
 * exits 2 on a `CliParseError`, live wraps it in its `ok:false` JSON contract, alerts sets
 * `process.exitCode` — because those contracts predate this module and callers rely on them.
 */

/** A flag that consumes a value, e.g. `--cash 100000000` or `--cash=100000000`. */
export interface ValueFlagSpec {
  /** What the value is called in usage lines: "N", "URL", "A,B". */
  placeholder: string;
  /** One help line, shown indented under the command. */
  help: string;
}

/** Everything one subcommand accepts. The spec is the single source for validation AND `--help`. */
export interface CommandSpec {
  /** One line for the top-level usage listing. */
  summary: string;
  /** Positional signature for usage lines, e.g. "<scope> <time-frame>". Omit when there are none. */
  usage?: string;
  /** Boolean flags: name (with the leading `--`) → one help line. */
  flags?: Readonly<Record<string, string>>;
  /** Flags that consume a value. */
  valueFlags?: Readonly<Record<string, ValueFlagSpec>>;
  /** Positional slots, in order. Whether a REQUIRED one is missing stays the handler's call. */
  positionals?: readonly { name: string; required: boolean }[];
  /** True when extra positionals are welcome (a trailing free-text prompt). */
  variadicTail?: boolean;
  /** Extra help lines printed after the flags (tutorials, caveats). */
  details?: readonly string[];
}

/** A per-CLI command table. */
export type CommandTable = Readonly<Record<string, CommandSpec>>;

/**
 * The user typed something this command does not accept.
 *
 * A distinct class rather than a bare `Error` so each bin can tell "you typed it wrong" from "it
 * ran and failed" and keep its own exit convention for each — the same split `IntervalParseError`
 * and `ScopeParseError` give `stockbit-live`.
 */
export class CliParseError extends Error {
  constructor(
    readonly command: string,
    readonly token: string,
    message: string,
  ) {
    super(message);
    this.name = "CliParseError";
  }
}

/** True for the two spellings of "show me the usage instead of running anything". */
export function isHelpToken(token: string): boolean {
  return token === "--help" || token === "-h";
}

/**
 * True for the two spellings of "tell me the version instead of running anything".
 *
 * Same shape as `isHelpToken`, and for the same reason: asking a command ABOUT itself must never
 * be answered by RUNNING it. `stockbit-mcp --version` started an MCP server on stdio and printed
 * nothing about the version, so the only way to learn what was installed was to read
 * `node_modules/stockbit-mcp/package.json` by hand — and the version was the first thing that
 * mattered, because npx had silently pinned a stale caret range.
 *
 * `-v` rather than `-V` because nothing in these bins uses `-v` for anything else; there is no
 * verbose flag to collide with.
 */
export function isVersionToken(token: string): boolean {
  return token === "--version" || token === "-v";
}

/** Every flag name a command accepts, boolean and value flags together, in declaration order. */
function flagNames(spec: CommandSpec): string[] {
  return [...Object.keys(spec.flags ?? {}), ...Object.keys(spec.valueFlags ?? {})];
}

/** "login accepts: --fresh-profile, --switch-account" — or "login accepts no flags". */
function accepts(cmd: string, spec: CommandSpec): string {
  const names = flagNames(spec);
  return names.length ? `${cmd} accepts: ${names.join(", ")}` : `${cmd} accepts no flags`;
}

/**
 * Validate one command line, answering `--help` first.
 *
 * Help wins over everything else in argv — a user asking for help must never be blocked by a second
 * typo on the same line, and must NEVER fall through to the handler. Only then is every remaining
 * token checked against the spec.
 *
 * Value-flag consumption mirrors the bins' readers exactly (`flagValue` in `bin/stockbit-auth.ts`):
 * the space form takes the next token iff it exists and does not start with `--` — so `--cash -5`
 * still reaches the handler's own numeric check — and `--flag=value` is one self-contained token
 * whose value, empty included, stays the handler's concern. Validation that disagreed with reading
 * would be this bug again, one layer up.
 *
 * @returns "help" (usage already written to `writeHelp`), "ok", or "unknown-command" — the bin's
 *   existing default case owns the unknown-command response.
 * @throws {CliParseError} on an unknown flag, a flag used with the wrong shape, or a positional the
 *   command has no slot for.
 */
export function gateCommandLine(
  bin: string,
  commands: CommandTable,
  cmd: string,
  argv: readonly string[],
  writeHelp: (text: string) => void,
): "help" | "ok" | "unknown-command" {
  const spec = commands[cmd];
  if (!spec) return "unknown-command";

  if (argv.some(isHelpToken)) {
    writeHelp(formatUsage(bin, commands, cmd));
    return "help";
  }

  validateTokens(bin, cmd, spec, argv);
  return "ok";
}

/**
 * Check every token of one already-selected command line against its spec.
 *
 * `cmd` is the subcommand, or `undefined` for a bin that has NO subcommands — `stockbit-mcp` takes
 * flags and nothing else. Both callers share this body so the two forms cannot drift into two
 * different ideas of what is acceptable, and every message is assembled from the same two pieces:
 * the bare form reads `stockbit-mcp: unknown flag "--verison"` where the subcommand form reads
 * `stockbit-auth login: unknown flag "--verison"`.
 */
function validateTokens(bin: string, cmd: string | undefined, spec: CommandSpec, argv: readonly string[]): void {
  const subject = cmd ?? bin;
  const prefix = cmd === undefined ? bin : `${bin} ${cmd}`;
  const seeHelp = `Run \`${prefix} --help\``;
  const flags = spec.flags ?? {};
  const valueFlags = spec.valueFlags ?? {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);

    if (name in valueFlags) {
      if (eq !== -1) continue; // `--flag=value` is self-contained; the handler reads the value.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        const p = valueFlags[name].placeholder;
        throw new CliParseError(
          subject,
          token,
          `${prefix}: ${name} needs a value — write ${name} ${p} or ${name}=${p}. ${seeHelp}.`,
        );
      }
      i++; // The next token is the value.
      continue;
    }

    if (name in flags) {
      if (eq !== -1) {
        throw new CliParseError(subject, token, `${prefix}: ${name} does not take a value. ${seeHelp}.`);
      }
      continue;
    }

    throw new CliParseError(
      subject,
      token,
      `${prefix}: unknown flag ${JSON.stringify(token)}. ${accepts(subject, spec)}. ${seeHelp} for what each does.`,
    );
  }

  const slots = spec.positionals?.length ?? 0;
  if (!spec.variadicTail && positionals.length > slots) {
    const extra = positionals[slots];
    const takes = slots
      ? `${subject} takes at most ${slots} positional argument${slots === 1 ? "" : "s"} (${spec.usage ?? ""})`.replace(" ()", "")
      : `${subject} accepts no positional arguments`;
    throw new CliParseError(subject, extra, `${prefix}: unexpected argument ${JSON.stringify(extra)}. ${takes}. ${seeHelp}.`);
  }
}

/**
 * The same gate for a bin that has no subcommands at all.
 *
 * `stockbit-mcp` is the whole reason this exists. It read `process.argv` nowhere, so every token on
 * its command line fell through to "start an MCP server on stdio" — `--version` included, which is
 * how asking the package what it was produced a running server and no version. The other four bins
 * were already gated; this one had no subcommand to hang a `CommandTable` entry on.
 *
 * Help and version are answered HERE, before any caller can act, for the reason `gateCommandLine`
 * answers help first: the command you are asking ABOUT must never be the command that RUNS.
 *
 * @returns "help" or "version" when it has already written the answer, "ok" to proceed.
 * @throws {CliParseError} on an unknown flag or an unexpected positional.
 */
export function gateBareCommandLine(
  bin: string,
  spec: CommandSpec,
  argv: readonly string[],
  write: (text: string) => void,
  version?: string,
): "help" | "version" | "ok" {
  if (argv.some(isHelpToken)) {
    write(formatBareUsage(bin, spec));
    return "help";
  }
  if (version !== undefined && argv.some(isVersionToken)) {
    write(`${version}\n`);
    return "version";
  }
  validateTokens(bin, undefined, spec, argv);
  return "ok";
}

/** One command's flag lines, indented, names padded so the help text lines up. */
function flagLines(spec: CommandSpec, indent: string): string[] {
  const entries: [string, string][] = [
    ...Object.entries(spec.flags ?? {}),
    ...Object.entries(spec.valueFlags ?? {}).map(
      ([name, v]): [string, string] => [`${name} ${v.placeholder}`, v.help],
    ),
  ];
  const width = Math.max(0, ...entries.map(([label]) => label.length));
  return entries.map(([label, help]) => `${indent}${label.padEnd(width)}  ${help}`);
}

/**
 * Render usage from the spec — the whole CLI, or one command.
 *
 * Generated rather than hand-written so the help text CANNOT drift from what the validator accepts:
 * before this module, the auth bin's usage block and its handlers were maintained separately, and
 * `--help` itself was in neither.
 *
 * @param epilogue extra lines for the top-level view (env-only configuration notes and the like).
 */
export function formatUsage(bin: string, commands: CommandTable, cmd?: string, epilogue?: readonly string[]): string {
  if (cmd !== undefined) {
    const spec = commands[cmd];
    if (!spec) return formatUsage(bin, commands, undefined, epilogue);
    const signature = [bin, cmd, spec.usage, flagNames(spec).length ? "[flags]" : undefined]
      .filter(Boolean)
      .join(" ");
    const lines = [`Usage: ${signature}`, `  ${spec.summary}`];
    const perFlag = flagLines(spec, "  ");
    if (perFlag.length) lines.push("", ...perFlag);
    if (spec.details?.length) lines.push("", ...spec.details.map((d) => `  ${d}`));
    return lines.join("\n") + "\n";
  }

  const names = Object.keys(commands);
  const label = (name: string) => [name, commands[name].usage].filter(Boolean).join(" ");
  const width = Math.max(...names.map((n) => label(n).length));
  const lines = [`Usage: ${bin} <${names.join("|")}>`, ""];
  for (const name of names) {
    lines.push(`  ${label(name).padEnd(width)}  ${commands[name].summary}`);
    lines.push(...flagLines(commands[name], `  ${" ".repeat(width)}  `));
  }
  lines.push(
    "",
    `Run \`${bin} <command> --help\` for one command. Unknown flags are an error, never ignored.`,
    // Named here rather than in each bin's table because `--version` is not a flag OF a command —
    // it is asked of the bin, before any command word. Leaving it out is the drift this generated
    // usage exists to prevent: all five bins answer it, and the help text has to say so.
    `Run \`${bin} --version\` (or -v) for the installed version.`,
  );
  if (epilogue?.length) lines.push("", ...epilogue);
  return lines.join("\n") + "\n";
}

/**
 * Usage for a bin that has no subcommands.
 *
 * Separate from `formatUsage` because that function's whole shape is a command LIST: its signature
 * line is `bin <a|b|c>` and every row is a command. A bin with one behaviour and a couple of flags
 * has no list to print, and rendering it through the same function yields `Usage: stockbit-mcp <>`.
 */
export function formatBareUsage(bin: string, spec: CommandSpec, epilogue?: readonly string[]): string {
  const signature = [bin, spec.usage, flagNames(spec).length ? "[flags]" : undefined].filter(Boolean).join(" ");
  const lines = [`Usage: ${signature}`, `  ${spec.summary}`];
  const perFlag = flagLines(spec, "  ");
  if (perFlag.length) lines.push("", ...perFlag);
  // A blank `details` entry stays blank rather than becoming two spaces — this block is the only
  // place a caller writes free-form paragraphs, and trailing whitespace in shipped help text is
  // the kind of thing that shows up in a diff forever.
  if (spec.details?.length) lines.push("", ...spec.details.map((d) => (d ? `  ${d}` : "")));
  lines.push("", "Unknown flags are an error, never ignored.");
  if (epilogue?.length) lines.push("", ...epilogue);
  return lines.join("\n") + "\n";
}
