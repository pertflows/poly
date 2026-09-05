import type { DatabaseSync } from "node:sqlite";

import { bit, nowIso } from "./db.ts";
import type { BinaryMarket, EdgeAssessment, ForecastRun } from "../types.ts";
import type { ScoredForecast } from "../engine/calibration.ts";

export interface OpenPosition {
  id: number;
  market_id: string;
  question: string;
  side: string;
  entry_price: number;
  contracts: number;
  stake_usd: number;
  opened_at: string;
}

export function startRun(db: DatabaseSync): number {
  const result = db.prepare("INSERT INTO runs (started_at) VALUES (?)").run(nowIso());
  return Number(result.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  runId: number,
  stats: {
    marketsFetched: number;
    marketsPassed: number;
    forecasts: number;
    positions: number;
    costUsd: number;
    notes?: string;
  },
): void {
  db.prepare(
    `UPDATE runs
        SET finished_at = ?, markets_fetched = ?, markets_passed = ?,
            forecasts = ?, positions = ?, cost_usd = ?, notes = ?
      WHERE id = ?`,
  ).run(
    nowIso(),
    stats.marketsFetched,
    stats.marketsPassed,
    stats.forecasts,
    stats.positions,
    stats.costUsd,
    stats.notes ?? null,
    runId,
  );
}

export function insertForecast(
  db: DatabaseSync,
  runId: number,
  market: BinaryMarket,
  run: ForecastRun,
  assessment: EdgeAssessment,
  model: string,
): number {
  const { forecast } = run;
  const result = db
    .prepare(
      `INSERT INTO forecasts (
         run_id, market_id, condition_id, slug, question, end_date, created_at, model,
         probability, shrunk_probability, market_probability, confidence,
         abstain, abstain_reason, stale_knowledge, ambiguous,
         resolution_reading, base_rate, key_drivers, evidence_for, evidence_against,
         research, cost_usd,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      runId,
      market.id,
      market.conditionId,
      market.slug,
      market.question,
      market.endDate,
      nowIso(),
      model,
      forecast.probability,
      assessment.shrunkProbability,
      assessment.marketProbability,
      forecast.confidence,
      bit(forecast.abstain),
      forecast.abstainReason,
      bit(forecast.staleKnowledge),
      bit(forecast.ambiguous),
      forecast.resolutionReading,
      forecast.baseRate,
      JSON.stringify(forecast.keyDrivers),
      JSON.stringify(forecast.evidenceFor),
      JSON.stringify(forecast.evidenceAgainst),
      run.research,
      run.cost.usd,
      run.cost.inputTokens,
      run.cost.outputTokens,
      run.cost.cacheReadTokens,
      run.cost.cacheWriteTokens,
    );
  return Number(result.lastInsertRowid);
}

export function insertPosition(
  db: DatabaseSync,
  forecastId: number,
  market: BinaryMarket,
  assessment: EdgeAssessment,
): number {
  const result = db
    .prepare(
      `INSERT INTO positions (
         forecast_id, market_id, question, side, entry_price, contracts,
         stake_usd, edge, opened_at, status
       ) VALUES (?,?,?,?,?,?,?,?,?, 'open')`,
    )
    .run(
      forecastId,
      market.id,
      market.question,
      assessment.side,
      assessment.entryPrice,
      assessment.contracts,
      assessment.stakeUsd,
      assessment.edge,
      nowIso(),
    );
  return Number(result.lastInsertRowid);
}

/** Market ids forecast within the last `days` days - we skip re-forecasting them. */
export function recentlyForecastIds(db: DatabaseSync, days: number): Set<string> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare("SELECT DISTINCT market_id FROM forecasts WHERE created_at >= ?")
    .all(cutoff) as Array<{ market_id: string }>;
  return new Set(rows.map((r) => r.market_id));
}

export function openPositions(db: DatabaseSync): OpenPosition[] {
  return db
    .prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at")
    .all() as unknown as OpenPosition[];
}

export function recordResolution(
  db: DatabaseSync,
  marketId: string,
  outcome: number,
  source: string,
): void {
  db.prepare(
    `INSERT INTO resolutions (market_id, resolved_at, outcome, source)
     VALUES (?,?,?,?)
     ON CONFLICT(market_id) DO UPDATE SET
       resolved_at = excluded.resolved_at,
       outcome     = excluded.outcome,
       source      = excluded.source`,
  ).run(marketId, nowIso(), outcome, source);
}

/**
 * Settle a paper position at resolution. A binary contract pays $1 if the side
 * you bought was right and $0 otherwise, so P&L is contracts minus stake on a
 * win, and minus the stake on a loss.
 */
export function settlePosition(
  db: DatabaseSync,
  position: OpenPosition,
  outcome: number,
): number {
  const won = (position.side === "YES" && outcome === 1) || (position.side === "NO" && outcome === 0);
  const pnl = won ? position.contracts - position.stake_usd : -position.stake_usd;

  db.prepare(
    `UPDATE positions
        SET status = 'settled', settled_at = ?, outcome = ?, pnl_usd = ?
      WHERE id = ?`,
  ).run(nowIso(), outcome, pnl, position.id);

  return pnl;
}

/** Every forecast whose market has since resolved - the input to the edge test. */
export function scoredForecasts(db: DatabaseSync): ScoredForecast[] {
  const rows = db
    .prepare(
      `SELECT f.probability, f.market_probability, r.outcome
         FROM forecasts f
         JOIN resolutions r ON r.market_id = f.market_id
        WHERE f.abstain = 0`,
    )
    .all() as Array<{ probability: number; market_probability: number; outcome: number }>;

  return rows.map((r) => ({
    probability: r.probability,
    marketProbability: r.market_probability,
    outcome: r.outcome,
  }));
}

export interface PortfolioSummary {
  openCount: number;
  openStake: number;
  settledCount: number;
  wins: number;
  realizedPnl: number;
  totalStaked: number;
  totalCostUsd: number;
  forecastCount: number;
  abstainCount: number;
}

export function portfolioSummary(db: DatabaseSync): PortfolioSummary {
  const one = <T>(sql: string): T =>
    db.prepare(sql).get() as unknown as T;

  const open = one<{ n: number; stake: number | null }>(
    "SELECT COUNT(*) AS n, SUM(stake_usd) AS stake FROM positions WHERE status = 'open'",
  );
  const settled = one<{ n: number; wins: number | null; pnl: number | null; stake: number | null }>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(pnl_usd) AS pnl,
            SUM(stake_usd) AS stake
       FROM positions WHERE status = 'settled'`,
  );
  const forecasts = one<{ n: number; abstains: number | null; cost: number | null }>(
    `SELECT COUNT(*) AS n,
            SUM(abstain) AS abstains,
            SUM(cost_usd) AS cost
       FROM forecasts`,
  );

  return {
    openCount: open.n,
    openStake: open.stake ?? 0,
    settledCount: settled.n,
    wins: settled.wins ?? 0,
    realizedPnl: settled.pnl ?? 0,
    totalStaked: settled.stake ?? 0,
    totalCostUsd: forecasts.cost ?? 0,
    forecastCount: forecasts.n,
    abstainCount: forecasts.abstains ?? 0,
  };
}

/**
 * Markets we forecast but have not yet recorded a resolution for.
 *
 * This deliberately includes markets we never traded. The edge test is scored
 * over every forecast, not just the ones that cleared the edge threshold -
 * scoring only the traded subset would select for cases where Claude disagreed
 * with the market, which is exactly the bias that makes a bad strategy look
 * good.
 */
export function unresolvedForecastMarkets(
  db: DatabaseSync,
): Array<{ market_id: string; question: string; end_date: string | null }> {
  return db
    .prepare(
      `SELECT DISTINCT f.market_id, f.question, f.end_date
         FROM forecasts f
    LEFT JOIN resolutions r ON r.market_id = f.market_id
        WHERE r.market_id IS NULL`,
    )
    .all() as unknown as Array<{ market_id: string; question: string; end_date: string | null }>;
}

export function openPositionsForMarket(db: DatabaseSync, marketId: string): OpenPosition[] {
  return db
    .prepare("SELECT * FROM positions WHERE status = 'open' AND market_id = ?")
    .all(marketId) as unknown as OpenPosition[];
}
