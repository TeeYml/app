/**
 * Mock portfolio-history generation.
 *
 * There is no backend endpoint for historical balance snapshots yet, so this
 * synthesizes a deterministic (seeded) pseudo-random walk per timeframe,
 * anchored to the wallet's real current balance. Swap `buildMockPortfolioHistory`
 * for a real query once such an endpoint exists — everything downstream
 * (resampling, path-building, the chart itself) only depends on the
 * `PortfolioPoint[]` shape, not on how it was produced.
 */

export type Timeframe = "1D" | "1W" | "1M" | "1Y";

export type PortfolioPoint = {
  /** Human-readable label for this point (e.g. "9:00 AM", "Mon", "Feb 3"). */
  label: string;
  value: number;
};

export const TIMEFRAMES: Timeframe[] = ["1D", "1W", "1M", "1Y"];

/** Small deterministic PRNG (linear congruential generator) so the mock
 * series is stable across renders instead of jumping around on every
 * re-render of the chart. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

function generateWalk(seed: number, points: number, volatility: number, base: number): number[] {
  const rand = seededRandom(seed);
  const values: number[] = [Math.max(base, 0)];
  for (let i = 1; i < points; i++) {
    // Slight upward drift (0.48 instead of 0.5) so longer timeframes trend
    // up on average, like a real (mostly-appreciating) portfolio.
    const change = (rand() - 0.48) * volatility;
    values.push(Math.max(values[i - 1] + change, base * 0.4));
  }
  return values;
}

function buildLabels(timeframe: Timeframe, count: number): string[] {
  const now = new Date();

  switch (timeframe) {
    case "1D":
      return Array.from({ length: count }, (_, i) => {
        const hour = Math.round((i / (count - 1)) * 24);
        const d = new Date(now);
        d.setHours(hour, 0, 0, 0);
        return d.toLocaleTimeString(undefined, { hour: "numeric" });
      });
    case "1W":
      return Array.from({ length: count }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (count - 1 - i));
        return d.toLocaleDateString(undefined, { weekday: "short" });
      });
    case "1M":
      return Array.from({ length: count }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (count - 1 - i));
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      });
    case "1Y":
      return Array.from({ length: count }, (_, i) => {
        const d = new Date(now);
        d.setMonth(d.getMonth() - (count - 1 - i));
        return d.toLocaleDateString(undefined, { month: "short" });
      });
  }
}

const TIMEFRAME_SPECS: Record<Timeframe, { points: number; volatilityFactor: number; seed: number }> = {
  "1D": { points: 24, volatilityFactor: 0.006, seed: 11 },
  "1W": { points: 7, volatilityFactor: 0.025, seed: 22 },
  "1M": { points: 30, volatilityFactor: 0.035, seed: 33 },
  "1Y": { points: 12, volatilityFactor: 0.09, seed: 44 },
};

/** Builds a full mock history for every timeframe, anchored so the most
 * recent point in each series always equals `currentBalance`. */
export function buildMockPortfolioHistory(currentBalance: number): Record<Timeframe, PortfolioPoint[]> {
  const result = {} as Record<Timeframe, PortfolioPoint[]>;

  for (const timeframe of TIMEFRAMES) {
    const { points, volatilityFactor, seed } = TIMEFRAME_SPECS[timeframe];
    const base = currentBalance > 0 ? currentBalance * 0.82 : 1;
    const volatility = base * volatilityFactor;
    const values = generateWalk(seed, points, volatility, base);
    values[values.length - 1] = currentBalance;

    const labels = buildLabels(timeframe, points);
    result[timeframe] = values.map((value, i) => ({ value, label: labels[i] }));
  }

  return result;
}

/**
 * Resamples a series to exactly `count` points via linear interpolation
 * over index-space. Every timeframe is resampled to the same fixed count so
 * their Skia paths always share the same vertex structure — a prerequisite
 * for `SkPath.interpolate` to morph smoothly between them.
 */
export function resamplePoints(points: PortfolioPoint[], count: number): PortfolioPoint[] {
  if (points.length === 0) return [];
  if (points.length === count) return points;

  const result: PortfolioPoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (points.length - 1);
    const lowerIndex = Math.floor(t);
    const frac = t - lowerIndex;
    const lower = points[lowerIndex];
    const upper = points[Math.min(lowerIndex + 1, points.length - 1)];
    result.push({
      value: lower.value + (upper.value - lower.value) * frac,
      label: frac < 0.5 ? lower.label : upper.label,
    });
  }
  return result;
}

export function percentChange(points: PortfolioPoint[]): number {
  if (points.length < 2) return 0;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}
