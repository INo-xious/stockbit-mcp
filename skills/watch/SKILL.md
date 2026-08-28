---
name: watch
description: Watch live IDX turnover and order books for unusual activity — value surges, auto-reject approach, one-sided depth, walls appearing or withdrawn, quiet stocks waking up, UMA flags — plus delayed print-by-print attribution and end-of-day broker context. Use when the user runs /watch, or asks what is trading right now, who is moving, whether anyone is dumping, or where the money is going in the Indonesian market.
argument-hint: <stock|watchlist|all> [interval] [prompt]
---

# Watch live IDX turnover

`/watch <stocks|watchlist|all> <time-frame> <prompt>`

```
/watch BBCA,ANTM 30s is anyone dumping
/watch watchlist 1m what is moving
/watch watchlist:Bandar 30s any unusual size
/watch all 5m where is the money going
```

## What this actually does — read before answering

It takes **two readings of the market some seconds apart and reports the difference.** That is the whole mechanism. `Δvalue / Δfrequency` is the average rupiah size of the prints that landed in the window.

**It does not watch continuously.** One command, one window, one answer. Nothing runs afterwards, nothing will notify the user later. If they ask to be told when something happens, say plainly that this samples on demand and a background watcher does not exist yet.

**It does not judge whether anything was big.** No threshold is defined — see *The cutoff question* below, which is not optional.

## Step 1 — read the arguments

They arrive as `$ARGUMENTS` (individually as `$1`, `$2`, …). If nothing was substituted, take them from the user's message after `/watch`.

| position | meaning | accepted |
|---|---|---|
| 1 — **scope**, required | what to look at | `BBCA` · `BBCA,ANTM` · `watchlist` · `watchlist:Name` · `all` |
| 2 — **interval**, optional | how long a window to measure | `20s` · `30s` · `1m` · `5m` · `realtime` (also `menit` / `detik`) |
| 3+ — **prompt**, optional | the question, in the user's own words, either language | anything |

**Only the scope is required.** Fill in the rest rather than refusing — a public user typing `/watch BBCA` should get an answer, not a usage error:

- **No interval given → use `30s`.** Do *not* use the parser's own 5-minute default here: five minutes means the command blocks for five minutes. Only use a long window when the user actually asked for one.
- **No prompt given → report what traded**, ranked, and stop. No question to answer is not an error.
- **Nothing at all given → default to `all 30s`** and describe the most active names. Do not ask a clarifying question first; run it, then mention the fuller form.

Watch for the common slip: **the interval is positional, so a prompt with no interval shifts everything left.** `/watch BBCA is anyone dumping` must be read as scope `BBCA`, interval `30s`, prompt *"is anyone dumping"* — never as interval `is`. Only treat token 2 as the interval when it actually looks like one (a number with an optional unit, or a real-time word); otherwise it is the first word of the prompt.

## Step 2 — run the sampler

```bash
stockbit-live scan <scope> <interval> --top 10
```

**Set an explicit Bash timeout of the window plus 45 seconds.** The default is two minutes, so anything from `2m` up is killed mid-measurement with no output — which looks exactly like a failure of the market rather than of the timeout. A window over 8 minutes is refused by the CLI itself.

Add `--top N` to change how many rows come back (default 10). For `all`, more than ~15 rows is noise. Add `--pretty` only when a human will read the raw JSON.

### If `stockbit-live` is not on PATH

Fall down this ladder — do not hardcode an install path, because the registered build gets repointed and a stale path in a markdown file is a silent misdiagnosis waiting to happen:

1. **Installed from npm, not globally linked:**
   ```bash
   npx -y -p stockbit-mcp stockbit-live scan <scope> <interval> --top 10
   ```
2. **Running a local clone** (the usual case when this server is registered as an MCP pointing at a dev build). Resolve the directory from the registration itself — `mcpServers.stockbit.args[0]` in `~/.claude.json` is the one source of truth for which build is actually loaded — then:
   ```bash
   node dist/bin/stockbit-live.js scan <scope> <interval> --top 10
   ```
   On a machine that already has the helper, `node "$HOME/.claude/helpers/stockbit-resolve.js" --path` prints that directory.
3. If `dist/bin/stockbit-live.js` is missing from a clone, the source has not been compiled since it changed — `npm run build` there once.


## The other commands

`scan` measures turnover and ranks it. These do more.

### `signals` — run the detectors

```bash
stockbit-live signals <scope> <interval> [prompt] --pretty
```

Takes two readings, runs every detector the prompt enabled, and puts the results through the alert
engine (max 5 per interval, 25 per session, cooldowns, dedup). Reads order books only for symbols
that actually traded, capped at 12 per pass — one request each.

