import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";
import {
  assessEdge,
  deriveNoAsks,
  effectivePrice,
  kellyFraction,
  shrinkProbability,
} from "../src/engine/edge.ts";
import { quoteFromBook, walkBook } from "../src/polymarket/clob.ts";
import type { BinaryMarket, Forecast, OrderBook } from "../src/types.ts";

/**
 * Shrinkage and edge thresholds are tunables, so a test that reads whatever
 * the defaults happen to be is really asserting on configuration rather than
 * on behaviour - and breaks the moment the defaults are retuned. These pin the
 * discriminating values the mechanism is supposed to honour: distinct factors
 * per confidence level, and stale knowledge shrinking harder than plain.
 */
function cfg() {
  const base = loadConfig();
  return {
    ...base,
    trade: {
      ...base.trade,
      shrink: { low: 0.2, medium: 0.35, high: 0.5 },
      staleKnowledgeShrink: 0.3,
    },
  };
}

/** Probabilities are floats; compare with tolerance rather than bit-equality. */
function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function forecast(over: Partial<Forecast> = {}): Forecast {
  return {
    resolutionReading: "X must happen by the date",
    ambiguous: false,
    keyDrivers: [],
    baseRate: "40% historically",
    evidenceFor: [],
    evidenceAgainst: [],
    staleKnowledge: false,
    probability: 0.9,
    confidence: "high",
    abstain: false,
    abstainReason: "",
    ...over,
  };
}

function market(): BinaryMarket {
  return {
    id: "1",
    question: "Will X happen?",
    slug: "will-x",
    description: "Resolves YES if X.",
    conditionId: "0xabc",
    endDate: "2026-12-01T00:00:00Z",
    closed: false,
    active: true,
    acceptingOrders: true,
    volume: 100_000,
    liquidity: 50_000,
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: ["yes-token", "no-token"],
    bestBid: 0.48,
    bestAsk: 0.52,
    spread: 0.04,
    umaResolutionStatus: null,
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    yesPrice: 0.5,
  };
}

/** A deep book so depth is never the binding constraint unless a test says so. */
function book(over: Partial<OrderBook> = {}): OrderBook {
  return {
    tokenId: "yes-token",
    bids: [
      { price: 0.48, size: 10_000 },
      { price: 0.47, size: 10_000 },
    ],
    asks: [
      { price: 0.52, size: 10_000 },
      { price: 0.53, size: 10_000 },
    ],
    ...over,
  };
}

test("kelly fraction matches the closed form for binary contracts", () => {
  // f* = (p - c) / (1 - c)
  closeTo(kellyFraction(0.7, 0.5), 0.4);
  closeTo(kellyFraction(0.6, 0.2), 0.5);
  // A bet with no edge stakes nothing.
  assert.equal(kellyFraction(0.5, 0.5), 0);
  // Never returns a negative stake - we do not short.
  assert.equal(kellyFraction(0.3, 0.5), 0);
  // Degenerate prices cannot be sized.
  assert.equal(kellyFraction(0.9, 1), 0);
  assert.equal(kellyFraction(0.9, 0), 0);
});

test("shrinkage pulls toward the market and never past the raw estimate", () => {
  const c = cfg();
  const high = shrinkProbability(0.9, 0.5, forecast({ confidence: "high" }), c);
  const low = shrinkProbability(0.9, 0.5, forecast({ confidence: "low" }), c);

  closeTo(high, 0.7); // market 0.5 + lambda 0.5 * disagreement 0.4
  assert.ok(low < high, "low confidence should move less than high");
  assert.ok(high < 0.9, "shrunk estimate must stay short of the raw estimate");
  assert.ok(high > 0.5, "shrunk estimate must move off the market price");
});

test("stale knowledge and ambiguity compound the shrinkage", () => {
  const c = cfg();
  const plain = shrinkProbability(0.9, 0.5, forecast(), c);
  const stale = shrinkProbability(0.9, 0.5, forecast({ staleKnowledge: true }), c);
  const both = shrinkProbability(
    0.9,
    0.5,
    forecast({ staleKnowledge: true, ambiguous: true }),
    c,
  );

  assert.ok(stale < plain, "stale knowledge must shrink harder");
  assert.ok(both < stale, "ambiguity must shrink harder still");
  assert.ok(both > 0.5, "shrinkage must not cross the market price");
});

test("effective price applies fees and slippage upward", () => {
  const c = cfg();
  c.trade.feeBps = 100;
  c.trade.slippageBps = 100;
  closeTo(effectivePrice(0.5, c), 0.51);
  // Never quotes a price at or above certainty.
  assert.ok(effectivePrice(0.999, c) < 1);
});

