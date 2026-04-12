import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * "Nadaraya-Watson" locator (kept the upstream name despite the misnomer —
 * this is really inverse-distance-squared weighted averaging of node
 * positions, matching what ESPresense-companion ships).
 *
 * Algorithm:
 *   - For each node, weight = 1 / (distance² + ε)
 *   - Estimated position = Σ(weight_i · node_i) / Σ(weight_i)
 *   - For ≥3 nodes, also compute weighted RMS residual between
 *     estimated-to-node distances and measured distances; lower residual
 *     means a more self-consistent fit.
 *   - For 2 nodes, fall back to the midpoint of the two closest nodes
 *     (matches upstream behavior).
 *
 * Closed-form, single-pass, no iteration.
 */
const EPSILON = 1e-6;

/**
 * Sigma for the asymmetric reliability function. A positive residual of
 * `ASYM_SIGMA` meters gets halved in weight; `2×ASYM_SIGMA` gets ¼.
 * Negative residuals (underestimates / line-of-sight) are never penalized.
 */
const ASYM_SIGMA = 1.5;

/** Number of asymmetric reweight iterations within a single solve. */
const ASYM_ITERS = 4;

export class NadarayaWatsonLocator implements Locator {
  readonly name = "nadaraya_watson";

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length === 0) return null;

    if (fixes.length < 3) {
      const sorted = [...fixes].sort((a, b) => a.distance - b.distance);
      const a = sorted[0];
      const b = sorted[1] ?? sorted[0];
      return {
        x: (a.point[0] + b.point[0]) / 2,
        y: (a.point[1] + b.point[1]) / 2,
        z: (a.point[2] + b.point[2]) / 2,
        confidence: 0.2,
        fixes: fixes.length,
        algorithm: this.name,
      };
    }

    // Per-fix reliability multiplier, starts at 1.0 for everyone.
    const reliability = new Float64Array(fixes.length).fill(1);

    let x = 0;
    let y = 0;
    let z = 0;

    // Iterative asymmetric reweight: solve → penalize overestimates
    // → re-solve. Each iteration shifts the position away from body-
    // blocked nodes, which reveals their true overestimate from the
    // new vantage point and further reduces their weight.
    for (let iter = 0; iter <= ASYM_ITERS; iter++) {
      let totalW = 0;
      let wx = 0;
      let wy = 0;
      let wz = 0;

      for (let i = 0; i < fixes.length; i++) {
        const f = fixes[i];
        let w = 1 / (f.distance * f.distance + EPSILON);
        // Variance penalty (catches intermittent body-shadow).
        if (f.distanceVariance != null && f.distanceVariance > 0) {
          w /= 1 + f.distanceVariance;
        }
        // Asymmetric reliability from previous iteration.
        w *= reliability[i];
        totalW += w;
        wx += w * f.point[0];
        wy += w * f.point[1];
        wz += w * f.point[2];
      }

      if (totalW <= 0 || !Number.isFinite(totalW)) return null;
      x = wx / totalW;
      y = wy / totalW;
      z = wz / totalW;

      // After solving, compute signed residuals and update reliability
      // for the next iteration. Only penalize POSITIVE residuals
      // (overestimates = body-shadow candidates). Negative residuals
      // (underestimates = line-of-sight) keep full weight.
      if (iter < ASYM_ITERS) {
        for (let i = 0; i < fixes.length; i++) {
          const f = fixes[i];
          const dx = x - f.point[0];
          const dy = y - f.point[1];
          const dz = z - f.point[2];
          const expected = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const residual = f.distance - expected; // positive = overestimate
          if (residual > 0) {
            // Multiplicative Cauchy penalty: each iteration where a
            // node overestimates further reduces its weight. A node
            // that consistently overestimates by +2m across 4 iterations
            // ends up with weight ~0.02 (effectively zeroed out), even
            // though any single iteration only penalizes to ~0.36.
            // This breaks the bootstrap: each iteration shifts the
            // position slightly, revealing more of the overestimate,
            // which crushes the weight further.
            reliability[i] *= 1 / (1 + (residual / ASYM_SIGMA) ** 2);
          }
          // Negative residuals (underestimates / line-of-sight): no
          // penalty applied — reliability stays at its current level.
        }
      }
    }

    // Final weighted RMS residual for confidence scoring.
    let weightedSqResidual = 0;
    let residualW = 0;
    for (let i = 0; i < fixes.length; i++) {
      const f = fixes[i];
      const dx = x - f.point[0];
      const dy = y - f.point[1];
      const dz = z - f.point[2];
      const calcDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const residual = calcDist - f.distance;
      let w = 1 / (f.distance * f.distance + EPSILON);
      if (f.distanceVariance != null && f.distanceVariance > 0) {
        w /= 1 + f.distanceVariance;
      }
      w *= reliability[i];
      weightedSqResidual += w * residual * residual;
      residualW += w;
    }
    const rmse = Math.sqrt(weightedSqResidual / residualW);

    const fitScore = 1 / (1 + rmse / 2);
    const fixScore = Math.min(1, fixes.length / 6);
    const confidence = Math.max(0, Math.min(1, fitScore * 0.7 + fixScore * 0.3));

    return {
      x,
      y,
      z,
      confidence,
      fixes: fixes.length,
      algorithm: this.name,
    };
  }
}
