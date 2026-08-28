import { loadConfig } from "../config.ts";
import { fetchMarketById } from "../polymarket/gamma.ts";
import { openDb } from "../store/db.ts";
import {
  openPositionsForMarket,
  recordResolution,
  settlePosition,
  unresolvedForecastMarkets,
} from "../store/repo.ts";
import type { Market } from "../types.ts";

/**
 * Read resolutions off Gamma and settle the paper book.
 *
 * Runs over every market we forecast, not just the ones we traded - the edge
 * test needs outcomes for the forecasts we passed on too.
 */
export async function resolve(): Promise<number> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);

  try {
    const pending = unresolvedForecastMarkets(db);
    if (pending.length === 0) {
      console.log("\n  Nothing pending resolution.\n");
      return 0;
    }

    console.log(`\n  Checking ${pending.length} market(s) for resolution...\n`);
    let resolved = 0;
    let settled = 0;
    let pnl = 0;

    for (const row of pending) {
      let market: Market | null;
      try {
        market = await fetchMarketById(cfg.gammaBase, row.market_id);
      } catch (err) {
        console.log(`  ERROR ${row.market_id}: ${String(err)}`);
        continue;
      }

      if (!market) continue;
      const outcome = readOutcome(market);
      if (outcome === null) continue;

      recordResolution(db, market.id, outcome, "gamma");
      resolved += 1;

      for (const position of openPositionsForMarket(db, market.id)) {
        const result = settlePosition(db, position, outcome);
        settled += 1;
        pnl += result;
        console.log(
          `  ${result >= 0 ? "WIN " : "LOSS"}  ${result >= 0 ? "+" : ""}$${result.toFixed(2).padStart(7)}  ` +
            `${position.side} @ ${position.entry_price.toFixed(3)}  ${truncate(position.question, 50)}`,
        );
      }
    }

    console.log(
      `\n  ${resolved} market(s) resolved, ${settled} position(s) settled, ` +
        `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} realized.\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * A resolved Polymarket market reports its outcome prices at the extremes:
 * the winning outcome at 1 and the loser at 0. We require `closed` plus an
 * unambiguous price so that a market merely trading near certainty is never
 * mistaken for one that has actually settled.
 */
export function readOutcome(market: Market): number | null {
  if (!market.closed) return null;

  const yesIndex = market.outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
  if (yesIndex === -1) return null;

  const yesPrice = market.outcomePrices[yesIndex];
  if (yesPrice === undefined || !Number.isFinite(yesPrice)) return null;

  if (yesPrice >= 0.99) return 1;
  if (yesPrice <= 0.01) return 0;
  return null; // closed but not cleanly settled - check again next run
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 3)}...` : text;
}