test("NO asks are the mirror of YES bids", () => {
  const asks = deriveNoAsks([
    { price: 0.48, size: 100 },
    { price: 0.47, size: 200 },
  ]);
  assert.deepEqual(asks, [
    { price: 0.52, size: 100 },
    { price: 0.53, size: 200 },
  ]);
});

test("walking the book returns the volume-weighted fill, or null when too thin", () => {
  const levels = [
    { price: 0.50, size: 100 },
    { price: 0.60, size: 100 },
  ];
  closeTo(walkBook(levels, 100)!, 0.5);
  closeTo(walkBook(levels, 200)!, 0.55); // half at each level
  assert.equal(walkBook(levels, 300), null); // not enough depth
});

test("a large disagreement produces a sized YES position", () => {
  const c = cfg();
  const b = book();
  const quote = quoteFromBook(b)!;
  const result = assessEdge({
    market: market(),
    book: b,
    quote,
    forecast: forecast({ probability: 0.9, confidence: "high" }),
    cfg: c,
    bankroll: 1_000,
  });

  assert.equal(result.side, "YES");
  assert.equal(result.tradeable, true);
  closeTo(result.shrunkProbability, 0.7);
  // Capped by maxPositionPct (5% of 1000) rather than by Kelly (which wants 10%).
  assert.equal(result.stakeUsd, 50);
  assert.ok(result.contracts > 0);
  assert.ok(result.edge > c.trade.minEdge);
});

test("a disagreement in the other direction buys NO", () => {
  const c = cfg();
  const b = book();
  const quote = quoteFromBook(b)!;
  const result = assessEdge({
    market: market(),
    book: b,
    quote,
    forecast: forecast({ probability: 0.1, confidence: "high" }),
    cfg: c,
    bankroll: 1_000,
  });

  assert.equal(result.side, "NO");
  assert.equal(result.tradeable, true);
  closeTo(result.shrunkProbability, 0.3);
  // NO is bought at 1 - the YES bid.
  assert.ok(result.entryPrice >= 0.52);
});

test("small disagreements are not traded", () => {
  const c = cfg();
  const b = book();
  const result = assessEdge({
    market: market(),
    book: b,
    quote: quoteFromBook(b)!,
    forecast: forecast({ probability: 0.55 }),
    cfg: c,
    bankroll: 1_000,
  });

  assert.equal(result.tradeable, false);
  assert.match(result.reason, /below threshold/);
});

test("an abstention is never traded, however large the apparent edge", () => {
  const c = cfg();
  const b = book();
  const result = assessEdge({
    market: market(),
    book: b,
    quote: quoteFromBook(b)!,
    forecast: forecast({ probability: 0.99, abstain: true, abstainReason: "criteria unclear" }),
    cfg: c,
    bankroll: 1_000,
  });

  assert.equal(result.tradeable, false);
  assert.equal(result.stakeUsd, 0);
  assert.match(result.reason, /abstained/);
});

test("a book too thin to fill the sized position is rejected", () => {
  const c = cfg();
  const thin = book({ asks: [{ price: 0.52, size: 5 }] });
  const result = assessEdge({
    market: market(),
    book: thin,
    quote: quoteFromBook(thin)!,
    forecast: forecast({ probability: 0.9 }),
    cfg: c,
    bankroll: 1_000,
  });

  assert.equal(result.tradeable, false);
  assert.match(result.reason, /too thin/);
});

test("walking a thin book can erase an edge that existed at the touch", () => {
  const c = cfg();
  // Enough depth to fill, but only at progressively worse prices.
  const laddered = book({
    asks: [
      { price: 0.52, size: 1 },
      { price: 0.68, size: 10_000 },
    ],
  });
  const result = assessEdge({
    market: market(),
    book: laddered,
    quote: quoteFromBook(laddered)!,
    forecast: forecast({ probability: 0.9 }),
    cfg: c,
    bankroll: 1_000,
  });

  assert.equal(result.tradeable, false);
  assert.match(result.reason, /after walking the book/);
});

test("an empty or crossed book yields no quote at all", () => {
  assert.equal(quoteFromBook({ tokenId: "t", bids: [], asks: [] }), null);
  assert.equal(
    quoteFromBook({ tokenId: "t", bids: [{ price: 0.6, size: 1 }], asks: [{ price: 0.5, size: 1 }] }),
    null,
  );
});
