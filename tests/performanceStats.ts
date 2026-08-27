/**
 * Shared timing helpers for the viewer performance suite.
 *
 * Architecture §11's 150ms warm floor-change P95 is a workstation budget.
 * Nearest-rank P95 of n=30 is the 2nd-worst sample, so two compositor/GC
 * spikes fail that gate even when the other 28 observations have not moved.
 */
export function percentileNearestRank(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    throw new Error("percentileNearestRank: empty samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[clamped]!;
}

/** Architecture §11: warm floor change P95 on a workstation-class machine. */
export const LEVEL_CHANGE_WORKSTATION_P95_MS = 150;

/**
 * CI P95 after the full acceptance suite on ubuntu-latest. The same
 * ~55–80ms-above-baseline spike pattern that passed at 129ms on
 * feat/jr-ticket-gate failed at 162ms on a slower runner; 180ms keeps those
 * two tail samples from failing the job without hiding a stall.
 */
export const LEVEL_CHANGE_CI_P95_MS = 180;

/**
 * Typical floor-change work on the minimal fixture is ~70–90ms. A median
 * above this means the body of the distribution moved, not just the tail.
 */
export const LEVEL_CHANGE_CI_MEDIAN_MS = 120;
