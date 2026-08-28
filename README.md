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
cp .env.example .env      # add your ANTHROPIC_API_KEY
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

## Status

The forecasting logic, screening, sizing, scoring, and persistence are
implemented and unit-tested offline. Of the two surfaces that needed live
verification, one is now verified and one is still blocked.

**The Claude request shape is verified.** Checked against the installed SDK's
own parameter types (`@anthropic-ai/sdk` 0.122.0) and the current API
reference, all of it correct as written:

- `web_search_20260209` with `name: "web_search"` — the dynamic-filtering
  variant, which is the one Opus 5 takes. (`web_search_20250305` is for
  pre-4.6 models.)
- `output_config` carrying `effort` and a structured-output `format` together
  on one object, alongside `thinking: {type: "adaptive"}`. Both keys are
  independent optional fields on `OutputConfig`; the combination is legal.
- `messages.parse()` + `parsed_output`, and the `zodOutputFormat` helper at
  `@anthropic-ai/sdk/helpers/zod`.
- No `budget_tokens` (removed on Opus 5 — a 400) and no assistant prefill
  (also removed).
- Per-million pricing in `forecast.ts` matches current published rates, as
  does `$0.01` per web search.

`test/request-shape.test.ts` pins all of this. The pinning is in the type
annotations rather than the assertions: each request object is declared as
`Anthropic.MessageCreateParamsNonStreaming`, so `npm run typecheck` fails if a
tool version string or the `output_config` layout drifts from what the SDK
accepts. That catches a request the API would reject without spending a token
or needing a credential.

**Gamma and CLOB response shapes are still unverified.** They need a live
capture, and the environments this has been built in have had no egress to
`gamma-api.polymarket.com` or `clob.polymarket.com` — the proxy returns
`403 Host not in allowlist`. The clients are written to accept both the
JSON-string and native-array encodings Gamma has used for `outcomes`,
`outcomePrices`, and `clobTokenIds`, and both string and numeric forms of the
numeric fields, but "written to accept" is not "seen working".

To close it, from a host that can reach Polymarket:

```bash
npm run doctor    # reports which fields it found; dumps the raw payload on failure
npm run capture   # writes the live payloads to test/fixtures/, verbatim
npm test          # the fixture tests stop skipping and start asserting
```

`npm run capture` picks a market representative of what a scan actually
forecasts — binary, with published criteria and both CLOB token ids — and
writes it unmodified along with its order book and a provenance record. Until
those fixtures exist, the four tests in `test/fixtures.test.ts` skip with a
message saying so rather than passing vacuously. A green suite that proves
nothing is worse than a visible skip.

## What a scan costs

Each forecast is one Opus 5 call (`POLY_RESEARCH=false`) or two
(`POLY_RESEARCH=true`, the default: a web-search research stage, then the
blind structured forecast). The research stage dominates, because search
results land in the context window and are billed as input tokens on every
continuation of the server-side tool loop.

This has not yet been measured against the live API. `npm run report` prints
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