Output carries `alerts` (what to show), `suppressed` (with the reason), `marketWide` (set when one
signal tripped across most of the universe — show that line INSTEAD of the rows), and
`prompt.downgrades` (requests that cannot be served as asked). **Always show the downgrades.**

### `explain <SYMBOL>` — what actually printed

```bash
stockbit-live explain BRMS [HH:MM:SS] [HH:MM:SS]
```

Names the individual trades: time, price, lots, value, which side crossed the spread, and the broker
on each side. **Always `lagged: true`** — the tape runs 8-10 minutes behind, so this explains
something that already happened. Check `brokersVisible`: IDX closes broker codes during live
trading, so identity may be withheld while the market is open.

### `brokers <SYMBOL>` — who was on each side

```bash
stockbit-live brokers BRMS
```

End-of-day broker flow. **Never an alert, always context.** The useful column is `lotsPerTrade`
(|netLots| / freq): a broker buying in many small pieces is retail-shaped flow; one buying the same
lots in a few large trades is institution-shaped. Those boundaries are ours — IDX publishes none —
and the output says so. If `degraded` is true, read `degradedReason` and do not interpret the labels.

## Step 3 — read the output

JSON on stdout. `ok: false` always carries `reason` and `detail`; the process also exits non-zero, so neither a silent stdout nor a zero exit can be mistaken for a calm market.

| field | meaning |
|---|---|
| `deltas[]` | what traded, ranked by rupiah. `value` = rupiah in the window, `trades` = number of prints, `averageTradeValue` = rupiah per print, `seconds` = the **real** window length |
| `confidence` | `single` — one print, so the average **is** that trade · `few` — 2–5 · `averaged` — more than 5, says nothing about any individual print |
| `quiet[]` | in scope, present in both readings, **traded nothing**. A real observation. |
| `unobserved[]` | in scope but **absent from at least one reading**, so there is no baseline. This is a gap in our data, **not** a quiet stock — never report it as one. |
| `truncated` | rows that crossed the `--top` cap. Mention the count if it is large. |
| `symbolsSeen` | how many symbols the reading covered, always ~100 |

Read `seconds`, not the requested interval. If a poll was slow the real window is longer, and describing a 40-second window as 30 seconds misstates every rate derived from it.

### Failure reasons

| `reason` | What to say |
|---|---|
| `auth` | The Stockbit session is dead. Run `/stockbit-status`, then `/stockbit-auth`. Do not describe this as a market problem. |
| `market-closed` | IDX is shut — give the WIB time and phase from `detail`. Offer `--always`, and say the readings will be identical. |
| `session-reset` | The counters restarted mid-window. Just run it again. |
| `window-too-long` | Over 8 minutes cannot be measured in one call. Offer a shorter window. |
| `bad-arguments` | Quote `detail` — it names the offending token. Usually the prompt bled into the scope slot. |
| `rate_limited` / `upstream` | Stockbit's side. Say so and offer to retry. |

## Step 4 — answer the prompt

Answer the user's actual question against the numbers. Give rupiah in a readable form (`Rp 2.5 bn`, `Rp 39.7 M`), name the window length, and say how many prints each figure covers.

**The cutoff question — this is the part to get right.**

If the prompt asks a yes/no about size — *"is anyone dumping"*, *"was that big"*, *"ada transaksi besar?"* — you do not have a defined answer. No threshold exists yet: it is an open decision waiting on measurement, and IDX mean print size varies roughly tenfold across the price range, so there is no safe constant to reach for.

So: **report what the window measured and, if you offer a judgement at all, state the cutoff you used in rupiah.** Never imply a settled rule exists. An unstated cutoff invented fresh each time is worse than a documented bad one — it cannot be reviewed, and it silently contaminates the very runs meant to decide what the real threshold should be.

`confidence` carries most of the honesty here. `averaged` over 300 prints says something about flow; it says nothing about any single trade. Do not turn it into "a large transaction went through".

## What this cannot see

- **Individual prints in liquid names.** The running-trade tape runs 8–10 minutes behind, so real-time detection is flow-level only. A single print is visible only when it dominates a short window in a thin name.
- **Broker identity.** IDX closed broker codes in live running trade on 6 December 2021. Bandarmology is end-of-day — for that, use `mcp__stockbit__broker_summary`, and say it is T+1.
- **Anything outside the ~100 most active symbols.** One request covers those. A stock with no turnover cannot print a large transaction, so the omission is mostly harmless — but say "the 100 most active", never "the whole market".

## Never

- Place, cancel or modify an order. This reads one public market endpoint; the trading tools are not part of this skill.
- Report a failure as a quiet market.
- Present `unobserved` symbols as having traded nothing.
- State a big-transaction threshold as though it were established.
