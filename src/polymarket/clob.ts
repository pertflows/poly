import { getJson } from "./http.ts";
import type { BookLevel, OrderBook, Quote } from "../types.ts";

interface RawBook {
  asset_id?: string;
  bids?: Array<{ price: string | number; size: string | number }>;
  asks?: Array<{ price: string | number; size: string | number }>;
}

function levels(rows: RawBook["bids"], descending: boolean): BookLevel[] {
  const parsed = (rows ?? [])
    .map((r) => ({ price: Number(r.price), size: Number(r.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
  // The CLOB does not guarantee ordering; sort so index 0 is always the touch.
  parsed.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  return parsed;
}

export async function fetchBook(base: string, tokenId: string): Promise<OrderBook> {
  const raw = await getJson<RawBook>(`${base}/book?token_id=${encodeURIComponent(tokenId)}`);
  return {
    tokenId,
    bids: levels(raw.bids, true),
    asks: levels(raw.asks, false),
  };
}

/**
 * Collapse a YES book into the numbers a buyer cares about.
 *
 * Returns null when either side of the book is empty: we will not size a
 * position against a price we cannot actually transact at.
 */
export function quoteFromBook(book: OrderBook): Quote | null {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  if (!bestBid || !bestAsk) return null;
  if (bestAsk.price <= bestBid.price) return null; // crossed or degenerate

  return {
    yesAsk: bestAsk.price,
    yesBid: bestBid.price,
    // Buying NO at price x is economically buying YES-complement; on a binary
    // market the NO ask is 1 minus the YES bid.
    noAsk: 1 - bestBid.price,
    yesAskSize: bestAsk.size,
    noAskSize: bestBid.size,
    spread: bestAsk.price - bestBid.price,
    mid: (bestAsk.price + bestBid.price) / 2,
  };
}

/**
 * Average fill price for `contracts` walked into the book, or null if the book
 * is too thin to fill. Top-of-book pricing overstates edge on the exact markets
 * where edge is most likely - the illiquid ones - so sizing uses this instead.
 */
export function walkBook(levelsIn: readonly BookLevel[], contracts: number): number | null {
  let remaining = contracts;
  let cost = 0;
  for (const level of levelsIn) {
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
    if (remaining <= 1e-9) return cost / contracts;
  }
  return null;
}
