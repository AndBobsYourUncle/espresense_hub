import { getStore, type Store } from "@/lib/state/store";
import { NadarayaWatsonLocator } from "./nadaraya_watson";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Environment-aware locator.
 *
 * A unified solver that finds the position best explaining the raw
 * measurements given what we know about the RF environment. Instead
 * of "correct the distances then trilaterate" (PathAware's approach),
 * this builds the calibration model INTO the objective function:
 *
 * For each node N at candidate position p:
 *
 *     d_true(p) = |p − N|
 *     d_expected(p) = d_true(p) ^ (n_effective(p, N) / n_firmware(N))
 *
 * Where n_effective is interpolated from per-pair calibration data
 * using the same direction + distance matching that PathAware used —
 * but applied as part of the forward model, not as a pre-processing
 * correction. The solver minimizes:
 *
 *     Σ w_i × (d_measured_i − d_expected_i(p))²
 *
 * Solved via BFGS with analytic gradient. The n_effective values are
 * recomputed at each BFGS iteration as the position estimate moves,
 * so the calibration "field" naturally adapts to the candidate.
 *
 * Weights incorporate:
 *   - 1/d² base (closer measurements are more informative)
 *   - Per-pair R² (trust well-calibrated paths more)
 *   - Distance variance (trust stable readings more)
 *   - Asymmetric penalty (overestimates are less trustworthy)
 */

const MAX_OUTER_ITERS = 4;
const BFGS_MAX_ITERS = 30;
const BFGS_TOL = 1e-4;
const ASYM_SIGMA = 1.5;
const CONVERGENCE_THRESHOLD = 0.05;

/** Minimum R² for a pair fit to be considered in path matching. */
const MIN_PAIR_R2 = 0.25;

/** Distance tolerance for path matching (same as PathAware). */
const DIST_TOLERANCE_M = 3;

/** Match confidence scale (same as PathAware). */
const MATCH_SCALE = 1.0;

export class EnvironmentAwareLocator implements Locator {
  readonly name = "environment_aware";
  private readonly seedLocator = new NadarayaWatsonLocator();

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    const seed = this.seedLocator.solve(fixes);
    if (!seed) return null;
    if (fixes.length < 3) return seed;

    const store = getStore();
    let pos: [number, number] = [seed.x, seed.y];

    // Outer loop: recompute n_effective at the current position
    // estimate, then run BFGS to refine. Each outer iteration updates
    // the calibration field to match the new candidate position.
    for (let outer = 0; outer < MAX_OUTER_ITERS; outer++) {
      const envFixes = buildEnvironmentFixes(fixes, pos, store);
      const result = bfgs2D(envFixes, pos);
      const dx = result[0] - pos[0];
      const dy = result[1] - pos[1];
      pos = result;
      if (Math.sqrt(dx * dx + dy * dy) < CONVERGENCE_THRESHOLD) break;
    }

    // Final scoring: compute weighted residuals at the converged
    // position for confidence.
    const envFixes = buildEnvironmentFixes(fixes, pos, store);
    let sumSqRes = 0;
    let sumW = 0;
    let agreeCount = 0;
    for (const ef of envFixes) {
      const dTrue = dist2D(pos, ef.nodePoint);
      const dExpected = forwardModel(dTrue, ef.nEffective, ef.nFirmware);
      const residual = ef.measured - dExpected;
      const w = ef.weight;
      sumSqRes += w * residual * residual;
      sumW += w;
      if (Math.abs(residual) < 1.5) agreeCount++;
    }
    const rmse = sumW > 0 ? Math.sqrt(sumSqRes / sumW) : 5;
    const fitScore = 1 / (1 + rmse / 3);
    const agreeScore = agreeCount / fixes.length;
    const fixScore = Math.min(1, fixes.length / 6);
    const confidence = Math.max(
      0,
      Math.min(1, fitScore * 0.45 + agreeScore * 0.30 + fixScore * 0.25),
    );

    return {
      x: pos[0],
      y: pos[1],
      z: seed.z,
      confidence,
      fixes: fixes.length,
      algorithm: this.name,
    };
  }
}

// ─── Forward model ──────────────────────────────────────────────────────

/**
 * Predict what a node would measure at true distance d_true, given the
 * path's effective absorption n_real and the node's firmware absorption.
 *
 *     d_expected = d_true ^ (n_real / n_firmware)
 *
 * When n_real > n_firmware (more attenuation than firmware assumes),
 * d_expected > d_true (firmware overestimates distance).
 */
