import type { Locator, LocatorResult, NodeFix } from "./types";
import { NadarayaWatsonLocator } from "./nadaraya_watson";

/**
 * Nelder-Mead trilateration locator.
 *
 * Solves the indoor positioning problem as a robust weighted least-squares
 * fit using the derivative-free Nelder-Mead simplex method. The objective is
 *   minimize Σ w_i · ρ(||p − node_i|| − measured_d_i)
 * where:
 *   - w_i = 1 / (d_i² + ε)  — close fixes are more reliable, give them more
 *     pull. Real RSSI distances at 8m+ are noisy and shouldn't dominate.
 *   - ρ is the Huber loss — quadratic for small residuals (precise fitting
 *     where the data is good) and linear past δ (one outlier measurement
 *     doesn't drag the whole fit). Without this, a single ghost reflection
 *     reading 12m can pull the position halfway across the floor.
 *
 * Notes vs upstream:
 *   - 2D only (x, y). Z is poorly observable from BLE distances since most
 *     nodes sit at similar heights, so we just inherit the IDW Z. Adding Z
 *     to the optimizer makes the problem ill-conditioned.
 *   - No global scale factor (upstream optimizes a 4th variable). Skipping
 *     it keeps the problem well-posed; per-node RSSI calibration belongs
 *     in the calibration layer, not the locator.
 *   - Seeded from IDW so the optimizer converges in a handful of iterations
 *     rather than wandering from a random start.
 */
const HUBER_DELTA = 1.5; // meters — residuals beyond this get linear loss
export class NelderMeadLocator implements Locator {
  readonly name = "nelder_mead";
  private readonly seedLocator = new NadarayaWatsonLocator();

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    const seed = this.seedLocator.solve(fixes);
    if (!seed) return null;

    // Need at least 3 fixes to triangulate in 2D. With fewer, the IDW
    // fallback (midpoint or single-node) is the best we can do.
    if (fixes.length < 3) return seed;

    const result = nelderMead2D(
      (p) => weightedHuberObjective(p, fixes),
      [seed.x, seed.y],
    );

