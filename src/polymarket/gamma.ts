import { getJson } from "./http.ts";
import type { BinaryMarket, Market } from "../types.ts";

/**
 * Gamma is loosely typed and has changed shape over time: several fields come
 * back as JSON-encoded strings rather than arrays (`outcomes`, `clobTokenIds`,
 * `outcomePrices`), and numeric fields appear as either numbers or strings
 * depending on the field and the endpoint. Everything here is written to accept
 * both. `describeMarketShape` exists so `poly doctor` can show you the raw keys
 * of a live response when Gamma changes under us again.
 */

type Raw = Record<string, unknown>;

function str(raw: Raw, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function num(raw: Raw, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function bool(raw: Raw, ...keys: string[]): boolean | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

/** Accepts a real array, or a JSON string encoding one. */
export function parseListField(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[")) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return null;
    }
  }
  return null;
}

function list(raw: Raw, ...keys: string[]): string[] {
  for (const k of keys) {
    const parsed = parseListField(raw[k]);
    if (parsed) return parsed;
  }
  return [];
}

export function normalizeMarket(raw: Raw): Market | null {
  const id = str(raw, "id", "marketId");
  const question = str(raw, "question", "title");
  if (!id || !question) return null;

  const outcomePrices = list(raw, "outcomePrices", "outcome_prices")
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p));

  return {
    id,
    question,
    slug: str(raw, "slug") ?? id,
    description: str(raw, "description") ?? "",
    conditionId: str(raw, "conditionId", "condition_id") ?? "",
    endDate: str(raw, "endDate", "end_date", "endDateIso"),
    closed: bool(raw, "closed") ?? false,
    active: bool(raw, "active") ?? true,
    // Gamma has used both spellings; absent means "assume open and let the
    // book tell us", since a market with no book is screened out anyway.
    acceptingOrders: bool(raw, "acceptingOrders", "accepting_orders", "enableOrderBook") ?? true,
    volume: num(raw, "volumeNum", "volume", "volume24hr") ?? 0,
    liquidity: num(raw, "liquidityNum", "liquidity") ?? 0,
    outcomes: list(raw, "outcomes"),
    outcomePrices,
    clobTokenIds: list(raw, "clobTokenIds", "clob_token_ids"),
    bestBid: num(raw, "bestBid", "best_bid"),
    bestAsk: num(raw, "bestAsk", "best_ask"),
    spread: num(raw, "spread"),
    umaResolutionStatus: str(raw, "umaResolutionStatus", "uma_resolution_status"),
  };
}

/**
 * Narrow to a binary Yes/No market. Anything with a different outcome set, or
 * missing the CLOB token ids we need to price it, is not tradeable by us.
 */
export function asBinaryMarket(market: Market): BinaryMarket | null {
  if (market.outcomes.length !== 2 || market.clobTokenIds.length !== 2) return null;

  const yesIndex = market.outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
  const noIndex = market.outcomes.findIndex((o) => o.trim().toLowerCase() === "no");
  if (yesIndex === -1 || noIndex === -1) return null;

  const yesTokenId = market.clobTokenIds[yesIndex];
  const noTokenId = market.clobTokenIds[noIndex];
  if (!yesTokenId || !noTokenId) return null;

  const yesPrice = market.outcomePrices[yesIndex];
  if (yesPrice === undefined || !Number.isFinite(yesPrice)) return null;

  return { ...market, yesTokenId, noTokenId, yesPrice };
}

export interface FetchMarketsOptions {
  base: string;
  limit: number;
  /** Gamma caps `limit` per request; we page until we have `limit` markets. */
  pageSize?: number;
}

export async function fetchOpenMarkets(opts: FetchMarketsOptions): Promise<Market[]> {
  const pageSize = opts.pageSize ?? 100;
  const out: Market[] = [];
  let offset = 0;

  while (out.length < opts.limit) {
    const url =
      `${opts.base}/markets?closed=false&active=true` +
      `&limit=${pageSize}&offset=${offset}&order=volume24hr&ascending=false`;
    const page = await getJson<unknown>(url);
    const rows = Array.isArray(page) ? page : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const market = normalizeMarket(row as Raw);
      if (market) out.push(market);
    }

    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  return out.slice(0, opts.limit);
}

export async function fetchMarketById(base: string, id: string): Promise<Market | null> {
  const raw = await getJson<unknown>(`${base}/markets/${encodeURIComponent(id)}`);
  // Gamma returns either the object or a single-element array depending on path.
  const row = Array.isArray(raw) ? raw[0] : raw;
  return row ? normalizeMarket(row as Raw) : null;
}

/** For `poly doctor`: what did Gamma actually send us? */
export function describeMarketShape(raw: Raw): string {
  const keys = Object.keys(raw).sort();
  const interesting = [
    "outcomes",
    "outcomePrices",
    "clobTokenIds",
    "liquidity",
    "liquidityNum",
    "volume",
    "volumeNum",
    "bestBid",
    "bestAsk",
    "spread",
    "acceptingOrders",
  ];
  const lines = interesting.map((k) => {
    const v = raw[k];
    const shown = v === undefined ? "(absent)" : JSON.stringify(v).slice(0, 80);
    return `    ${k.padEnd(18)} ${typeof v === "undefined" ? "" : `[${typeof v}]`} ${shown}`;
  });
  return `  all keys: ${keys.join(", ")}\n${lines.join("\n")}`;
}
