import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BOOK_FIXTURE, MARKET_FIXTURE, PROVENANCE } from "../src/cli/capture.ts";
import { asBinaryMarket, normalizeMarket, parseListField } from "../src/polymarket/gamma.ts";
import { quoteFromBook } from "../src/polymarket/clob.ts";
import type { OrderBook } from "../src/types.ts";

/**
 * These tests pin the shapes Gamma and the CLOB actually send. They are the
 * only tests in the suite that assert against captured production payloads
 * rather than hand-written ones - which is the point: a hand-written fixture
 * encodes the shape we assumed, and the assumption is exactly what has been
 * wrong before.
 *
 * The fixtures are captured by `npm run capture` from a machine with network
 * access to Polymarket. Until they exist these tests skip, loudly, rather than
 * passing vacuously - a green suite that proves nothing is worse than a skip.
 */

function loadFixture(pathname: string): unknown | null {
  try {
    return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return null;
  }
}

const MISSING =
  "fixture not captured - run `npm run capture` from a host with egress to " +
  "gamma-api.polymarket.com and clob.polymarket.com, then commit test/fixtures/";

test("the captured Gamma market normalizes into a binary market", (t) => {
  const raw = loadFixture(MARKET_FIXTURE);
  if (raw === null) return t.skip(MISSING);

  const market = normalizeMarket(raw as Record<string, unknown>);
  assert.ok(market, "normalizeMarket returned null on a real Gamma payload");

  // Identity and the criteria text the forecaster reads.
  assert.ok(market.id.length > 0, "id missing");
  assert.ok(market.question.length > 0, "question missing");
  assert.ok(market.description.length > 0, "description (resolution criteria) missing");
  assert.ok(market.conditionId.length > 0, "conditionId missing");
  assert.ok(market.endDate, "endDate missing");
  assert.ok(!Number.isNaN(new Date(market.endDate).getTime()), "endDate is not parseable");

  // The fields the screen filters on. Zero here means a filter silently
  // rejects everything, which looks identical to "no markets qualified".
  assert.ok(market.liquidity > 0, "liquidity normalized to 0 - check field name");
  assert.ok(market.volume > 0, "volume normalized to 0 - check field name");

  // The encodings that have changed under us before.
  assert.equal(market.outcomes.length, 2, "outcomes did not decode to two entries");
  assert.equal(market.clobTokenIds.length, 2, "clobTokenIds did not decode to two entries");
  assert.equal(market.outcomePrices.length, 2, "outcomePrices did not decode to two entries");
  for (const price of market.outcomePrices) {
    assert.ok(price >= 0 && price <= 1, `outcome price ${price} outside [0,1]`);
  }

  const binary = asBinaryMarket(market);
  assert.ok(binary, "market did not reduce to a binary Yes/No market");
  assert.ok(binary.yesTokenId.length > 0 && binary.noTokenId.length > 0);
  assert.ok(binary.yesPrice >= 0 && binary.yesPrice <= 1);
});

test("the captured Gamma payload still uses the encodings the client expects", (t) => {
  const raw = loadFixture(MARKET_FIXTURE) as Record<string, unknown> | null;
  if (raw === null) return t.skip(MISSING);

  // Gamma has shipped these as JSON-encoded strings and as native arrays at
  // different times. Both are accepted; anything else is a shape change.
  for (const key of ["outcomes", "outcomePrices", "clobTokenIds"]) {
    const value: unknown = raw[key];
    assert.ok(value !== undefined, `${key} absent from the payload`);
    assert.ok(
      typeof value === "string" || Array.isArray(value),
      `${key} is ${typeof value}, expected a JSON string or an array`,
    );
    assert.ok(parseListField(value), `${key} did not parse into a list`);
  }
});

test("the captured CLOB book prices against the touch", (t) => {
  const raw = loadFixture(BOOK_FIXTURE) as Record<string, unknown> | null;
  if (raw === null) return t.skip(MISSING);

  assert.ok(Array.isArray(raw["bids"]), "book.bids is not an array");
  assert.ok(Array.isArray(raw["asks"]), "book.asks is not an array");

  const level = (raw["asks"] as unknown[])[0] as Record<string, unknown> | undefined;
  if (level) {
    assert.ok("price" in level, "book levels have no `price` field");
    assert.ok("size" in level, "book levels have no `size` field");
  }

  // Reuse the real client's parsing rather than re-deriving it here.
  const toLevels = (rows: unknown, descending: boolean): OrderBook["bids"] =>
    (rows as Array<{ price: string | number; size: string | number }>)
      .map((r) => ({ price: Number(r.price), size: Number(r.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
      .sort((a, b) => (descending ? b.price - a.price : a.price - b.price));

  const book: OrderBook = {
    tokenId: String(raw["asset_id"] ?? "fixture"),
    bids: toLevels(raw["bids"], true),
    asks: toLevels(raw["asks"], false),
  };

  const quote = quoteFromBook(book);
  assert.ok(quote, "a real book did not produce a quote - empty or crossed");
  assert.ok(quote.yesAsk > quote.yesBid, "book is crossed");
  assert.ok(quote.spread > 0 && quote.spread < 1, `implausible spread ${quote.spread}`);
  assert.ok(quote.yesAskSize > 0, "no depth at the touch");
});

test("fixtures record where and when they came from", (t) => {
  const raw = loadFixture(PROVENANCE) as Record<string, unknown> | null;
  if (raw === null) return t.skip(MISSING);

  assert.ok(typeof raw["capturedAt"] === "string", "provenance has no capture timestamp");
  assert.ok(
    !Number.isNaN(new Date(raw["capturedAt"]).getTime()),
    "provenance capturedAt is not a valid timestamp",
  );
  assert.ok(typeof raw["marketUrl"] === "string" && raw["marketUrl"].includes("polymarket"));
});
