import { NadarayaWatsonLocator } from "./nadaraya_watson";
import { nelderMead2D } from "./nelder_mead";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Maximum-likelihood trilateration locator.
 *
 * The path-loss model produces measurement errors that scale roughly
 * linearly with distance (in absolute terms — a node at 10m is more
 * uncertain than one at 1m, but not as much as 1/d² weighting implies).
 * The MLE locator assumes Gaussian noise with variance ∝ distance, so
 * the maximum-likelihood objective becomes weighted least squares with
 * `w_i = 1 / d_i`.
 *
 * Compared to NM (which uses `1/d²` weighting and Huber loss):
 *  - More moderate weighting — far measurements still contribute
 *    meaningfully instead of being almost ignored
 *  - Pure squared loss, no Huber clipping
 *  - Same Nelder-Mead simplex solver underneath
 *
 * Useful as a comparison point: with very clean RSSI data, MLE often
 * matches NM or BFGS. With noisy data, NM tends to win because of its
 * Huber outlier rejection.
 */
export class MLELocator implements Locator {
  readonly name = "mle";
  private readonly seedLocator = new NadarayaWatsonLocator();

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    const seed = this.seedLocator.solve(fixes);
    if (!seed) return null;
    if (fixes.length < 3) return seed;

    const result = nelderMead2D(
      (p) => mleObjective(p, fixes),
      [seed.x, seed.y],
    );

    let sumSq = 0;
    for (const f of fixes) {
      const dx = result.x[0] - f.point[0];
      const dy = result.x[1] - f.point[1];
      const calc = Math.sqrt(dx * dx + dy * dy);
      const r = calc - f.distance;
      sumSq += r * r;
    }
    const rms = Math.sqrt(sumSq / fixes.length);
    const fitScore = 1 / (1 + rms / 1.5);
    const fixScore = Math.min(1, fixes.length / 6);
    const confidence = Math.max(
      0,
      Math.min(1, fitScore * 0.7 + fixScore * 0.3),
    );

    return {
      x: result.x[0],
      y: result.x[1],
      z: seed.z,
      confidence,
      fixes: fixes.length,
      algorithm: this.name,
    };
  }
}

function mleObjective(
  p: [number, number],
  fixes: readonly NodeFix[],
): number {
  let sum = 0;
  for (const f of fixes) {
    const dx = p[0] - f.point[0];
    const dy = p[1] - f.point[1];
    const calc = Math.sqrt(dx * dx + dy * dy);
    const r = calc - f.distance;
    // Variance ∝ distance → weight = 1 / distance
    const w = 1 / (f.distance + 1e-6);
    sum += w * r * r;
  }
  return sum;
}
