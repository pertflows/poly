/**
 * All tunables live here. Every one is env-overridable so you can run a
 * scan with different screens without editing code.
 *
 * The defaults are deliberately conservative: this system is a measurement
 * apparatus first and a trading engine second, and a screen that is too
 * loose burns Claude tokens on markets you would never trade anyway.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Confidence = "low" | "medium" | "high";

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  if (["1", "true", "yes", "on"].includes(v.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(v.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean, got ${JSON.stringify(v)}`);
}

export interface ScanConfig {
  /** How many open markets to pull from Gamma before screening. */
  maxMarkets: number;
  /** Hard ceiling on Claude forecasts per run. This is your cost control. */
  maxForecasts: number;
  /** Concurrent forecasts in flight. */
  concurrency: number;
  /** Skip a market we already forecast within this many days. */
  refreshDays: number;

  minLiquidity: number;
  maxLiquidity: number;
  minVolume: number;
  minDaysToResolve: number;
  maxDaysToResolve: number;
  /** Max bid/ask spread in probability points. Wide spreads eat the edge. */
  maxSpread: number;
  /** Ignore markets already priced at the extremes - no room, and the
   *  remaining risk is mostly resolution risk rather than event risk. */
  minPrice: number;
  maxPrice: number;
}

export interface TradeConfig {
  bankroll: number;
  /** Minimum edge (in probability points) after shrinkage to open a position. */
  minEdge: number;
  /** Fraction of full Kelly. Full Kelly on an estimated probability is ruin. */
  kellyFraction: number;
  maxPositionPct: number;
  maxPositionAbs: number;
  feeBps: number;
  slippageBps: number;
  /** How far to move from the market price toward Claude's number, by
   *  confidence. 1.0 would mean "ignore the market entirely". */
  shrink: Record<Confidence, number>;
  /** Extra shrink multiplier when Claude flags its knowledge as stale. */
  staleKnowledgeShrink: number;
}

export interface Config {
  dbPath: string;
  model: string;
  /**
   * Model for the research stage. Gathering and summarizing evidence is not
   * the judgement call - that is stage two's job, on `model`. Research is 92%
   * of a forecast's cost, so running it on a cheaper model is where the bill
   * actually moves.
   */
  researchModel: string;
  effort: Effort;
  research: boolean;
  researchMaxSearches: number;
  gammaBase: string;
  clobBase: string;
  scan: ScanConfig;
  trade: TradeConfig;
}

export function loadConfig(): Config {
  const cfg: Config = {
    dbPath: envStr("POLY_DB", "./data/poly.db"),
    model: envStr("POLY_MODEL", "claude-opus-5"),
    researchModel: envStr("POLY_RESEARCH_MODEL", "claude-sonnet-5"),
    effort: envStr("POLY_EFFORT", "medium") as Effort,
    research: envBool("POLY_RESEARCH", true),
    researchMaxSearches: envNum("POLY_RESEARCH_MAX_SEARCHES", 6),
    gammaBase: envStr("POLY_GAMMA_BASE", "https://gamma-api.polymarket.com"),
    clobBase: envStr("POLY_CLOB_BASE", "https://clob.polymarket.com"),
    scan: {
      maxMarkets: envNum("POLY_MAX_MARKETS", 500),
      maxForecasts: envNum("POLY_MAX_FORECASTS", 8),
      concurrency: envNum("POLY_CONCURRENCY", 3),
      refreshDays: envNum("POLY_REFRESH_DAYS", 7),
      minLiquidity: envNum("POLY_MIN_LIQUIDITY", 5_000),
      maxLiquidity: envNum("POLY_MAX_LIQUIDITY", 2_000_000),
      minVolume: envNum("POLY_MIN_VOLUME", 10_000),
      minDaysToResolve: envNum("POLY_MIN_DAYS", 2),
      maxDaysToResolve: envNum("POLY_MAX_DAYS", 120),
      maxSpread: envNum("POLY_MAX_SPREAD", 0.04),
      minPrice: envNum("POLY_MIN_PRICE", 0.05),
      maxPrice: envNum("POLY_MAX_PRICE", 0.95),
    },
    trade: {
      bankroll: envNum("POLY_BANKROLL", 100),
      minEdge: envNum("POLY_MIN_EDGE", 0.07),
      kellyFraction: envNum("POLY_KELLY_FRACTION", 0.25),
      maxPositionPct: envNum("POLY_MAX_POSITION_PCT", 0.05),
      maxPositionAbs: envNum("POLY_MAX_POSITION_ABS", 100),
      feeBps: envNum("POLY_FEE_BPS", 0),
      slippageBps: envNum("POLY_SLIPPAGE_BPS", 50),
      shrink: {
        low: envNum("POLY_SHRINK_LOW", 1.0),
        medium: envNum("POLY_SHRINK_MEDIUM", 1.0),
        high: envNum("POLY_SHRINK_HIGH", 1.0),
      },
      staleKnowledgeShrink: envNum("POLY_STALE_SHRINK", 1.0),
    },
  };

  validate(cfg);
  return cfg;
}

function validate(cfg: Config): void {
  const problems: string[] = [];
  const { scan, trade } = cfg;

  if (scan.minPrice <= 0 || scan.maxPrice >= 1 || scan.minPrice >= scan.maxPrice) {
    problems.push("POLY_MIN_PRICE/POLY_MAX_PRICE must satisfy 0 < min < max < 1");
  }
  if (scan.minDaysToResolve > scan.maxDaysToResolve) {
    problems.push("POLY_MIN_DAYS must not exceed POLY_MAX_DAYS");
  }
  if (scan.minLiquidity > scan.maxLiquidity) {
    problems.push("POLY_MIN_LIQUIDITY must not exceed POLY_MAX_LIQUIDITY");
  }
  if (trade.kellyFraction <= 0 || trade.kellyFraction > 1) {
    problems.push("POLY_KELLY_FRACTION must be in (0, 1]");
  }
  if (trade.maxPositionPct <= 0 || trade.maxPositionPct > 1) {
    problems.push("POLY_MAX_POSITION_PCT must be in (0, 1]");
  }
  if (trade.bankroll <= 0) problems.push("POLY_BANKROLL must be positive");
  for (const [k, v] of Object.entries(trade.shrink)) {
    if (v < 0 || v > 1) problems.push(`POLY_SHRINK_${k.toUpperCase()} must be in [0, 1]`);
  }
  if (!["low", "medium", "high", "xhigh", "max"].includes(cfg.effort)) {
    problems.push(`POLY_EFFORT must be one of low|medium|high|xhigh|max`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}
