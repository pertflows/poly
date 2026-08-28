import type { Config } from "../config.ts";
import type { BinaryMarket, Market } from "../types.ts";
import { asBinaryMarket } from "../polymarket/gamma.ts";

export interface ScreenOutcome {
  passed: BinaryMarket[];
  /** Rejection reason counts, so you can see which filter is doing the work. */
  rejections: Map<string, number>;
}

/**
 * Screening is cost control before it is strategy. Gamma will happily hand back
 * tens of thousands of open markets; forecasting all of them at Opus rates
 * would cost more than any plausible edge returns. Every market that reaches
 * Claude should be one you would actually trade if the number came back right.
 *
 * The liquidity band is the one filter worth explaining. The floor is there
 * because you cannot fill against an empty book. The ceiling is there because
 * the deepest markets - the headline political ones - are picked over by people
 * with better information and faster execution than you have, and that is the
 * least likely place for a language model to find a mispricing.
 */
export function screenMarkets(
  markets: readonly Market[],
  cfg: Config,
  now: Date,
  skipMarketIds: ReadonlySet<string>,
): ScreenOutcome {
  const passed: BinaryMarket[] = [];
  const rejections = new Map<string, number>();

  const reject = (reason: string): void => {
    rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  };

  for (const market of markets) {
    if (market.closed || !market.active) {
      reject("closed or inactive");
      continue;
    }
    if (!market.acceptingOrders) {
      reject("not accepting orders");
      continue;
    }
    if (skipMarketIds.has(market.id)) {
      reject("forecast recently");
      continue;
    }

    const binary = asBinaryMarket(market);
    if (!binary) {
      reject("not a binary Yes/No market");
      continue;
    }

    const days = daysUntil(binary.endDate, now);
    if (days === null) {
      reject("no usable resolution date");
      continue;
    }
    if (days < cfg.scan.minDaysToResolve) {
      reject(`resolves in under ${cfg.scan.minDaysToResolve}d`);
      continue;
    }
    if (days > cfg.scan.maxDaysToResolve) {
      reject(`resolves beyond ${cfg.scan.maxDaysToResolve}d`);
      continue;
    }

    if (binary.liquidity < cfg.scan.minLiquidity) {
      reject("below liquidity floor");
      continue;
    }
    if (binary.liquidity > cfg.scan.maxLiquidity) {
      reject("above liquidity ceiling");
      continue;
    }
    if (binary.volume < cfg.scan.minVolume) {
      reject("below volume floor");
      continue;
    }

    if (binary.yesPrice < cfg.scan.minPrice || binary.yesPrice > cfg.scan.maxPrice) {
      reject("priced at the extremes");
      continue;
    }

    // Gamma's `spread` is advisory; the CLOB book is authoritative and gets
    // checked again at sizing time. This is just a cheap pre-filter.
    if (binary.spread !== null && binary.spread > cfg.scan.maxSpread) {
      reject("spread too wide");
      continue;
    }

    if (!binary.description.trim()) {
      // Without published criteria there is nothing to read literally, and
      // criteria-reading is most of where the edge is supposed to come from.
      reject("no published resolution criteria");
      continue;
    }

    passed.push(binary);
  }

  return { passed, rejections };
}

export function daysUntil(endDate: string | null, now: Date): number | null {
  if (!endDate) return null;
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  return (end.getTime() - now.getTime()) / 86_400_000;
}

/**
 * Rank the survivors so a capped scan spends its forecasts well. We prefer
 * markets that resolve sooner (feedback arrives faster, which is the whole
 * point while you are still measuring) and that sit nearer the middle of the
 * price range (where a probability error translates into the most edge).
 */
export function rankForScan(markets: readonly BinaryMarket[], now: Date): BinaryMarket[] {
  return [...markets].sort((a, b) => score(b, now) - score(a, now));
}

function score(market: BinaryMarket, now: Date): number {
  const days = daysUntil(market.endDate, now) ?? 365;
  const timeScore = 1 / Math.log2(days + 2);
  const centrality = 1 - Math.abs(market.yesPrice - 0.5) * 2;
  return timeScore * 0.6 + centrality * 0.4;
}
