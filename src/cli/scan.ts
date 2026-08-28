import Anthropic from "@anthropic-ai/sdk";

import { loadConfig } from "../config.ts";
import { mapLimit } from "../polymarket/http.ts";
import { fetchOpenMarkets } from "../polymarket/gamma.ts";
import { fetchBook, quoteFromBook } from "../polymarket/clob.ts";
import { rankForScan, screenMarkets, daysUntil } from "../engine/screen.ts";
import { assessEdge } from "../engine/edge.ts";
import { runForecast, RefusalError } from "../analyst/forecast.ts";
import { openDb } from "../store/db.ts";
import {
  finishRun,
  insertForecast,
  insertPosition,
  openPositions,
  portfolioSummary,
  recentlyForecastIds,
  startRun,
} from "../store/repo.ts";
import type { BinaryMarket } from "../types.ts";

export async function scan(argv: string[]): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const limitFlag = flagValue(argv, "--limit");

  const cfg = loadConfig();
  if (limitFlag !== null) cfg.scan.maxForecasts = Number(limitFlag);

  const now = new Date();
  const db = openDb(cfg.dbPath);

  try {
    console.log(`\n  Fetching up to ${cfg.scan.maxMarkets} open markets from Gamma...`);
    const markets = await fetchOpenMarkets({ base: cfg.gammaBase, limit: cfg.scan.maxMarkets });
    console.log(`  Got ${markets.length}.`);

    const skip = recentlyForecastIds(db, cfg.scan.refreshDays);
    const screened = screenMarkets(markets, cfg, now, skip);
    const ranked = rankForScan(screened.passed, now).slice(0, cfg.scan.maxForecasts);

    console.log(`\n  Screen: ${screened.passed.length} of ${markets.length} passed.`);
    for (const [reason, count] of [...screened.rejections].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(5)}  ${reason}`);
    }

    if (ranked.length === 0) {
      console.log("\n  Nothing to forecast. Loosen the screen in .env or wait for new markets.\n");
      return 0;
    }

    console.log(`\n  Forecasting ${ranked.length} market(s):`);
    for (const m of ranked) {
      const days = daysUntil(m.endDate, now) ?? 0;
      console.log(`    - [${days.toFixed(0)}d] ${truncate(m.question, 76)}`);
    }

    if (dryRun) {
      console.log(`\n  --dry-run: stopping before any Claude calls. No cost incurred.\n`);
      return 0;
    }

    // Bankroll available right now = starting stake, plus what we have realized,
    // minus what is already tied up in open paper positions.
    const summary = portfolioSummary(db);
    const committed = openPositions(db).reduce((sum, p) => sum + p.stake_usd, 0);
    const bankroll = cfg.trade.bankroll + summary.realizedPnl;
    let available = bankroll - committed;

    const runId = startRun(db);
    const client = new Anthropic();
    let forecastCount = 0;
    let positionCount = 0;
    let costUsd = 0;

    console.log("");
    const results = await mapLimit(ranked, cfg.scan.concurrency, async (market) => {
      try {
        return await evaluate(client, cfg, market, now, bankroll);
      } catch (err) {
        if (err instanceof RefusalError) {
          console.log(`  SKIP  ${truncate(market.question, 60)} - ${err.message}`);
        } else {
          console.log(`  ERROR ${truncate(market.question, 60)} - ${String(err)}`);
        }
        return null;
      }
    });

    for (const result of results) {
      if (!result) continue;
      const { market, run, assessment } = result;

      forecastCount += 1;
      costUsd += run.cost.usd;

      const forecastId = insertForecast(db, runId, market, run, assessment, cfg.model);

      // Re-check affordability serially: mapLimit runs concurrently, so two
      // markets could each have looked affordable against the same dollars.
      const affordable = assessment.tradeable && assessment.stakeUsd <= available;
      if (assessment.tradeable && !affordable) {
        console.log(`  HOLD  ${truncate(market.question, 56)} - insufficient free bankroll`);
      }

      if (affordable) {
        insertPosition(db, forecastId, market, assessment);
        available -= assessment.stakeUsd;
        positionCount += 1;
        console.log(
          `  OPEN  ${assessment.side.padEnd(3)} $${assessment.stakeUsd.toFixed(2).padStart(7)} ` +
            `@ ${assessment.entryPrice.toFixed(3)} ` +
            `(claude ${assessment.rawProbability.toFixed(2)} / market ` +
            `${assessment.marketProbability.toFixed(2)} / edge ` +
            `${(assessment.edge * 100).toFixed(1)}pp)  ${truncate(market.question, 50)}`,
        );
      } else if (!assessment.tradeable) {
        console.log(
          `  PASS  ${truncate(market.question, 56)}\n        ${assessment.reason}`,
        );
      }
    }

    finishRun(db, runId, {
      marketsFetched: markets.length,
      marketsPassed: screened.passed.length,
      forecasts: forecastCount,
      positions: positionCount,
      costUsd,
    });

    console.log(
      `\n  ${forecastCount} forecast(s), ${positionCount} position(s) opened, ` +
        `$${costUsd.toFixed(2)} spent on Claude.\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

interface Evaluation {
  market: BinaryMarket;
  run: Awaited<ReturnType<typeof runForecast>>;
  assessment: ReturnType<typeof assessEdge>;
}

/**
 * Book first, then Claude. A market whose book we cannot price is one we could
 * never trade, and finding that out after paying for a forecast is pure waste.
 */
async function evaluate(
  client: Anthropic,
  cfg: ReturnType<typeof loadConfig>,
  market: BinaryMarket,
  now: Date,
  bankroll: number,
): Promise<Evaluation | null> {
  const book = await fetchBook(cfg.clobBase, market.yesTokenId);
  const quote = quoteFromBook(book);
  if (!quote) return null;
  if (quote.spread > cfg.scan.maxSpread) return null;

  const run = await runForecast(client, cfg, market, now);
  const assessment = assessEdge({ market, book, quote, forecast: run.forecast, cfg, bankroll });
  return { market, run, assessment };
}

function flagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 3)}...` : text;
}
