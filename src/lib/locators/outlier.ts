import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Robust outlier rejection for trilateration fixes.
 *
 * Failure mode this addresses: a single flaky node (lost line-of-sight,
 * multipath, stale firmware) reports a wildly wrong distance. The base
 * locator dutifully tries to fit everyone, and the bad reading drags the
 * solution off into the wrong room. Every other node is screaming "master
 * bedroom" but the one outlier is pulling us into the garage.
 *
 * The fix: compute per-fix residuals at the base locator's initial
 * solution, identify fixes whose residual is a robust outlier vs the
 * consensus, drop them, and re-solve on the filtered set.
 *
 * Why MAD instead of stddev: the classical "mean ± k·σ" test is corrupted
 * by the very outliers it's trying to detect. A single 15 m phantom
 * reading inflates σ until the test is meaningless. The median absolute
 * deviation (MAD) stays small even with outliers present — it's the
 * standard statistical tool for exactly this problem. Scaled by 1.4826
 * it's a consistent estimator of σ for normal data.
 */

/** MAD → σ scaling for a normal distribution. 1 / Φ⁻¹(3/4). */
const MAD_TO_SIGMA = 1.4826;

/** Robust z-score threshold (analogous to "3 σ"). */
const MAD_K = 3;

/** Min fixes before rejection kicks in — MAD is too noisy below this. */
const MIN_FIXES_FOR_REJECTION = 5;

/** Never let the active set drop below this many fixes. */
const MIN_REMAINING = 3;

/**
 * Absolute residual floor in meters. Don't reject a fix whose absolute
 * residual is below this, regardless of its robust z-score — when the
 * base locator converges tightly, small deviations aren't outliers,
 * they're just noise.
 */
const MIN_RESIDUAL_METERS = 1.0;

/** Max fraction of fixes we're willing to drop in one pass. */
const MAX_DROP_FRACTION = 0.3;

/**
 * Compute per-fix absolute residuals at `solution` and return the subset
 * of fixes whose residuals look statistically normal. See module doc for
 * the method and thresholds.
 */
export function rejectOutliers(
  fixes: readonly NodeFix[],
  solution: readonly [number, number, number],
): NodeFix[] {
  if (fixes.length < MIN_FIXES_FOR_REJECTION) return [...fixes];

  const residuals = fixes.map((f) => {
    const dx = solution[0] - f.point[0];
    const dy = solution[1] - f.point[1];
    const dz = solution[2] - f.point[2];
    const calc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return { fix: f, absRes: Math.abs(calc - f.distance) };
  });

  const resValues = residuals.map((r) => r.absRes);
  const medRes = median(resValues);
  const deviations = resValues.map((r) => Math.abs(r - medRes));
  const mad = median(deviations);
  const sigma = MAD_TO_SIGMA * mad;

  // All residuals identical — nothing to reject.
  if (sigma < 1e-6) return [...fixes];

  const threshold = Math.max(
    MIN_RESIDUAL_METERS,
    medRes + MAD_K * sigma,
  );

  const maxByFraction = Math.floor(fixes.length * MAX_DROP_FRACTION);
  const maxByMin = fixes.length - MIN_REMAINING;
  const allowedDrops = Math.min(maxByFraction, maxByMin);
  if (allowedDrops <= 0) return [...fixes];

  // Walk worst → best, dropping until we hit a fix below threshold or
  // exhaust our drop budget.
  const sortedDesc = [...residuals].sort((a, b) => b.absRes - a.absRes);
  const toDrop = new Set<NodeFix>();
  for (const r of sortedDesc) {
    if (toDrop.size >= allowedDrops) break;
    if (r.absRes > threshold) toDrop.add(r.fix);
    else break;
  }

  if (toDrop.size === 0) return [...fixes];
  return fixes.filter((f) => !toDrop.has(f));
}

function median(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Wraps any Locator with robust outlier rejection. Does a first solve,
 * identifies fixes whose residuals are statistical outliers, drops them,
 * and re-solves on the filtered set. If the second solve fails for any
 * reason, falls back to the first solve so we never return worse than
 * the un-rejected baseline.
 *
 * The wrapped locator's `name` is preserved so downstream code (API,
 * UI) still sees the original algorithm label.
 */
export class OutlierRejectingLocator implements Locator {
  readonly name: string;

  constructor(private readonly inner: Locator) {
    this.name = inner.name;
  }

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    const first = this.inner.solve(fixes);
    if (!first) return null;
    if (fixes.length < MIN_FIXES_FOR_REJECTION) return first;

    const filtered = rejectOutliers(fixes, [first.x, first.y, first.z]);
    if (filtered.length === fixes.length) return first;

    const second = this.inner.solve(filtered);
    return second ?? first;
  }
}
