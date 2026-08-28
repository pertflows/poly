import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  markets_fetched INTEGER NOT NULL DEFAULT 0,
  markets_passed  INTEGER NOT NULL DEFAULT 0,
  forecasts       INTEGER NOT NULL DEFAULT 0,
  positions       INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS forecasts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER REFERENCES runs(id),
  market_id          TEXT    NOT NULL,
  condition_id       TEXT,
  slug               TEXT,
  question           TEXT    NOT NULL,
  end_date           TEXT,
  created_at         TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  probability        REAL    NOT NULL,
  shrunk_probability REAL    NOT NULL,
  market_probability REAL    NOT NULL,
  confidence         TEXT    NOT NULL,
  abstain            INTEGER NOT NULL DEFAULT 0,
  abstain_reason     TEXT,
  stale_knowledge    INTEGER NOT NULL DEFAULT 0,
  ambiguous          INTEGER NOT NULL DEFAULT 0,
  resolution_reading TEXT,
  base_rate          TEXT,
  key_drivers        TEXT,
  evidence_for       TEXT,
  evidence_against   TEXT,
  research           TEXT,
  cost_usd           REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_forecasts_market  ON forecasts(market_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_created ON forecasts(created_at);

CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_id INTEGER NOT NULL REFERENCES forecasts(id),
  market_id   TEXT    NOT NULL,
  question    TEXT    NOT NULL,
  side        TEXT    NOT NULL,
  entry_price REAL    NOT NULL,
  contracts   REAL    NOT NULL,
  stake_usd   REAL    NOT NULL,
  edge        REAL    NOT NULL,
  opened_at   TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open',
  settled_at  TEXT,
  outcome     INTEGER,
  pnl_usd     REAL
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);

CREATE TABLE IF NOT EXISTS resolutions (
  market_id   TEXT PRIMARY KEY,
  resolved_at TEXT    NOT NULL,
  outcome     INTEGER NOT NULL,
  source      TEXT
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** node:sqlite binds only null/number/bigint/string/Uint8Array - not booleans. */
export function bit(value: boolean): number {
  return value ? 1 : 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}
