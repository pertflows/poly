import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/store/db.ts";
import {
  insertForecast,
  insertPosition,
  openPositions,
  openPositionsForMarket,
  portfolioSummary,
  recentlyForecastIds,
  recordResolution,
  scoredForecasts,
  settlePosition,
  startRun,
  unresolvedForecastMarkets,
} from "../src/store/repo.ts";
import type { BinaryMarket, EdgeAssessment, ForecastRun } from "../src/types.ts";

function market(id: string): BinaryMarket {
  return {
    id,
    question: `Question ${id}`,
    slug: `q-${id}`,
    description: "criteria",
    conditionId: `0x${id}`,
    endDate: "2026-12-01T00:00:00Z",
    closed: false,
    active: true,
    acceptingOrders: true,
    volume: 1,
    liquidity: 1,
    outcomes: ["Yes", "No"],
    outcomePrices: [0.4, 0.6],
    clobTokenIds: ["y", "n"],
    bestBid: 0.39,
    bestAsk: 0.41,
    spread: 0.02,
    umaResolutionStatus: null,
    yesTokenId: "y",
    noTokenId: "n",
    yesPrice: 0.4,
  };
}

function run(probability: number): ForecastRun {
  return {
    forecast: {
      resolutionReading: "reading",
      ambiguous: false,
      keyDrivers: ["a"],
      baseRate: "30%",
      evidenceFor: ["x"],
      evidenceAgainst: ["y"],
      staleKnowledge: false,
      probability,
      confidence: "high",
      abstain: false,
      abstainReason: "",
    },
    research: "brief",
    cost: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0.25 },
  };
}

function assessment(side: "YES" | "NO", entryPrice: number, stake: number): EdgeAssessment {
  return {
    side,
    rawProbability: 0.8,
    marketProbability: 0.4,
    shrunkProbability: 0.6,
    entryPrice,
    edge: 0.2,
    kelly: 0.1,
    stakeUsd: stake,
    contracts: stake / entryPrice,
    tradeable: true,
    reason: "test",
  };
}

function seed() {
  const db = openDb(":memory:");
  const runId = startRun(db);
  return { db, runId };
}

test("a winning YES position pays out contracts minus stake", () => {
  const { db, runId } = seed();
  const m = market("1");
  const forecastId = insertForecast(db, runId, m, run(0.8), assessment("YES", 0.4, 40), "test-model");
  insertPosition(db, forecastId, m, assessment("YES", 0.4, 40));

  const position = openPositions(db)[0]!;
  assert.equal(position.contracts, 100);

  const pnl = settlePosition(db, position, 1);
  assert.equal(pnl, 60); // 100 contracts pay $100 against a $40 stake
  assert.equal(openPositions(db).length, 0);
  db.close();
});

test("a losing position loses exactly the stake, never more", () => {
  const { db, runId } = seed();
  const m = market("1");
  const forecastId = insertForecast(db, runId, m, run(0.8), assessment("YES", 0.4, 40), "m");
  insertPosition(db, forecastId, m, assessment("YES", 0.4, 40));

  const pnl = settlePosition(db, openPositions(db)[0]!, 0);
  assert.equal(pnl, -40);
  db.close();
});

test("NO positions settle on the inverted outcome", () => {
  const { db, runId } = seed();
  const m = market("1");
  const forecastId = insertForecast(db, runId, m, run(0.2), assessment("NO", 0.5, 50), "m");
  insertPosition(db, forecastId, m, assessment("NO", 0.5, 50));

  // Market resolved NO, so a NO position wins.
  const pnl = settlePosition(db, openPositions(db)[0]!, 0);
  assert.equal(pnl, 50); // 100 contracts, $50 stake
  db.close();
});

test("forecasts we never traded still count toward the edge test", () => {
  const { db, runId } = seed();
  const traded = market("1");
  const untraded = market("2");

  const tradedId = insertForecast(db, runId, traded, run(0.8), assessment("YES", 0.4, 40), "m");
  insertPosition(db, tradedId, traded, assessment("YES", 0.4, 40));
  insertForecast(db, runId, untraded, run(0.3), assessment("YES", 0.4, 0), "m");

  assert.equal(unresolvedForecastMarkets(db).length, 2, "both markets await resolution");

  recordResolution(db, "1", 1, "gamma");
  recordResolution(db, "2", 0, "gamma");

  const scored = scoredForecasts(db);
  assert.equal(scored.length, 2, "the untraded forecast must be scored too");
  assert.equal(unresolvedForecastMarkets(db).length, 0);
  db.close();
});

test("abstentions are excluded from scoring", () => {
  const { db, runId } = seed();
  const m = market("1");
  const abstained = run(0.5);
  abstained.forecast.abstain = true;
  insertForecast(db, runId, m, abstained, assessment("YES", 0.4, 0), "m");
  recordResolution(db, "1", 1, "gamma");

  assert.equal(scoredForecasts(db).length, 0);
  db.close();
});

test("recording a resolution twice updates rather than duplicating", () => {
  const { db } = seed();
  recordResolution(db, "1", 1, "gamma");
  recordResolution(db, "1", 0, "manual");
  const rows = db.prepare("SELECT outcome, source FROM resolutions WHERE market_id = '1'").all();
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { outcome: number }).outcome, 0);
  db.close();
});

test("recently forecast markets are skipped on the next scan", () => {
  const { db, runId } = seed();
  insertForecast(db, runId, market("1"), run(0.5), assessment("YES", 0.4, 0), "m");
  assert.ok(recentlyForecastIds(db, 7).has("1"));
  // A window whose cutoff is in the future matches nothing. (A zero-day window
  // would tie on the same millisecond as the insert, so it proves nothing.)
  assert.equal(recentlyForecastIds(db, -1).has("1"), false);
  db.close();
});

test("the portfolio summary tracks stake, P&L, and model cost", () => {
  const { db, runId } = seed();
  const m1 = market("1");
  const m2 = market("2");

  const f1 = insertForecast(db, runId, m1, run(0.8), assessment("YES", 0.4, 40), "m");
  insertPosition(db, f1, m1, assessment("YES", 0.4, 40));
  const f2 = insertForecast(db, runId, m2, run(0.8), assessment("YES", 0.5, 50), "m");
  insertPosition(db, f2, m2, assessment("YES", 0.5, 50));

  settlePosition(db, openPositionsForMarket(db, "1")[0]!, 1); // +60
  settlePosition(db, openPositionsForMarket(db, "2")[0]!, 0); // -50

  const summary = portfolioSummary(db);
  assert.equal(summary.settledCount, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.realizedPnl, 10);
  assert.equal(summary.totalStaked, 90);
  assert.equal(summary.forecastCount, 2);
  assert.equal(summary.totalCostUsd, 0.5); // $0.25 per forecast
  assert.equal(summary.openCount, 0);
  db.close();
});
