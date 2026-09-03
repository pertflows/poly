# poly — working notes

Paper-trading engine measuring whether Claude forecasts Polymarket events
better than the market prices them. **Paper only.** No order placement, no
wallet keys, no live-trading path. Do not add one.

## Run it

```bash
npm run doctor      # five checks; gates everything else
npm run scan        # screen -> forecast -> open paper positions
npm run resolve     # settle positions whose markets resolved
npm run dashboard   # writes dashboard.html and web/index.html
npm run report      # the Brier comparison - the number that matters
npm run capture     # refresh test/fixtures from live APIs
```

Node >= 22.9 (`--env-file-if-exists`, built-in SQLite). `npm test` and
`npm run typecheck` must both be green before any commit.

## Environment gotchas

- **`NODE_USE_ENV_PROXY=1` is required in Claude Code cloud sessions.** Node 22's
  `fetch` ignores `HTTPS_PROXY` without it and every Polymarket call returns
  403 "Host not in allowlist". Not needed on GitHub Actions or locally.
- **`ANTHROPIC_API_KEY` cannot live in the Claude cloud environment panel.** It
  is a reserved name and is stripped; sessions authenticate via the account.
  That panel is also plaintext-visible. The key lives in a GitHub Actions
  encrypted secret. This cost two days of silently-failing nightly runs.
- `.env` is gitignored and only exists locally. `.env.example` is committed —
  never put a real key in it.

## Automation

`.github/workflows/nightly-scan.yml`, 07:00 UTC daily. Actions, not a Claude
Routine: a scheduled session can't authenticate the bot's API calls (above),
and a failed session still records as SUCCEEDED, which hid the failure.

**Scheduled workflows only fire from the default branch.** The default branch
is `claude/polymarket-paper-trading-setup-88a5tx`, not `main`. Vercel's
production branch is set to the same and serves `web/` as a static site.

## Decisions that look wrong but aren't

- **Shrink factors are all 1.0.** The original defaults (`low 0.2`,
  `stale 0.3`) multiplied to 0.06, and every forecast comes back
  `confidence=low` + `stale_knowledge=true`. Clearing a 7pp edge threshold at
  0.06 shrinkage needs a 117-point disagreement — arithmetically impossible.
  Twelve forecasts opened zero positions while Claude disagreed with the
  market by up to 27.5pp. Do not restore the old values without also lowering
  `POLY_MIN_EDGE`; check they are mutually satisfiable.
- **`data/poly.db` is committed.** The ledger has to survive ephemeral
  containers. It is a binary, so git cannot merge it — the workflow uses a
  concurrency group so two runs never write it at once. Known wart: opening
  the DB dirties the file even when nothing changed.
- **`web/index.html` is generated, and committed.** Vercel serves it directly;
  there is no build step. `vercel.json` pins `framework: null` because a root
  `package.json` otherwise makes Vercel infer Next.js and fail.
- **The dashboard polls Polymarket client-side.** Both APIs send
  `access-control-allow-origin: *`, so no backend is needed. On the Artifact
  viewer that fetch is CSP-blocked; the page falls back to baked-in values and
  says "snapshot".

## Measured costs

Per forecast, one market, live API:

| Config | Cost | Wall clock |
|---|---|---|
| research on, `effort=high` | $0.65 | 2m52s |
| research on, `effort=medium` (current) | $0.38 | 1m41s |
| research off, `effort=high` | $0.05 | 27s |

Research is **92%** of the cost. `POLY_RESEARCH_MAX_SEARCHES` is inert —
halving it changed nothing and ran slower; the model never reaches the cap.
`POLY_EFFORT` is the lever that works. Sonnet 5 for research ran 13m per
forecast and was never costed; left on Opus.

Defaults: 8 forecasts/day at medium effort ≈ $91/month.

## Open problems

- **Market selection.** `fetchOpenMarkets` pages Gamma by descending 24h
  volume, i.e. the most efficiently priced end of the market — the liquidity
  ceiling never fires. `rankForScan` then prefers soon-resolving mid-priced
  markets, which selects short-dated crypto price-touch questions. Nine of
  fifteen in one live run. Those are near random walks; reading resolution
  criteria carefully buys nothing there, and it is the bot's only claimed edge.
- **Unit economics.** Forecasting costs the same at $5 or $5,000 a position. At
  a $100 bankroll, model spend eats the entire edge — $12.07 real spent
  against $12.95 paper earned. Only sensible at a bankroll in the low
  thousands.
- **Confidence and staleness saturate.** Every forecast returns
  `confidence=low` + `stale_knowledge=true`, so the shrinkage signal carries no
  information. Likely a prompt problem.
- **No arbitrage.** Event-level sums looked like 9.8% edges but the outcome
  sets are not exhaustive — the Republican Nominee 2028 event has no
  "Another Republican" leg, so `sum(asks) = 0.90` is correct pricing, not
  mispricing. Only `sum > 1` cases are robust, and those need NO-side spread
  math across thin legs.

## Reading the result

`npm run report` leads with Brier scores, Claude's against the market's.
Positive skill score with |t| > 2 is the only result that would justify real
money. Win rate and P&L are noise until then — 3W/1L on four settled trades
says nothing, and three of those wins were in the crypto markets the selection
problem is about.
