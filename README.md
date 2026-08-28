# poly

A paper-trading research engine that answers one question:

**Does Claude forecast Polymarket events better than the market prices them?**

Not "did we make money on twenty bets" — that number is noise. The question is
whether the model's probability estimates are systematically closer to the truth
than the prices were at the moment it forecast. If they are, there is an edge
worth funding. If they aren't, no amount of position sizing will manufacture
one, and you will have found that out for the price of some API calls instead of
your bankroll.

Nothing here can move money. There are no wallet keys, no exchange credentials,
and no order-placement code. The only secret it needs is an Anthropic API key.

## The honest case for and against

**Where an edge could plausibly exist:**

- **Resolution criteria misreads.** Markets routinely trade on the headline
  question while the fine print resolves differently — a specific source, a
  specific cutoff, an exclusion that colloquial reading misses. Careful reading
  is something a language model is genuinely good at, and the crowd is
  genuinely sloppy about.
- **The long tail.** Polymarket lists thousands of markets. The headline ones
  are efficiently priced by people who do this full time. The obscure ones
  attract far less attention per dollar.
- **Base-rate discipline.** Retail prediction-market pricing over-weights
  vivid recent narratives and under-weights how often the boring outcome wins.

**Where it probably doesn't:**

- **Headline markets.** Deep, liquid, and picked over. Do not expect to beat
  the crowd on the questions everyone is already watching.
- **Fast news.** A model has a training cutoff; the market reprices on this
  morning's headlines. The research stage narrows this gap but does not close
  it, which is why the forecaster is asked to flag stale knowledge explicitly.
- **The prior.** Prediction markets are decent aggregators. The base rate for
  "clever system beats the market" is low. Treat a positive result with
  suspicion until the sample is large.

The system is built so that these are measured claims rather than opinions.

## How it works

```
Gamma  ──►  screen  ──►  order book  ──►  Claude  ──►  edge & Kelly  ──►  paper position
             │                              │
             │                              ├─ stage 1: research with web search
             │                              └─ stage 2: blind structured forecast
             │
             └─ liquidity band, time to resolution, spread, price range
```

Three design decisions do most of the work:

**Claude never sees the market price.** Not in the research stage, not in the
forecast stage. A model shown a price anchors to it and returns something near
it; you would then be measuring a noisy copy of the market and calling the
correlation edge. Blind forecasting is what makes the calibration numbers mean
anything.

**Abstention is a first-class answer.** The forecaster can say the criteria are
too ambiguous to judge, or that the outcome turns on information it doesn't
have. Abstentions cost nothing and are excluded from scoring. A confident guess
on an unjudgeable question costs money.

**Every forecast is scored, not just the traded ones.** Scoring only the
positions you opened selects for cases where Claude disagreed with the market —
exactly the bias that makes a bad strategy look good.

## Quickstart

```bash
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY - it is read automatically
npm run doctor            # verify config, credentials, Gamma, and the CLOB
npm run capture           # pin the live API shapes into test/fixtures/
npm run scan -- --dry-run # see what would be forecast, spend nothing
npm run scan              # forecast and open paper positions
npm run resolve           # settle positions as markets resolve
npm run report            # the answer
```

Run `scan` on a schedule (daily is plenty) and `resolve` alongside it. The
report becomes meaningful somewhere north of 100 resolved forecasts.

## The one number that matters

`npm run report` leads with a comparison of Brier scores — Claude's against the
market's, over the same questions at the same moments:

```
  Resolved forecasts   142
  Brier - Claude       0.1832
  Brier - market       0.1975   (lower is better)
  Skill score          7.2%     (positive = Claude ahead)
  Paired t-statistic   2.41     (|t| > 2 is meaningful)
```

A positive skill score with |t| > 2 is the result that would justify risking
money. A positive skill score with a small t-statistic means keep going. A
negative one means don't fund this — and that is a genuinely valuable answer,
arrived at cheaply.

The calibration table below it shows where any miscalibration lives: if Claude's
0.7 bucket resolves YES 55% of the time, it is overconfident, and the shrinkage
settings are where you correct for it.

Win rate and P&L are also reported. Treat them as entertainment until the Brier
comparison says something.

## Configuration

Everything is environment variables; see `.env.example`. The settings worth
understanding:

| Setting | Why it matters |
|---|---|
| `POLY_MAX_FORECASTS` | Hard spend cap per run. Each forecast is one or two Opus calls. |
| `POLY_MIN_EDGE` | How large a disagreement must be before it's worth a position. |
| `POLY_KELLY_FRACTION` | Quarter Kelly by default. Full Kelly on an *estimated* probability is ruin. |
| `POLY_SHRINK_*` | How much of Claude's disagreement to act on. Start conservative; let the calibration curve tell you. |
| `POLY_MAX_LIQUIDITY` | The ceiling is deliberate — the deepest markets are the worst place to look. |

## Sizing

Positions are sized by fractional Kelly against the shrunk probability, then
capped by both a percentage of bankroll and an absolute dollar limit. Sizing is
depth-aware: it prices against the touch, sizes, then re-prices by walking the
book for that many contracts and re-sizes. Top-of-book pricing overstates edge
on thin markets — which are exactly the markets where an edge is most plausible,
so the error would land where it hurts most.

Because the strategy holds to resolution, the spread is paid once on entry
rather than twice. That is modeled; so are configurable fees and a slippage
allowance.

