import { loadConfig } from "../config.ts";
import { openDb } from "../store/db.ts";
import { portfolioSummary, scoredForecasts } from "../store/repo.ts";
import { calibrationBins, edgeTest } from "../engine/calibration.ts";

export async function report(): Promise<number> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);

  try {
    const scored = scoredForecasts(db);
    const summary = portfolioSummary(db);

    console.log("\n  === DOES CLAUDE BEAT THE MARKET? ===\n");

    if (scored.length === 0) {
      console.log("  No resolved forecasts yet. Run `npm run scan` regularly and");
      console.log("  `npm run resolve` as markets settle, then come back.\n");
    } else {
      const test = edgeTest(scored);
      const pct = (n: number): string => (Number.isFinite(n) ? n.toFixed(4) : "n/a");

      console.log(`  Resolved forecasts   ${test.n}`);
      console.log(`  Brier - Claude       ${pct(test.brierModel)}`);
      console.log(`  Brier - market       ${pct(test.brierMarket)}   (lower is better)`);
      console.log(`  Skill score          ${(test.skillScore * 100).toFixed(1)}%   (positive = Claude ahead)`);
      console.log(`  Paired t-statistic   ${pct(test.tStat)}   (|t| > 2 is meaningful)`);
      console.log("");
      console.log(`  ${wrap(test.verdict, 74, "  ")}`);
      console.log("");

      console.log("  Calibration - what Claude said vs. what happened\n");
      console.log("    bucket      n   claude   actual   gap");
      for (const bin of calibrationBins(scored)) {
        if (bin.count === 0) continue;
        const gap = bin.observedRate - bin.meanForecast;
        console.log(
          `    ${bin.lower.toFixed(1)}-${bin.upper.toFixed(1)}  ` +
            `${String(bin.count).padStart(5)}   ` +
            `${bin.meanForecast.toFixed(3).padStart(6)}   ` +
            `${bin.observedRate.toFixed(3).padStart(6)}   ` +
            `${gap >= 0 ? "+" : ""}${gap.toFixed(3)}`,
        );
      }
      console.log("");
      console.log("    A well-calibrated forecaster has gaps near zero in every row.");
      console.log("    Consistently negative gaps mean Claude is overconfident on YES.");
      console.log("");
    }

    console.log("  === PAPER PORTFOLIO ===\n");
    const winRate =
      summary.settledCount > 0 ? (summary.wins / summary.settledCount) * 100 : Number.NaN;
    const roi =
      summary.totalStaked > 0 ? (summary.realizedPnl / summary.totalStaked) * 100 : Number.NaN;

    console.log(`  Forecasts made       ${summary.forecastCount} (${summary.abstainCount} abstained)`);
    console.log(`  Open positions       ${summary.openCount}  ($${summary.openStake.toFixed(2)} at risk)`);
    console.log(`  Settled positions    ${summary.settledCount}`);
    console.log(
      `  Win rate             ${Number.isFinite(winRate) ? `${winRate.toFixed(1)}%` : "n/a"}`,
    );
    console.log(
      `  Realized P&L         ${summary.realizedPnl >= 0 ? "+" : ""}$${summary.realizedPnl.toFixed(2)}` +
        `${Number.isFinite(roi) ? `  (${roi >= 0 ? "+" : ""}${roi.toFixed(1)}% on $${summary.totalStaked.toFixed(2)} staked)` : ""}`,
    );
    console.log(`  Spent on Claude      $${summary.totalCostUsd.toFixed(2)}`);

    const net = summary.realizedPnl - summary.totalCostUsd;
    console.log(`  Net of model cost    ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
    console.log("");
    console.log("    Win rate and P&L are the noisy numbers - a losing strategy shows");
    console.log("    profit over short runs routinely. The Brier comparison above is");
    console.log("    the one that actually answers whether there is an edge here.");
    console.log("");

    return 0;
  } finally {
    db.close();
  }
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}