function forwardModel(
  dTrue: number,
  nEffective: number,
  nFirmware: number,
): number {
  if (dTrue <= 0 || nFirmware <= 0 || nEffective <= 0) return dTrue;
  return Math.pow(dTrue, nEffective / nFirmware);
}

function dist2D(
  p: readonly [number, number],
  q: readonly [number, number],
): number {
  const dx = p[0] - q[0];
  const dy = p[1] - q[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Environment-enriched fixes ─────────────────────────────────────────

interface EnvFix {
  nodePoint: readonly [number, number];
  measured: number;
  nEffective: number;
  nFirmware: number;
  weight: number;
}

/**
 * For each fix, compute the n_effective at the current position
 * estimate using per-pair path matching, and assemble a weight that
 * combines base 1/d², R²-quality, variance, and asymmetric penalty.
 */
function buildEnvironmentFixes(
  fixes: readonly NodeFix[],
  pos: readonly [number, number],
  store: Store,
): EnvFix[] {
  return fixes.map((fix) => {
    // Node's firmware absorption.
    const absRaw = store.nodeSettings.get(fix.nodeId)?.get("absorption");
    const parsedAbs = absRaw != null ? parseFloat(absRaw) : NaN;
    const nFirmware =
      Number.isFinite(parsedAbs) && parsedAbs > 0.1 ? parsedAbs : 2.7;

    // Path-matched n_effective (same logic as PathAware's correction,
    // but computed here as part of the forward model).
    const nEffective = computeNEffective(fix, pos, store, nFirmware);

    // Base weight.
    let weight = 1 / (fix.distance * fix.distance + 1e-6);

    // Variance penalty.
    if (fix.distanceVariance != null && fix.distanceVariance > 0) {
      weight /= 1 + fix.distanceVariance;
    }

    // Asymmetric penalty: compute signed residual at current position.
    const dTrue = dist2D(pos, [fix.point[0], fix.point[1]]);
    const dExpected = forwardModel(dTrue, nEffective, nFirmware);
    const residual = fix.distance - dExpected;
    if (residual > 0) {
      weight *= 1 / (1 + (residual / ASYM_SIGMA) ** 2);
    }

    return {
      nodePoint: [fix.point[0], fix.point[1]] as const,
      measured: fix.distance,
      nEffective,
      nFirmware,
      weight,
    };
  });
}

/**
 * Compute n_effective for a fix at position `pos` using per-pair
 * calibration data. Same direction + distance matching as PathAware,
 * with confidence shrink toward n_firmware when no good match exists.
 */
function computeNEffective(
  fix: NodeFix,
  pos: readonly [number, number],
  store: Store,
  nFirmware: number,
): number {
  const pairFits = store.nodePairFits.get(fix.nodeId);
  if (!pairFits || pairFits.size === 0) return nFirmware;

  const lx = fix.point[0];
  const ly = fix.point[1];
  const ddx = pos[0] - lx;
  const ddy = pos[1] - ly;
  const dLD = Math.sqrt(ddx * ddx + ddy * ddy);
  if (dLD < 1e-6) return nFirmware;
  const uLDx = ddx / dLD;
  const uLDy = ddy / dLD;

  let weightedN = 0;
  let totalWeight = 0;
  for (const [txId, pairFit] of pairFits) {
    if (txId === fix.nodeId) continue;
    if (pairFit.nReal <= 0) continue;
    if (pairFit.rSquared < MIN_PAIR_R2) continue;
    const txPoint = store.nodeIndex.get(txId);
    if (!txPoint) continue;

    const tdx = txPoint[0] - lx;
    const tdy = txPoint[1] - ly;
    const dLT = Math.sqrt(tdx * tdx + tdy * tdy);
    if (dLT < 1e-6) continue;

    const cosSim = (tdx * uLDx + tdy * uLDy) / dLT;
    const dirWeight = cosSim > 0 ? cosSim * cosSim : 0;
    if (dirWeight <= 0) continue;

    const distWeight = Math.exp(
      -Math.abs(dLT - dLD) / DIST_TOLERANCE_M,
    );
    const weight = dirWeight * distWeight * pairFit.rSquared;
    if (weight <= 0) continue;
    weightedN += pairFit.nReal * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 1e-9) return nFirmware;
  const nInterpolated = weightedN / totalWeight;
  const matchConfidence = Math.min(1, totalWeight / MATCH_SCALE);
  return nFirmware + matchConfidence * (nInterpolated - nFirmware);
}

// ─── BFGS solver ────────────────────────────────────────────────────────

/**
 * 2D BFGS minimization of the forward-model objective. The objective
 * compares raw measured distances against what the model predicts at
 * candidate position p.
 *
 * Unlike the generic BFGS in bfgs.ts, this one has the RF forward
 * model baked in: the "expected" distance isn't just |p−node|, it's
 * |p−node|^(n_real/n_firmware). The gradient accounts for this.
 */
function bfgs2D(
  envFixes: readonly EnvFix[],
  x0: readonly [number, number],
): [number, number] {
  const obj = (p: [number, number]) => {
    let sum = 0;
    for (const ef of envFixes) {
      const dTrue = dist2D(p, ef.nodePoint);
      const dExp = forwardModel(dTrue, ef.nEffective, ef.nFirmware);
      const r = ef.measured - dExp;
      sum += ef.weight * r * r;
    }
    return sum;
  };

  const grad = (p: [number, number]): [number, number] => {
    let gx = 0;
    let gy = 0;
    for (const ef of envFixes) {
      const dx = p[0] - ef.nodePoint[0];
      const dy = p[1] - ef.nodePoint[1];
      const dTrue = Math.sqrt(dx * dx + dy * dy);
      if (dTrue < 1e-9) continue;

      const ratio = ef.nEffective / ef.nFirmware;
      const dExp = Math.pow(dTrue, ratio);
      const r = ef.measured - dExp;

      // ∂dExp/∂p = ratio × dTrue^(ratio-1) × (p−node)/dTrue
      //          = ratio × dExp / dTrue × (p−node)/dTrue
      const ddExp_ddTrue = ratio * dExp / dTrue;
      const ddTrue_dx = dx / dTrue;
      const ddTrue_dy = dy / dTrue;

      // ∂F/∂p = -2 × w × r × ∂dExp/∂p
      const factor = -2 * ef.weight * r * ddExp_ddTrue;
      gx += factor * ddTrue_dx;
      gy += factor * ddTrue_dy;
    }
    return [gx, gy];
  };

  // Standard BFGS with backtracking line search.
  let B: [number, number, number, number] = [1, 0, 0, 1];
  let x: [number, number] = [x0[0], x0[1]];
  let g = grad(x);
  let val = obj(x);

  for (let k = 0; k < BFGS_MAX_ITERS; k++) {
    const gNorm = Math.sqrt(g[0] * g[0] + g[1] * g[1]);
    if (gNorm < BFGS_TOL) break;

    const px = -(B[0] * g[0] + B[1] * g[1]);
    const py = -(B[2] * g[0] + B[3] * g[1]);

    let alpha = 1;
    const dirGrad = g[0] * px + g[1] * py;
    let newVal = obj([x[0] + alpha * px, x[1] + alpha * py]);
    let ls = 0;
    while (newVal > val + 1e-4 * alpha * dirGrad && ls < 20 && alpha > 1e-10) {
      alpha *= 0.5;
      newVal = obj([x[0] + alpha * px, x[1] + alpha * py]);
      ls++;
    }

    const sx = alpha * px;
    const sy = alpha * py;
    if (Math.sqrt(sx * sx + sy * sy) < BFGS_TOL) break;

    const xNew: [number, number] = [x[0] + sx, x[1] + sy];
    const gNew = grad(xNew);
    const yx = gNew[0] - g[0];
    const yy = gNew[1] - g[1];
    const ys = yx * sx + yy * sy;

    if (Math.abs(ys) > 1e-10) {
      const rho = 1 / ys;
      const v00 = 1 - rho * sx * yx;
      const v01 = -rho * sx * yy;
      const v10 = -rho * sy * yx;
      const v11 = 1 - rho * sy * yy;
      const vb00 = v00 * B[0] + v01 * B[2];
      const vb01 = v00 * B[1] + v01 * B[3];
      const vb10 = v10 * B[0] + v11 * B[2];
      const vb11 = v10 * B[1] + v11 * B[3];
      const vt00 = 1 - rho * yx * sx;
      const vt01 = -rho * yx * sy;
      const vt10 = -rho * yy * sx;
      const vt11 = 1 - rho * yy * sy;
      B = [
        vb00 * vt00 + vb01 * vt10 + rho * sx * sx,
        vb00 * vt01 + vb01 * vt11 + rho * sx * sy,
        vb10 * vt00 + vb11 * vt10 + rho * sy * sx,
        vb10 * vt01 + vb11 * vt11 + rho * sy * sy,
      ];
    }

    x = xNew;
    g = gNew;
    val = newVal;
  }

  return x;
}
