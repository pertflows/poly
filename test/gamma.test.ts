import { test } from "node:test";
import assert from "node:assert/strict";

import { asBinaryMarket, normalizeMarket, parseListField } from "../src/polymarket/gamma.ts";
import { readOutcome } from "../src/cli/resolve.ts";

/**
 * Gamma encodes several array fields as JSON strings and several numeric fields
 * as strings. This is the shape the normalizer exists to absorb.
 */
const RAW = {
  id: "512345",
  question: "Will the Fed cut rates in March 2026?",
  slug: "fed-cut-march-2026",
  description: "Resolves YES if the FOMC announces a reduction in the target range.",
  conditionId: "0xdeadbeef",
  endDate: "2026-03-20T00:00:00Z",
  closed: false,
  active: true,
  acceptingOrders: true,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.34", "0.66"]',
  clobTokenIds: '["111", "222"]',
  liquidityNum: 84_000,
  volumeNum: "2400000",
  bestBid: "0.33",
  bestAsk: 0.35,
  spread: 0.02,
};

test("list fields parse from JSON strings and from real arrays alike", () => {
  assert.deepEqual(parseListField('["Yes", "No"]'), ["Yes", "No"]);
  assert.deepEqual(parseListField(["Yes", "No"]), ["Yes", "No"]);
  assert.deepEqual(parseListField('["1","2"]'), ["1", "2"]);
  assert.equal(parseListField("not json"), null);
  assert.equal(parseListField(undefined), null);
  assert.equal(parseListField('{"a":1}'), null);
});

test("a realistic Gamma payload normalizes completely", () => {
  const market = normalizeMarket(RAW);
  assert.ok(market);
  assert.equal(market.id, "512345");
  assert.deepEqual(market.outcomes, ["Yes", "No"]);
  assert.deepEqual(market.outcomePrices, [0.34, 0.66]);
  assert.deepEqual(market.clobTokenIds, ["111", "222"]);
  // Numbers arrive as both strings and numbers; both end up as numbers.
  assert.equal(market.liquidity, 84_000);
  assert.equal(market.volume, 2_400_000);
  assert.equal(market.bestBid, 0.33);
  assert.equal(market.bestAsk, 0.35);
});

test("a payload missing its identity is rejected rather than half-parsed", () => {
  assert.equal(normalizeMarket({ question: "no id" }), null);
  assert.equal(normalizeMarket({ id: "1" }), null);
});

test("binary markets expose Yes/No token ids in the right order", () => {
  const binary = asBinaryMarket(normalizeMarket(RAW)!);
  assert.ok(binary);
  assert.equal(binary.yesTokenId, "111");
  assert.equal(binary.noTokenId, "222");
  assert.equal(binary.yesPrice, 0.34);
});

test("token ids follow the outcome order even when No comes first", () => {
  const flipped = normalizeMarket({
    ...RAW,
    outcomes: '["No", "Yes"]',
    outcomePrices: '["0.66", "0.34"]',
    clobTokenIds: '["222", "111"]',
  })!;
  const binary = asBinaryMarket(flipped);
  assert.ok(binary);
  assert.equal(binary.yesTokenId, "111", "YES token must track the YES outcome, not position 0");
  assert.equal(binary.yesPrice, 0.34);
});

test("non-binary and malformed markets are not tradeable", () => {
  const threeWay = normalizeMarket({
    ...RAW,
    outcomes: '["A", "B", "C"]',
    clobTokenIds: '["1","2","3"]',
    outcomePrices: '["0.3","0.3","0.4"]',
  })!;
  assert.equal(asBinaryMarket(threeWay), null);

  const noTokens = normalizeMarket({ ...RAW, clobTokenIds: "[]" })!;
  assert.equal(asBinaryMarket(noTokens), null);

  const notYesNo = normalizeMarket({ ...RAW, outcomes: '["Up", "Down"]' })!;
  assert.equal(asBinaryMarket(notYesNo), null);
});

test("resolution is read only from a closed market with a settled price", () => {
  const base = normalizeMarket(RAW)!;

  // Open market trading near certainty is NOT resolved.
  assert.equal(readOutcome({ ...base, outcomePrices: [0.99, 0.01] }), null);

  assert.equal(readOutcome({ ...base, closed: true, outcomePrices: [1, 0] }), 1);
  assert.equal(readOutcome({ ...base, closed: true, outcomePrices: [0, 1] }), 0);

  // Closed but still mid-range: UMA dispute or bad data. Wait, don't guess.
  assert.equal(readOutcome({ ...base, closed: true, outcomePrices: [0.5, 0.5] }), null);
});
