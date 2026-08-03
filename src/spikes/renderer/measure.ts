/**
 * Frame-time and one-shot timing for the spike renderer (3D rendering spike
 * Task 7). Disposable spike code: never imported by production modules.
 */

/** Rolling frame-time stats over the last `RING_CAPACITY` render frames. */
export interface FrameMeter {
  /** Record one frame duration in milliseconds. */
  sample(ms: number): void;
  /** Exact percentiles over the buffered samples (see `createFrameMeter`). */
  percentiles(): { p50: number; p95: number; count: number };
}

/** Ring buffer size: 600 samples ≈ 10 s at 60 fps. */
const RING_CAPACITY = 600;

/**
 * Ring buffer of the last 600 frame durations. Percentiles are exact: the
 * buffer is copied into a fresh array on every query and sorted, then read at
 * the nearest-rank position (p50 at `ceil(0.5n)`, p95 at `ceil(0.95n)`).
 */
export function createFrameMeter(): FrameMeter {
  const samples = new Float64Array(RING_CAPACITY);
  let cursor = 0;
  let count = 0;

  function sample(ms: number): void {
    samples[cursor] = ms;
    cursor = (cursor + 1) % RING_CAPACITY;
    if (count < RING_CAPACITY) {
      count += 1;
    }
  }

  function percentile(sorted: Float64Array, quantile: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    // Nearest-rank: the ceil(q·n)-th smallest sample (1-based rank).
    const rank = Math.max(1, Math.ceil(quantile * sorted.length));
    return sorted[rank - 1]!;
  }

  function percentiles(): { p50: number; p95: number; count: number } {
    const sorted = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      // Ring order: `cursor` already points one past the newest sample, so
      // walking `count` slots back yields the oldest buffered sample first.
      const index = (cursor - count + i + RING_CAPACITY) % RING_CAPACITY;
      sorted[i] = samples[index]!;
    }
    sorted.sort();
    return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), count };
  }

  return { sample, percentiles };
}

/**
 * Time a synchronous operation, returning its value and elapsed milliseconds.
 * `label` names a `performance.measure` entry so decode/upload timings are
 * inspectable in DevTools performance traces.
 */
export function measureOnce<T>(label: string, fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  const end = performance.now();
  performance.measure(label, { start, end });
  return { value, ms: end - start };
}

/**
 * Async sibling of `measureOnce` for the decode path: `loadScene` awaits wasm
 * initialization, so its wall time is only observable around an `await`, which
 * a synchronous `measureOnce` cannot express.
 */
export async function measureOnceAsync<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  const end = performance.now();
  performance.measure(label, { start, end });
  return { value, ms: end - start };
}
