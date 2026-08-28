import type { Confidence } from "./config.ts";

/** A Polymarket market, normalized out of Gamma's loosely-typed payload. */
export interface Market {
  id: string;
  question: string;
  slug: string;
  description: string;
  conditionId: string;
  endDate: string | null;
  closed: boolean;
  active: boolean;
  acceptingOrders: boolean;
  volume: number;
  liquidity: number;
  /** Outcome labels, e.g. ["Yes", "No"]. */
  outcomes: string[];
  /** Last traded / mid prices per outcome, same order as `outcomes`. */
  outcomePrices: number[];
  /** CLOB token ids per outcome, same order as `outcomes`. */
  clobTokenIds: string[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  umaResolutionStatus: string | null;
}

/**
 * A market we are willing to reason about: exactly two outcomes, Yes first.
 * Multi-outcome events are modeled by Polymarket as sets of binary markets,
 * so restricting to binary costs us nothing and keeps the math honest.
 */
export interface BinaryMarket extends Market {
  yesTokenId: string;
  noTokenId: string;
  /** Last/mid price of the YES outcome, in [0, 1]. */
  yesPrice: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

/** What the top of book means for someone who wants to buy YES right now. */
export interface Quote {
  /** Best price at which YES can be bought. */
  yesAsk: number;
  /** Best price at which YES can be sold. */
  yesBid: number;
  /** Best price at which NO can be bought (= 1 - yesBid). */
  noAsk: number;
  /** Depth available at the touch, in contracts. */
  yesAskSize: number;
  noAskSize: number;
  spread: number;
  mid: number;
}

export type Side = "YES" | "NO";

/** Claude's blind read on a market. It never sees the market price. */
export interface Forecast {
  resolutionReading: string;
  ambiguous: boolean;
  keyDrivers: string[];
  baseRate: string;
  evidenceFor: string[];
  evidenceAgainst: string[];
  staleKnowledge: boolean;
  probability: number;
  confidence: Confidence;
  abstain: boolean;
  abstainReason: string;
}

export interface ForecastCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
}

export interface ForecastRun {
  forecast: Forecast;
  research: string | null;
  cost: ForecastCost;
}

/** The trade decision derived from a forecast plus the live book. */
export interface EdgeAssessment {
  side: Side;
  /** Claude's raw probability that YES resolves true. */
  rawProbability: number;
  /** Market-implied probability that YES resolves true, at the mid. */
  marketProbability: number;
  /** Raw probability shrunk toward the market price. What we actually trade on. */
  shrunkProbability: number;
  /** Price we would pay for one contract of `side`, incl. fees and slippage. */
  entryPrice: number;
  /** Expected value per $1 staked. */
  edge: number;
  kelly: number;
  stakeUsd: number;
  contracts: number;
  tradeable: boolean;
  reason: string;
}
