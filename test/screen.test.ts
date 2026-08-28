import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";
import { rankForScan, screenMarkets } from "../src/engine/screen.ts";
import type { Market } from "../src/types.ts";

const NOW = new Date("2026-01-01T00:00:00Z");

function market(over: Partial<Market> = {}): Market {
  return {
    id: "1",
    question: "Will X happen?",
    slug: "will-x",
    description: "Resolves YES if X occurs per the official source.",
    conditionId: "0x1",
    endDate: "2026-02-01T00:00:00Z", // ~31 days out
    closed: false,
    active: true,
    acceptingOrders: true,
    volume: 100_000,
    liquidity: 50_000,
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: ["y", "n"],
    bestBid: 0.49,
    bestAsk: 0.51,
    spread: 0.02,
    umaResolutionStatus: null,
    ...over,
  };
}

function screen(markets: Market[], skip = new Set<string>()) {
  return screenMarkets(markets, loadConfig(), NOW, skip);
}

test("a well-formed market in the middle of the band passes", () => {
  const result = screen([market()]);
  assert.equal(result.passed.length, 1);
  assert.equal(result.rejections.size, 0);
});

test("each filter rejects for its own stated reason", () => {
  const cases: Array<[Partial<Market>, RegExp]> = [
    [{ closed: true }, /closed or inactive/],
    [{ active: false }, /closed or inactive/],
    [{ acceptingOrders: false }, /not accepting orders/],
    [{ outcomes: ["Up", "Down"] }, /not a binary/],
    [{ endDate: null }, /no usable resolution date/],
    [{ endDate: "2026-01-01T12:00:00Z" }, /resolves in under/],
    [{ endDate: "2030-01-01T00:00:00Z" }, /resolves beyond/],
    [{ liquidity: 10 }, /below liquidity floor/],
    [{ liquidity: 50_000_000 }, /above liquidity ceiling/],
    [{ volume: 10 }, /below volume floor/],
    [{ outcomePrices: [0.99, 0.01] }, /priced at the extremes/],
    [{ spread: 0.5 }, /spread too wide/],
    [{ description: "" }, /no published resolution criteria/],
  ];

  for (const [over, pattern] of cases) {
    const result = screen([market(over)]);
    assert.equal(result.passed.length, 0, `expected rejection for ${JSON.stringify(over)}`);
    const reasons = [...result.rejections.keys()].join(", ");
    assert.match(reasons, pattern);
  }
});

test("markets forecast recently are skipped without re-spending", () => {
  const result = screen([market({ id: "42" })], new Set(["42"]));
  assert.equal(result.passed.length, 0);
  assert.ok(result.rejections.has("forecast recently"));
});

test("ranking prefers sooner resolution and mid-range prices", () => {
  const soonAndCentral = market({ id: "a", endDate: "2026-01-10T00:00:00Z", outcomePrices: [0.5, 0.5] });
  const farAndCentral = market({ id: "b", endDate: "2026-04-01T00:00:00Z", outcomePrices: [0.5, 0.5] });
  const soonAndExtreme = market({ id: "c", endDate: "2026-01-10T00:00:00Z", outcomePrices: [0.9, 0.1] });

  const { passed } = screen([farAndCentral, soonAndExtreme, soonAndCentral]);
  const ranked = rankForScan(passed, NOW);

  assert.equal(ranked[0]!.id, "a", "soon and central should rank first");
  assert.ok(
    ranked.findIndex((m) => m.id === "b") > ranked.findIndex((m) => m.id === "a"),
    "a market resolving three months out should rank below one resolving in nine days",
  );
});

test("rejection counts aggregate so you can see which filter dominates", () => {
  const result = screen([
    market({ id: "1", liquidity: 10 }),
    market({ id: "2", liquidity: 20 }),
    market({ id: "3", volume: 5 }),
  ]);
  assert.equal(result.rejections.get("below liquidity floor"), 2);
  assert.equal(result.rejections.get("below volume floor"), 1);
});