    // Confidence: compute RMS of *unweighted* residuals against the final
    // position, so the score reflects "how well does this position explain
    // the raw measurements" rather than the weighted optimization value.
    const rms = unweightedRms([result.x[0], result.x[1]], fixes);
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

/**
 * Weighted Huber loss objective for the optimizer. Closer fixes get more
 * weight (1/d²) and large residuals fall back to linear loss so a single
 * outlier reading can't dominate.
 */
function weightedHuberObjective(
  p: [number, number],
  fixes: readonly NodeFix[],
): number {
  let sum = 0;
  for (const f of fixes) {
    const dx = p[0] - f.point[0];
    const dy = p[1] - f.point[1];
    const calc = Math.sqrt(dx * dx + dy * dy);
    const r = calc - f.distance;
    const absR = Math.abs(r);
    const lossR =
      absR <= HUBER_DELTA
        ? 0.5 * r * r
        : HUBER_DELTA * (absR - 0.5 * HUBER_DELTA);
    const w = 1 / (f.distance * f.distance + 1e-6);
    sum += w * lossR;
  }
  return sum;
}

/** Unweighted RMS residual — used for the confidence score, not the fit. */
function unweightedRms(
  p: [number, number],
  fixes: readonly NodeFix[],
): number {
  let sumSq = 0;
  for (const f of fixes) {
    const dx = p[0] - f.point[0];
    const dy = p[1] - f.point[1];
    const calc = Math.sqrt(dx * dx + dy * dy);
    const r = calc - f.distance;
    sumSq += r * r;
  }
  return Math.sqrt(sumSq / fixes.length);
}

interface NelderMeadOptions {
  maxIter: number;
  tol: number;
  step: number;
  alpha: number; // reflection
  gamma: number; // expansion
  rho: number; // contraction
  sigma: number; // shrink
}

interface NelderMeadResult {
  x: [number, number];
  value: number;
  iter: number;
  reason: "tolerance" | "max-iter";
}

const DEFAULT_OPTS: NelderMeadOptions = {
  maxIter: 200,
  tol: 5e-3, // 5mm
  step: 1.0, // 1m initial simplex side
  alpha: 1.0,
  gamma: 2.0,
  rho: 0.5,
  sigma: 0.5,
};

/**
 * 2D Nelder-Mead simplex optimizer. Generic enough that we could lift it,
 * but kept here since it's the only place we currently need it. Specialized
 * to 2D for clarity and a touch of speed (no allocation in inner loops).
 */
export function nelderMead2D(
  f: (p: [number, number]) => number,
  x0: readonly [number, number],
  optsOverride: Partial<NelderMeadOptions> = {},
): NelderMeadResult {
  const o = { ...DEFAULT_OPTS, ...optsOverride };

  type Vertex = { x: [number, number]; v: number };
  const simplex: [Vertex, Vertex, Vertex] = [
    { x: [x0[0], x0[1]], v: f([x0[0], x0[1]]) },
    {
      x: [x0[0] + o.step, x0[1]],
      v: f([x0[0] + o.step, x0[1]]),
    },
    {
      x: [x0[0], x0[1] + o.step],
      v: f([x0[0], x0[1] + o.step]),
    },
  ];

  let iter = 0;
  for (; iter < o.maxIter; iter++) {
    // Sort: best (lowest f) first.
    simplex.sort((a, b) => a.v - b.v);

    // Termination: max distance from best vertex to any other vertex.
    const dx1 = simplex[1].x[0] - simplex[0].x[0];
    const dy1 = simplex[1].x[1] - simplex[0].x[1];
    const dx2 = simplex[2].x[0] - simplex[0].x[0];
    const dy2 = simplex[2].x[1] - simplex[0].x[1];
    const maxSpread = Math.max(
      Math.sqrt(dx1 * dx1 + dy1 * dy1),
      Math.sqrt(dx2 * dx2 + dy2 * dy2),
    );
    if (maxSpread < o.tol) {
      return { x: [...simplex[0].x], value: simplex[0].v, iter, reason: "tolerance" };
    }

    // Centroid of all but worst (i.e. best + second best).
    const cx = (simplex[0].x[0] + simplex[1].x[0]) / 2;
    const cy = (simplex[0].x[1] + simplex[1].x[1]) / 2;
    const worst = simplex[2];

    // Reflection.
    const xrX = cx + o.alpha * (cx - worst.x[0]);
    const xrY = cy + o.alpha * (cy - worst.x[1]);
    const fr = f([xrX, xrY]);

    if (fr >= simplex[0].v && fr < simplex[1].v) {
      simplex[2] = { x: [xrX, xrY], v: fr };
      continue;
    }

    // Expansion.
    if (fr < simplex[0].v) {
      const xeX = cx + o.gamma * (xrX - cx);
      const xeY = cy + o.gamma * (xrY - cy);
      const fe = f([xeX, xeY]);
      simplex[2] =
        fe < fr ? { x: [xeX, xeY], v: fe } : { x: [xrX, xrY], v: fr };
      continue;
    }

    // Contraction (fr >= second-worst).
    if (fr < worst.v) {
      // Outside contraction.
      const xcX = cx + o.rho * (xrX - cx);
      const xcY = cy + o.rho * (xrY - cy);
      const fc = f([xcX, xcY]);
      if (fc <= fr) {
        simplex[2] = { x: [xcX, xcY], v: fc };
        continue;
      }
    } else {
      // Inside contraction.
      const xcX = cx + o.rho * (worst.x[0] - cx);
      const xcY = cy + o.rho * (worst.x[1] - cy);
      const fc = f([xcX, xcY]);
      if (fc < worst.v) {
        simplex[2] = { x: [xcX, xcY], v: fc };
        continue;
      }
    }

    // Shrink toward best.
    for (let i = 1; i < 3; i++) {
      const nx: [number, number] = [
        simplex[0].x[0] + o.sigma * (simplex[i].x[0] - simplex[0].x[0]),
        simplex[0].x[1] + o.sigma * (simplex[i].x[1] - simplex[0].x[1]),
      ];
      simplex[i] = { x: nx, v: f(nx) };
    }
  }

  simplex.sort((a, b) => a.v - b.v);
  return {
    x: [...simplex[0].x],
    value: simplex[0].v,
    iter,
    reason: "max-iter",
  };
}