## What is deliberately missing

There is no live trading. Not disabled behind a flag — absent. Adding it is a
deliberate, separate piece of work that should happen only after the report says
there is something worth trading, and it needs its own review: order types,
partial fills, position limits, a kill switch, and key handling that this
repository is currently free of.

## Project layout

```
src/
  config.ts            all tunables, env-driven and validated at startup
  polymarket/          Gamma (markets) and CLOB (order books) clients
  analyst/             the prompts, the output schema, the two-stage forecaster
  engine/screen.ts     which markets are worth spending a forecast on
  engine/edge.ts       shrinkage, Kelly sizing, depth-aware entry pricing
  engine/calibration.ts Brier scores, calibration bins, the edge test
  store/               SQLite schema and queries (Node's built-in sqlite)
  cli/                 doctor, capture, scan, resolve, report
test/                  45 tests, concentrated on the money math and parsing
  fixtures/            live Gamma/CLOB payloads, written by `npm run capture`
```

`npm test` runs the suite; `npm run typecheck` runs `tsc --noEmit`.

Requires Node 22.9 or newer: the CLI loads `.env` via `--env-file-if-exists`,
and the store uses Node's built-in SQLite.

## Status

Everything except the cost measurement has now been exercised against the live
APIs. Both surfaces that were previously unverified are verified.

**Gamma and CLOB response shapes: verified.** `npm run doctor` passes against
live endpoints, and `test/fixtures/` holds a real market and a real order book
captured verbatim by `npm run capture`. The client's assumptions all held:

- `outcomes`, `outcomePrices`, and `clobTokenIds` arrive as JSON-encoded
  strings (`"[\"Yes\", \"No\"]"`), which `parseListField` decodes.
- `liquidity` and `volume` are strings; `liquidityNum` and `volumeNum` are
  floats. The client prefers the `*Num` variants, so it gets numbers.
- `umaResolutionStatus` is absent from the markets list payload. Harmless —
  resolution settles on `closed` plus cleared `outcomePrices`, not on it.

`test/fixtures.test.ts` pins all of this against the captured payloads. Fixtures
go stale; when Gamma changes shape, re-run `npm run capture` and the diff shows
exactly what moved.

**The Claude request shape: verified** against the installed SDK's parameter
types (`@anthropic-ai/sdk` 0.122.0) and the current API reference. Correct as
written — `web_search_20260209`, `output_config` carrying `effort` and a
structured-output `format` together alongside `thinking: {type: "adaptive"}`,
`messages.parse()` / `parsed_output`, no `budget_tokens` (a 400 on Opus 5), and
pricing that matches published rates. `test/request-shape.test.ts` pins it in
type annotations, so `npm run typecheck` fails on drift without spending a
token.

**Not yet measured: what a forecast actually costs.** That needs a funded
`ANTHROPIC_API_KEY`. Run `npm run scan -- --limit 1` and read the cost off
`npm run report` before running a full scan.

## What the screen actually does

On a live run of 500 markets, 73 passed:

```
    113  not a binary Yes/No market
    113  resolves beyond 120d
     97  priced at the extremes
     90  resolves in under 2d
      6  below liquidity floor
      5  no usable resolution date
      3  spread too wide
```

Two things this exposes, both worth fixing before spending real money on
forecasts:

**The scan fetches the wrong end of the market.** `fetchOpenMarkets` pages
Gamma with `order=volume24hr&ascending=false` — the most heavily traded markets
first. Those are precisely the ones this project argues are the worst place to
look, and the liquidity ceiling never fires as a result: nothing in the top 500
by volume was rejected for being too liquid. Reaching the long tail means
sorting differently or paging much deeper.

**The ranker steers spend toward markets with no plausible edge.** `rankForScan`
prefers soon-resolving, mid-priced markets, and on a live run that selected nine
short-dated crypto touch markets out of fifteen — "Will Bitcoin reach $82,500 in
August", four days out. A four-day price-touch question is close to a random
walk; careful reading of resolution criteria buys nothing there. The
soon-resolving preference is defensible while you want fast feedback, but it
needs a counterweight, or most of the budget goes to questions where the market
is right by construction.

## What a scan costs

Each forecast is one Opus 5 call (`POLY_RESEARCH=false`) or two
(`POLY_RESEARCH=true`, the default: a web-search research stage, then the
blind structured forecast). The research stage dominates, because search
results land in the context window and are billed as input tokens on every
continuation of the server-side tool loop.

This has not yet been measured against the live API - it needs a funded key. `npm run report` prints
actual spend from `response.usage` once you have run a scan; measure with
`npm run scan -- --limit 1` before running a full one.

The levers, in the order worth reaching for:

| Lever | Effect |
|---|---|
| `POLY_MAX_FORECASTS` | Linear, and the only hard cap. This is the spend limit. |
| Scan cadence | Linear. Every other day halves the bill. |
| `POLY_RESEARCH_MAX_SEARCHES` | Cuts the dominant term — both the per-search fee and the search results billed as input tokens. |
| `POLY_EFFORT` | `medium` materially cuts thinking tokens, which are billed as output. |
| `POLY_RESEARCH=false` | Roughly halves cost, and materially hurts accuracy on anything news-driven. The last resort, not the first. |

Screening is the other half of cost control: every market that reaches Claude
should be one you would actually trade if the number came back right.
