/**
 * The edge test.
 *
 * A profitable P&L on twenty paper trades tells you almost nothing - variance
 * on binary bets is enormous and a losing strategy shows profit over short runs
 * routinely. What actually answers the question is whether Claude's probability
 * estimates beat the market's, scored over every forecast including the ones we
 * did not trade.
 *
 * Brier score is mean squared error on probabilities: lower is better, 0 is
 * perfect, and 0.25 is what you get by always saying 50%. The number that
 * matters is not Claude's Brier in isolation but Claude's Brier *versus the
 * market price at the same moment*. If it is not lower, there is no edge here,
 * and no amount of position sizing will manufacture one.
 */

export interface ScoredForecast {
  /** Claude's raw probability that YES resolves true. */
  probability: number;
  /** Market mid at the moment we forecast. */
  marketProbability: number;
  /** 1 if the market resolved YES, 0 if NO. */
  outcome: number;
}

export function brierScore(pairs: readonly { p: number; outcome: number }[]): number {
  if (pairs.length === 0) return Number.NaN;
  const total = pairs.reduce((sum, { p, outcome }) => sum + (p - outcome) ** 2, 0);
  return total / pairs.length;
}

export function logScore(pairs: readonly { p: number; outcome: number }[]): number {
  if (pairs.length === 0) return Number.NaN;
  const total = pairs.reduce((sum, { p, outcome }) => {
    const clamped = Math.min(0.999, Math.max(0.001, p));
    return sum + (outcome === 1 ? Math.log(clamped) : Math.log(1 - clamped));
  }, 0);
  return total / pairs.length;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  /** Mean forecast probability in this bin. */
  meanForecast: number;
  /** Fraction that actually resolved YES. */
  observedRate: number;
}

export function calibrationBins(
  forecasts: readonly ScoredForecast[],
  binCount = 10,
): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: binCount }, (_, i) => ({
    lower: i / binCount,
    upper: (i + 1) / binCount,
    count: 0,
    meanForecast: 0,
    observedRate: 0,
  }));

  for (const f of forecasts) {
    const index = Math.min(binCount - 1, Math.floor(f.probability * binCount));
    const bin = bins[index];
    if (!bin) continue;
    bin.count += 1;
    bin.meanForecast += f.probability;
    bin.observedRate += f.outcome;
  }

  for (const bin of bins) {
    if (bin.count > 0) {
      bin.meanForecast /= bin.count;
      bin.observedRate /= bin.count;
    }
  }

  return bins;
}

export interface EdgeTest {
  n: number;
  brierModel: number;
  brierMarket: number;
  logScoreModel: number;
  logScoreMarket: number;
  /** 1 - brierModel/brierMarket. Positive means Claude beat the market. */
  skillScore: number;
  /** t-statistic on the paired per-question Brier differences. */
  tStat: number;
  /** Rough two-sided significance at |t| > 2. */
  significant: boolean;
  verdict: string;
}

export function edgeTest(forecasts: readonly ScoredForecast[]): EdgeTest {
  const n = forecasts.length;
  const modelPairs = forecasts.map((f) => ({ p: f.probability, outcome: f.outcome }));
  const marketPairs = forecasts.map((f) => ({ p: f.marketProbability, outcome: f.outcome }));

  const brierModel = brierScore(modelPairs);
  const brierMarket = brierScore(marketPairs);

  // Paired differences: market error minus model error, per question. Positive
  // mean means the model is closer to truth. Pairing matters - it removes the
  // variance from questions that were simply easy or hard for everyone.
  const diffs = forecasts.map(
    (f) => (f.marketProbability - f.outcome) ** 2 - (f.probability - f.outcome) ** 2,
  );
  const mean = diffs.reduce((a, b) => a + b, 0) / (n || 1);
  const variance =
    n > 1 ? diffs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1) : Number.NaN;
  const stdError = Math.sqrt(variance / n);
  const tStat = stdError > 0 ? mean / stdError : Number.NaN;

  const skillScore = brierMarket > 0 ? 1 - brierModel / brierMarket : Number.NaN;
  const significant = Number.isFinite(tStat) && Math.abs(tStat) > 2;

  return {
    n,
    brierModel,
    brierMarket,
    logScoreModel: logScore(modelPairs),
    logScoreMarket: logScore(marketPairs),
    skillScore,
    tStat,
    significant,
    verdict: verdictFor(n, skillScore, significant),
  };
}

function verdictFor(n: number, skillScore: number, significant: boolean): string {
  if (n < 30) {
    return `Only ${n} resolved forecasts. Too few to conclude anything - keep scanning. Aim for 100+.`;
  }
  if (!Number.isFinite(skillScore)) {
    return "Could not compute a skill score.";
  }
  if (skillScore > 0 && significant) {
    return `Claude beat the market by ${(skillScore * 100).toFixed(1)}% on Brier, and the margin is statistically distinguishable from noise. This is the result that would justify risking money.`;
  }
  if (skillScore > 0) {
    return `Claude is ahead by ${(skillScore * 100).toFixed(1)}% on Brier, but the margin is within noise at this sample size. Promising, not proven - keep going.`;
  }
  return `Claude is behind the market by ${(Math.abs(skillScore) * 100).toFixed(1)}% on Brier. On this evidence there is no edge to trade. Do not fund this.`;
}
