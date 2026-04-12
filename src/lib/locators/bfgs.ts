import { NadarayaWatsonLocator } from "./nadaraya_watson";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * BFGS quasi-Newton trilateration locator.
 *
 * Minimizes the same weighted-least-squares objective as NM
 * (`Σ w_i (||p − n_i|| − d_i)²` with `w_i = 1/d_i²`), but uses BFGS
 * — a quasi-Newton method that approximates the inverse Hessian and
 * generally converges in fewer iterations than Nelder-Mead simplex.
 *
 * Both the objective and its analytic gradient are cheap to compute,
 * so the implementation is fully self-contained — no Math.js needed.
 *
 * Seeded from IDW for fast convergence; falls back to the IDW result
 * for fewer than 3 fixes.
 */
export class BFGSLocator implements Locator {
  readonly name = "bfgs";
  private readonly seedLocator = new NadarayaWatsonLocator();

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    const seed = this.seedLocator.solve(fixes);
    if (!seed) return null;
    if (fixes.length < 3) return seed;

    const result = bfgs2D(
      (p) => objective(p, fixes),
      (p) => gradient(p, fixes),
      [seed.x, seed.y],
    );

    const rms = Math.sqrt(unweightedSqResidual([result.x[0], result.x[1]], fixes) / fixes.length);
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
 * Sigma for the asymmetric Cauchy penalty on positive residuals.
 * Overestimates (body-shadow) > sigma get progressively down-weighted
 * in the objective, so the optimizer converges toward the line-of-
 * sight consensus rather than trying to satisfy body-blocked nodes.
 */
const ASYM_SIGMA = 1.5;

function fixWeight(f: NodeFix): number {
  let w = 1 / (f.distance * f.distance + 1e-6);
  if (f.distanceVariance != null && f.distanceVariance > 0) {
    w /= 1 + f.distanceVariance;
  }
  return w;
}

/**
 * Asymmetric weight for a signed residual. Positive residuals
 * (overestimates = body-shadow candidates) get a Cauchy penalty.
 * Negative residuals (underestimates = line-of-sight) get full weight.
 */
function asymWeight(residual: number): number {
  if (residual <= 0) return 1;
  return 1 / (1 + (residual / ASYM_SIGMA) ** 2);
}

function objective(p: [number, number], fixes: readonly NodeFix[]): number {
  let sum = 0;
  for (const f of fixes) {
    const dx = p[0] - f.point[0];
    const dy = p[1] - f.point[1];
    const calc = Math.sqrt(dx * dx + dy * dy);
    const r = calc - f.distance;
    // Asymmetric: overestimates (r > 0 means calc > measured, but we
    // want to penalize when MEASURED > EXPECTED, i.e. distance - calc > 0)
    const signedResidual = f.distance - calc; // positive = overestimate
    sum += fixWeight(f) * asymWeight(signedResidual) * r * r;
  }
  return sum;
}

function gradient(
  p: [number, number],
  fixes: readonly NodeFix[],
): [number, number] {
  let gx = 0;
  let gy = 0;
  for (const f of fixes) {
    const dx = p[0] - f.point[0];
    const dy = p[1] - f.point[1];
    const calc = Math.sqrt(dx * dx + dy * dy);
    if (calc < 1e-9) continue;
    const r = calc - f.distance;
    const signedResidual = f.distance - calc;
    const factor = (2 * fixWeight(f) * asymWeight(signedResidual) * r) / calc;
    gx += factor * dx;
    gy += factor * dy;
  }
  return [gx, gy];
}

function unweightedSqResidual(
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
  return sumSq;
}

interface BFGSResult {
  x: [number, number];
  value: number;
  iter: number;
  reason: "gradient" | "step" | "max-iter";
}

/**
 * Generic 2D BFGS minimizer with backtracking line search and analytic
 * gradient. The inverse-Hessian approximation is a 2×2 matrix stored as
 * a flat 4-element array `[B00, B01, B10, B11]`.
 */
function bfgs2D(
  f: (p: [number, number]) => number,
  grad: (p: [number, number]) => [number, number],
  x0: readonly [number, number],
  maxIter = 50,
  tolerance = 1e-5,
): BFGSResult {
  let B: [number, number, number, number] = [1, 0, 0, 1];
  let x: [number, number] = [x0[0], x0[1]];
  let g = grad(x);
  let value = f(x);

  for (let k = 0; k < maxIter; k++) {
    const gNorm = Math.sqrt(g[0] * g[0] + g[1] * g[1]);
    if (gNorm < tolerance) {
      return { x, value, iter: k, reason: "gradient" };
    }

    // Search direction p = -B · g
    const px = -(B[0] * g[0] + B[1] * g[1]);
    const py = -(B[2] * g[0] + B[3] * g[1]);

    // Backtracking line search (Armijo condition)
    let alpha = 1;
    const c1 = 1e-4;
    const dirGrad = g[0] * px + g[1] * py;
    let newValue = f([x[0] + alpha * px, x[1] + alpha * py]);
    let lsIter = 0;
    while (
      newValue > value + c1 * alpha * dirGrad &&
      lsIter < 30 &&
      alpha > 1e-12
    ) {
      alpha *= 0.5;
      newValue = f([x[0] + alpha * px, x[1] + alpha * py]);
      lsIter++;
    }

    const sx = alpha * px;
    const sy = alpha * py;
    const sNorm = Math.sqrt(sx * sx + sy * sy);
    if (sNorm < tolerance) {
      return { x, value, iter: k, reason: "step" };
    }

    const xNew: [number, number] = [x[0] + sx, x[1] + sy];
    const gNew = grad(xNew);
    const yx = gNew[0] - g[0];
    const yy = gNew[1] - g[1];

    // BFGS inverse-Hessian update.
    const ys = yx * sx + yy * sy;
    if (Math.abs(ys) > 1e-10) {
      const rho = 1 / ys;
      // V = I − ρ·s·yᵀ
      const v00 = 1 - rho * sx * yx;
      const v01 = -rho * sx * yy;
      const v10 = -rho * sy * yx;
      const v11 = 1 - rho * sy * yy;
      // V·B
      const vb00 = v00 * B[0] + v01 * B[2];
      const vb01 = v00 * B[1] + v01 * B[3];
      const vb10 = v10 * B[0] + v11 * B[2];
      const vb11 = v10 * B[1] + v11 * B[3];
      // Vᵀ = I − ρ·y·sᵀ
      const vt00 = 1 - rho * yx * sx;
      const vt01 = -rho * yx * sy;
      const vt10 = -rho * yy * sx;
      const vt11 = 1 - rho * yy * sy;
      // (V·B)·Vᵀ
      const vbvt00 = vb00 * vt00 + vb01 * vt10;
      const vbvt01 = vb00 * vt01 + vb01 * vt11;
      const vbvt10 = vb10 * vt00 + vb11 * vt10;
      const vbvt11 = vb10 * vt01 + vb11 * vt11;
      // + ρ·s·sᵀ
      B = [
        vbvt00 + rho * sx * sx,
        vbvt01 + rho * sx * sy,
        vbvt10 + rho * sy * sx,
        vbvt11 + rho * sy * sy,
      ];
    }

    x = xNew;
    g = gNew;
    value = newValue;
  }

  return { x, value, iter: maxIter, reason: "max-iter" };
}
