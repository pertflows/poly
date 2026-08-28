import { test } from "node:test";
import assert from "node:assert/strict";

import { brierScore, calibrationBins, edgeTest } from "../src/engine/calibration.ts";
import type { ScoredForecast } from "../src/engine/calibration.ts";

function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("brier score anchors at the values everyone reasons from", () => {
  // Perfect foresight.
  assert.equal(brierScore([{ p: 1, outcome: 1 }, { p: 0, outcome: 0 }]), 0);
  // Maximally wrong.
  assert.equal(brierScore([{ p: 0, outcome: 1 }]), 1);
  // Always saying 50% - the score to beat.
  assert.equal(brierScore([{ p: 0.5, outcome: 1 }, { p: 0.5, outcome: 0 }]), 0.25);
  assert.ok(Number.isNaN(brierScore([])));
});

test("calibration bins report observed frequency against stated confidence", () => {
  // Ten forecasts at 0.7, seven of which resolve YES: perfectly calibrated.
  const forecasts: ScoredForecast[] = Array.from({ length: 10 }, (_, i) => ({
    probability: 0.7,
    marketProbability: 0.5,
    outcome: i < 7 ? 1 : 0,
  }));

  const bins = calibrationBins(forecasts);
  const bin = bins.find((b) => b.count > 0)!;
  assert.equal(bin.count, 10);
  closeTo(bin.meanForecast, 0.7);
  closeTo(bin.observedRate, 0.7);
  // 0.7 lands in the 0.7-0.8 bucket, not 0.6-0.7.
  assert.equal(bin.lower, 0.7);
});

test("a forecaster that beats the market scores positive skill", () => {
  // Claude is right every time; the market is at a coin flip.
  const forecasts: ScoredForecast[] = Array.from({ length: 50 }, (_, i) => ({
    probability: i % 2 === 0 ? 0.95 : 0.05,
    marketProbability: 0.5,
    outcome: i % 2 === 0 ? 1 : 0,
  }));

  const test1 = edgeTest(forecasts);
  assert.ok(test1.brierModel < test1.brierMarket);
  assert.ok(test1.skillScore > 0);
  assert.ok(test1.tStat > 2, "a margin this large should be statistically clear");
  assert.equal(test1.significant, true);
  assert.match(test1.verdict, /beat the market/);
});

test("a forecaster that loses to the market is called out as such", () => {
  // Claude is confidently wrong; the market is right.
  const forecasts: ScoredForecast[] = Array.from({ length: 50 }, (_, i) => ({
    probability: i % 2 === 0 ? 0.1 : 0.9,
    marketProbability: i % 2 === 0 ? 0.9 : 0.1,
    outcome: i % 2 === 0 ? 1 : 0,
  }));

  const result = edgeTest(forecasts);
  assert.ok(result.skillScore < 0);
  assert.match(result.verdict, /no edge to trade|Do not fund/);
});

test("a small sample refuses to draw a conclusion", () => {
  const forecasts: ScoredForecast[] = Array.from({ length: 5 }, () => ({
    probability: 0.9,
    marketProbability: 0.5,
    outcome: 1,
  }));

  const result = edgeTest(forecasts);
  assert.match(result.verdict, /Too few to conclude/);
});
