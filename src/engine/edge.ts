import type { Config } from "../config.ts";
import type {
  BinaryMarket,
  BookLevel,
  EdgeAssessment,
  Forecast,
  OrderBook,
  Quote,
  Side,
} from "../types.ts";
import { walkBook } from "../polymarket/clob.ts";

/**
 * Move Claude's raw probability toward the market price.
 *
 * The market is a strong prior built from people with money at stake. Claude's
 * number is one estimate with unknown error. Trading the raw number bets that
 * the model is not merely better than the crowd but better by the full size of
 * the disagreement - which is exactly the assumption that empties accounts.
 *
 * `lambda` is how much of the disagreement we are willing to act on. It is a
 * guess at first; once `poly report` has a few hundred resolved forecasts, the
 * calibration curve tells you what it should actually be.
 */
export function shrinkProbability(
  raw: number,
  marketProbability: number,
  forecast: Forecast,
  cfg: Config,
): number {
  let lambda = cfg.trade.shrink[forecast.confidence];
  if (forecast.staleKnowledge) lambda *= cfg.trade.staleKnowledgeShrink;
  if (forecast.ambiguous) lambda *= 0.5;
  return marketProbability + lambda * (raw - marketProbability);
}

/**
 * Kelly fraction for a binary contract bought at `price` that pays $1 on YES.
 *
 *   f* = (p - price) / (1 - price)
 *
 * Negative means the bet is bad; we return 0 rather than shorting.
 */
export function kellyFraction(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  const f = (p - price) / (1 - price);
  return Math.max(0, f);
}

/** Apply fees and a slippage allowance to a quoted price. */
export function effectivePrice(price: number, cfg: Config): number {
  const haircut = (cfg.trade.feeBps + cfg.trade.slippageBps) / 10_000;
  return Math.min(0.999, price * (1 + haircut));
}

/**
 * Buying NO at price x is buying the complement of YES: the NO ask sits at
 * 1 minus the YES bid, with the same depth.
 */
export function deriveNoAsks(yesBids: readonly BookLevel[]): BookLevel[] {
  return yesBids
    .map((l) => ({ price: 1 - l.price, size: l.size }))
    .sort((a, b) => a.price - b.price);
}

export interface AssessInput {
  market: BinaryMarket;
  book: OrderBook;
  quote: Quote;
  forecast: Forecast;
  cfg: Config;
  bankroll: number;
}

/**
 * Turn a forecast plus a live book into a sized decision.
 *
 * Sizing is depth-aware in two passes: size against the touch, then re-price by
 * walking the book for that many contracts and re-size. Top-of-book pricing
 * systematically overstates edge on thin markets - which are precisely the
 * markets where an edge is most plausible, so the error lands where it hurts.
 */
export function assessEdge(input: AssessInput): EdgeAssessment {
  const { market, book, quote, forecast, cfg, bankroll } = input;

  const marketProbability = quote.mid;
  const shrunk = shrinkProbability(forecast.probability, marketProbability, forecast, cfg);

  const side: Side = shrunk > marketProbability ? "YES" : "NO";
  const asks = side === "YES" ? book.asks : deriveNoAsks(book.bids);
  const touch = side === "YES" ? quote.yesAsk : quote.noAsk;
  const pWin = side === "YES" ? shrunk : 1 - shrunk;

  const base = {
    side,
    rawProbability: forecast.probability,
    marketProbability,
    shrunkProbability: shrunk,
  };

  const reject = (reason: string, entryPrice: number, edge: number): EdgeAssessment => ({
    ...base,
    entryPrice,
    edge,
    kelly: 0,
    stakeUsd: 0,
    contracts: 0,
    tradeable: false,
    reason,
  });

  if (forecast.abstain) {
    return reject(`abstained: ${forecast.abstainReason || "no reason given"}`, touch, 0);
  }

  // Pass 1: size against the touch.
  const touchEntry = effectivePrice(touch, cfg);
  const touchEdge = pWin - touchEntry;
  if (touchEdge < cfg.trade.minEdge) {
    return reject(
      `edge ${fmt(touchEdge)} below threshold ${fmt(cfg.trade.minEdge)}`,
      touchEntry,
      touchEdge,
    );
  }

  const provisionalStake = stakeFor(pWin, touchEntry, cfg, bankroll);
  if (provisionalStake <= 0) return reject("kelly sized to zero", touchEntry, touchEdge);

  // Pass 2: re-price by walking the book for that many contracts.
  const provisionalContracts = provisionalStake / touchEntry;
  const walked = walkBook(asks, provisionalContracts);
  if (walked === null) {
    return reject(
      `book too thin to fill ${provisionalContracts.toFixed(0)} contracts`,
      touchEntry,
      touchEdge,
    );
  }

  const entryPrice = effectivePrice(walked, cfg);
  const edge = pWin - entryPrice;
  if (edge < cfg.trade.minEdge) {
    return reject(
      `edge ${fmt(edge)} below threshold ${fmt(cfg.trade.minEdge)} after walking the book`,
      entryPrice,
      edge,
    );
  }

  const kelly = kellyFraction(pWin, entryPrice) * cfg.trade.kellyFraction;
  const stakeUsd = stakeFor(pWin, entryPrice, cfg, bankroll);
  if (stakeUsd <= 0) return reject("kelly sized to zero after walking the book", entryPrice, edge);

  return {
    ...base,
    entryPrice,
    edge,
    kelly,
    stakeUsd,
    contracts: stakeUsd / entryPrice,
    tradeable: true,
    reason: `${side} at ${entryPrice.toFixed(3)} vs ${pWin.toFixed(3)} fair (${market.slug})`,
  };
}

function stakeFor(p: number, price: number, cfg: Config, bankroll: number): number {
  const kelly = kellyFraction(p, price) * cfg.trade.kellyFraction;
  const byKelly = bankroll * kelly;
  const byPct = bankroll * cfg.trade.maxPositionPct;
  const stake = Math.min(byKelly, byPct, cfg.trade.maxPositionAbs);
  // Sub-dollar positions are noise; they cost a Claude call and teach nothing.
  return stake < 1 ? 0 : stake;
}

function fmt(n: number): string {
  return `${(n * 100).toFixed(1)}pp`;
}
