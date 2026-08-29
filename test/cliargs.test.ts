/**
 * The strict CLI gate — the mechanics, on a synthetic command table.
 *
 * The failure this file guards against is the 2026-08-29 one: a token the parser does not know
 * being TREATED AS ABSENT rather than as an error, which is how `login --help` ran a real login.
 * Every rule here is therefore about what gets refused, and about help winning before anything can
 * run. The real bins' tables are exercised in authcli/livecli/alertscli.test.ts; this file proves
 * the engine, so those can focus on their specs and wiring.
 *
 * No store env preamble on purpose: `src/cliargs.ts` is import-free and side-effect-free — that is
 * one of its design guarantees — so these tests touching no env is the point, not an oversight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CliParseError,
  formatUsage,
  gateCommandLine,
  isHelpToken,
  type CommandTable,
} from "../src/cliargs.ts";

/** A tiny table with one of everything: boolean flag, value flag, positionals, variadic, bare. */
const T: CommandTable = {
  go: {
    summary: "does the thing",
    usage: "<target>",
    flags: { "--fast": "hurry" },
    valueFlags: { "--cash": { placeholder: "N", help: "how much" } },
    positionals: [{ name: "target", required: true }],
  },
  quiet: { summary: "takes nothing at all" },
  say: {
    summary: "takes a free-text tail",
    usage: "<who> [words]",
    positionals: [{ name: "who", required: true }],
    variadicTail: true,
  },
};

/** Run the gate, collecting anything it writes as help. */
function gate(cmd: string, argv: string[]): { result: string; help: string } {
  let help = "";
  const result = gateCommandLine("mybin", T, cmd, argv, (text) => (help += text));
  return { result, help };
}

/** Run a call that must refuse, and hand back the refusal so its fields can be inspected. */
function refusal(fn: () => unknown): CliParseError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CliParseError, `expected a CliParseError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a CliParseError, got a normal return");
}

test("isHelpToken is exactly --help and -h", () => {
  assert.ok(isHelpToken("--help"));
  assert.ok(isHelpToken("-h"));
  // "help" is a command WORD, handled by the bins before the gate; treating it as a flag here would
  // make `explain help` (a positional) print usage instead of erroring.
  assert.equal(isHelpToken("help"), false);
  assert.equal(isHelpToken("--h"), false);
});

test("help wins over everything, including a bad flag on the same line", () => {
  // A user asking for help must never be told off for a second typo — and must NEVER fall through
  // to the handler, which is the incident itself.
  for (const argv of [["--help"], ["-h"], ["--bogus", "--help"], ["stray", "-h", "--cash"]]) {
    const { result, help } = gate("go", argv);
    assert.equal(result, "help", `argv ${JSON.stringify(argv)}`);
    assert.match(help, /--fast/);
    assert.match(help, /--cash N/);
  }
});

test("an unknown flag is an error naming the token, every valid flag, and the help command", () => {
  const err = refusal(() => gate("go", ["--hepl"]));
  assert.equal(err.name, "CliParseError");
  assert.equal(err.command, "go");
  assert.equal(err.token, "--hepl");
  assert.match(err.message, /unknown flag "--hepl"/);
  assert.match(err.message, /go accepts: --fast, --cash/);
  assert.match(err.message, /`mybin go --help`/);
});

test("single-dash junk is a flag error, not a positional", () => {
  // `-fast` or `-h5` is always a mistyped flag; reading it as a positional would hand it to a
  // symbol parser and produce a worse message further away from the typo.
  assert.throws(() => gate("go", ["-fast"]), /unknown flag "-fast"/);
});

test("a command with no flags says so instead of listing an empty set", () => {
  assert.match(refusal(() => gate("quiet", ["--anything"])).message, /quiet accepts no flags/);
});

test("a value flag consumes the next token exactly the way the bins read it", () => {
  // Mirrors `flagValue` in bin/stockbit-auth.ts: the next token is the value iff it does not start
  // with `--`. So `--cash -5` IS consumed — the handler's own numeric check owns rejecting -5 —
  // while `--cash --fast` means the value is missing.
  assert.equal(gate("go", ["--cash", "-5", "x"]).result, "ok");
  assert.equal(gate("go", ["--cash", "100", "x"]).result, "ok");
  const atEnd = refusal(() => gate("go", ["x", "--cash"]));
  assert.match(atEnd.message, /--cash needs a value — write --cash N or --cash=N/);
  assert.match(refusal(() => gate("go", ["--cash", "--fast"])).message, /--cash needs a value/);
});

test("--flag=value is self-contained, and the empty value stays the handler's concern", () => {
  assert.equal(gate("go", ["--cash=100", "x"]).result, "ok");
  // `--cash=` reads as "" through flagValue; whether "" is a valid amount is a range question, and
  // range questions live with the handlers (they already answer them loudly).
  assert.equal(gate("go", ["--cash=", "x"]).result, "ok");
});

test("a boolean flag given a value is refused, not silently truncated", () => {
  assert.throws(() => gate("go", ["--fast=1"]), /--fast does not take a value/);
});

test("positionals past the declared slots are refused, naming the first extra one", () => {
  const none = refusal(() => gate("quiet", ["now"]));
  assert.equal(none.token, "now");
  assert.match(none.message, /unexpected argument "now"/);
  assert.match(none.message, /quiet accepts no positional arguments/);

  const extra = refusal(() => gate("go", ["a", "b"]));
  assert.equal(extra.token, "b");
  assert.match(extra.message, /takes at most 1 positional argument/);
});

test("a variadic tail accepts any number of positionals", () => {
  assert.equal(gate("say", ["bot", "many", "extra", "words"]).result, "ok");
});

test("an unknown command is the bin's answer to give, not the gate's", () => {
  const { result, help } = gate("wat", ["--whatever"]);
  assert.equal(result, "unknown-command");
  assert.equal(help, "", "no usage may be written for a command that does not exist");
});

test("usage is generated from the table, top level and per command", () => {
  const top = formatUsage("mybin", T, undefined, ["Extra note."]);
  for (const name of Object.keys(T)) assert.ok(top.includes(name), name);
  assert.match(top, /Unknown flags are an error, never ignored/);
  assert.match(top, /Extra note\./);

  const one = formatUsage("mybin", T, "go");
  assert.match(one, /Usage: mybin go <target> \[flags\]/);
  assert.match(one, /--cash N {2}how much/);
  assert.doesNotMatch(one, /takes a free-text tail/, "per-command help is that command's alone");

  // Asking for usage of a command that does not exist falls back to the full listing — the caller
  // is lost, and a blank page would keep them lost.
  assert.ok(formatUsage("mybin", T, "wat").includes("quiet"));
});
