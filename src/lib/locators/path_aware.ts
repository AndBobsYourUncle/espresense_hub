import { getStore, type Store } from "@/lib/state/store";
import { rejectOutliers } from "./outlier";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Detailed breakdown of how the PathAware confidence number was derived.
 * Diagnostic helpers use this to explain the blended score to the user.
 */
export interface ConfidenceBreakdown {
  /** 1 / (1 + rmse/1.5). Primary signal. */
  fitScore: number;
  /** 4·det(M)/trace(M)² on the node-direction scatter. 1 = isotropic. */
  geomScore: number;
  /** Fraction of fixes whose listener has per-pair calibration. */
  coverageScore: number;
  /** min(1, fixes/6). */
  fixScore: number;
  /** Weighted RMSE that feeds fitScore, meters. */
  rmse: number;
  /** Final 0..1 value — what the UI shows in the confidence bar. */
  blended: number;
  /** True when a 0.9× multiplicative convergence penalty was applied. */
  convergencePenaltyApplied: boolean;
  /** Fix count after outlier rejection — what fitScore etc were computed on. */
  fixCount: number;
}

/**
 * Path-aware iterative locator.
 *
 * Wraps a base locator (typically IDW) and refines its position estimate
 * by accounting for **per-path** calibration data. Standard locators
 * assume a uniform signal-propagation environment — same path-loss
 * exponent everywhere. That's wrong for any real building: the path from
 * `living_room` to `kitchen` might propagate near free-space (n≈3) while
 * the path from `garage_2` to `master_bathroom` 5m away might attenuate
 * heavily through walls (n≈5.5).
 *
 * We've measured this directly via node-to-node observations, so for
 * every (listener, transmitter) pair we know the *actual* path-loss
 * exponent. This locator uses that data:
 *
 *   1. Get a rough position estimate from the base locator
 *   2. For each fix from listener N:
 *      - Find the *known transmitter* T whose position is closest to the
 *        current estimate (T acts as a proxy for "the calibration that
 *        applies to paths from N in this direction")
 *      - Look up the per-pair fit `n_real[N, T]`
 *      - Correct N's reported distance using the formula
 *        `d_real = d_measured ^ (n_assumed / n_real)`
 *   3. Re-run the base locator with the corrected distances
 *   4. If the position moved by less than the convergence threshold, done.
 *      Otherwise iterate using the new position as the next estimate.
 *
 * Falls back gracefully to the base locator's output when per-pair data
 * isn't available yet (e.g., after a fresh restart) — the wrapper just
 * returns the inner result unchanged.
 */
export class PathAwareLocator implements Locator {
  readonly name = "path_aware";

  constructor(
    private readonly inner: Locator,
    private readonly maxIterations = 4,
    /** Convergence threshold in meters — stop when position moves less than this. */
    private readonly convergenceThreshold = 0.05,
  ) {}

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    // Initial estimate from the base locator using raw firmware distances.
    const initial = this.inner.solve(fixes);
    if (!initial) return null;

    const store = getStore();
    const hasCalibration = store.nodePairFits.size > 0;

    let result = initial;
    let lastDelta = Infinity;
    let converged = !hasCalibration; // nothing to iterate against → "converged"

    if (hasCalibration) {
      for (let iter = 0; iter < this.maxIterations; iter++) {
        const corrected = applyPerPairCorrection(
          fixes,
          [result.x, result.y, result.z],
          store,
        );
        const next = this.inner.solve(corrected);
        if (!next) break;

        const dx = next.x - result.x;
        const dy = next.y - result.y;
        const delta = Math.sqrt(dx * dx + dy * dy);

        // Detect oscillation: if the delta isn't shrinking, bail rather
        // than ping-pong between two corrections.
        if (delta >= lastDelta && iter > 0) {
          result = next;
          break;
        }
        lastDelta = delta;
        result = next;
        if (delta < this.convergenceThreshold) {
          converged = true;
          break;
        }
      }
    }

    // ── Step 3: Confidence on final fix set ────────────────────────
    //
    // Body-shadow handling is now done via variance-based weighting
    // inside each base locator (IDW, BFGS, etc.): nodes whose
    // readings fluctuate a lot (body-blocked, multipath) get down-
    // weighted automatically. This avoids the bootstrap problem
    // that plagued threshold-based rejection — the variance signal
    // is computed from temporal data, not from the solver's own
    // (potentially compromised) position estimate.
    const solution: readonly [number, number, number] = [
      result.x,
      result.y,
      result.z,
    ];
    const fixesForConfidence = hasCalibration
      ? applyPerPairCorrection(fixes, solution, store)
      : fixes;
    const keptFixes = rejectOutliers(fixesForConfidence, solution);
    const breakdown = computePathAwareConfidence(
      keptFixes,
      solution,
      store,
      converged,
    );

    return {
      ...result,
      fixes: keptFixes.length,
      confidence: breakdown.blended,
      algorithm: this.name,
    };
  }
}

/**
 * Confidence score for a PathAware solution, in [0, 1]. Blends four
 * independent signals so a single weak dimension drags the score down:
 *
 *   fitScore      — how well the corrected distances agree at the
 *                   solution. Primary signal; dominates the weighting.
 *   geomScore     — isotropy of node directions from the solution. 1.0
 *                   when nodes surround the device evenly; collapses
 *                   toward 0 when nodes are collinear or all on one
 *                   side (bad geometric dilution of precision).
 *   coverageScore — fraction of fixes whose listener has per-pair
 *                   calibration data. 0 means PathAware effectively
 *                   passed through to the base locator.
 *   fixScore      — saturating with the number of fixes. With 2 fixes
 *                   we're barely better than a midpoint; by ~6 fixes
 *                   we have enough redundancy.
 *
 * Weights favor fit quality (0.55) over the structural signals, with a
 * small convergence penalty applied multiplicatively when the iteration
 * hit max-iter without settling.
 */
export function computePathAwareConfidence(
  fixes: readonly NodeFix[],
  solution: readonly [number, number, number],
  store: Store,
  converged: boolean,
): ConfidenceBreakdown {
  const n = fixes.length;
  if (n === 0) {
    return {
      fitScore: 0,
      geomScore: 0,
      coverageScore: 0,
      fixScore: 0,
      rmse: 0,
      blended: 0,
      convergencePenaltyApplied: !converged,
      fixCount: 0,
    };
  }

  // (1) fit — weighted RMSE of corrected distances at the solution.
  let sumSqRes = 0;
  let sumW = 0;
  for (const f of fixes) {
    const dx = solution[0] - f.point[0];
    const dy = solution[1] - f.point[1];
    const dz = solution[2] - f.point[2];
    const calc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const w = 1 / (f.distance * f.distance + 1e-6);
    const r = calc - f.distance;
    sumSqRes += w * r * r;
    sumW += w;
  }
  const rmse = sumW > 0 ? Math.sqrt(sumSqRes / sumW) : 5;
  // 0m → 1.0, 3m → 0.5, 6m → ~0.33.
  //
  // The 3m scale matches the real-world noise floor we observe on BLE
  // RSSI trilateration in a typical home: weighted RMSE around 1-1.5m
  // is "working well," not "barely acceptable." The earlier 1.5m scale
  // pegged good setups at ~50% confidence, which mislabeled normal
  // operation as degraded. See the conversation log around the input
  // smoothing experiment for the data that drove this.
  const fitScore = 1 / (1 + rmse / 3);

  // (2) geometry — 2D scatter of unit vectors from solution to each node.
  // In 2D, `4·det(M) / trace(M)²` is 1 for isotropic directions and 0
  // for perfectly collinear ones. Robust, dimensionless, no free params.
  let m00 = 0;
  let m01 = 0;
  let m11 = 0;
  let dirCount = 0;
  for (const f of fixes) {
    const dx = f.point[0] - solution[0];
    const dy = f.point[1] - solution[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    m00 += ux * ux;
    m01 += ux * uy;
    m11 += uy * uy;
    dirCount += 1;
  }
  let geomScore = 0;
  if (dirCount >= 2) {
    const tr = m00 + m11;
    const det = m00 * m11 - m01 * m01;
    geomScore = tr > 0 ? Math.max(0, Math.min(1, (4 * det) / (tr * tr))) : 0;
  }

  // (3) coverage — fraction of fixes whose listener has per-pair calibration.
  // A listener with ≥3 pair fits is considered fully covered; fewer scales
  // linearly. Averaged across fixes.
  let coverageSum = 0;
  for (const f of fixes) {
    const pairMap = store.nodePairFits.get(f.nodeId);
    const count = pairMap ? pairMap.size : 0;
    coverageSum += Math.min(1, count / 3);
  }
  const coverageScore = n > 0 ? coverageSum / n : 0;

  // (4) fix count — diminishing returns. 2→0.33, 4→0.67, 6+→1.
  const fixScore = Math.min(1, n / 6);

  let blended =
    0.55 * fitScore +
    0.20 * geomScore +
    0.15 * coverageScore +
    0.10 * fixScore;

  // Small convergence penalty — hitting max-iter without settling means
  // PathAware wasn't stable on this input.
  const convergencePenaltyApplied = !converged;
  if (convergencePenaltyApplied) blended *= 0.9;

  return {
    fitScore,
    geomScore,
    coverageScore,
    fixScore,
    rmse,
    blended: Math.max(0, Math.min(1, blended)),
    convergencePenaltyApplied,
    fixCount: n,
  };
}

/**
 * Per-fix result of the path-aware correction. `nEffective` and
 * `nAssumed` are exposed so diagnostic views can show what calibration
 * was used and why the corrected distance differs from the raw one.
 * When no calibration data applied, `nEffective` is null and
 * `correctedDistance === fix.distance`.
 */
export interface CorrectionDetail {
  fix: NodeFix;
  correctedDistance: number;
  nEffective: number | null;
  nAssumed: number;
}

export function applyPerPairCorrection(
  fixes: readonly NodeFix[],
  estimate: readonly [number, number, number],
  store: Store,
): NodeFix[] {
  return correctFixesWithDetail(fixes, estimate, store).map((d) => ({
    ...d.fix,
    distance: d.correctedDistance,
  }));
}

/**
 * Same as `applyPerPairCorrection`, but returns the intermediate
 * calibration values alongside each corrected fix. Used by the
 * diagnostics helper so the UI can explain *why* each distance was
 * adjusted.
 *
 * **How `n_effective` is picked**
 *
 * For each listener L and device estimate D, we blend L's per-pair
 * fits `n_real[L, T]` by how closely each L→T path resembles the
 * L→D path we're trying to correct. Similarity has two dimensions:
 *
 *   - **Direction**: does L→T go the same way as L→D? Measured by the
 *     cosine of the angle between the two unit vectors in 2D. Paths
 *     going opposite directions (cos < 0) get zero weight because
 *     they traverse different walls.
 *   - **Distance**: is L→T about the same length as L→D? Measured by
 *     an exponential falloff on the absolute difference, with a 3 m
 *     tolerance. Same-direction paths at very different lengths
 *     probably cross different obstacles.
 *
 * Combined weight per pair fit: `max(0, cos θ)² × exp(−|Δd|/3)`.
 * Squaring the cosine sharpens the directional preference (90° paths
 * drop to 0 instead of 0.5).
 *
 * **Confidence-weighted shrink toward `nAssumed`**
 *
 * The total weight collected across a listener's pair fits is also a
 * *confidence signal* — a high total means several pair fits are
 * genuine directional and length matches for the target path, a low
 * total means we're essentially guessing. We shrink the interpolated
 * `n_effective` toward `nAssumed` (the firmware's current absorption
 * — effectively "no correction") proportionally to this confidence.
 *
 * The failure mode this avoids: very short clean paths like "device 4m
 * from its own listener in an open room" have no genuinely similar
 * pair fits (the listener's other observations are longer wall-heavy
 * paths). Without the shrink, we'd apply those wall-heavy `n` values
 * to a clean path and aggressively over-correct. With the shrink, the
 * correction collapses to a no-op when we have no reliable match.
 *
 * This replaces the earlier "IDW across all known transmitters
 * weighted by distance-from-estimate" scheme, which couldn't
 * distinguish clean from walled paths and had the over-correction
 * issue baked in.
 */
export function correctFixesWithDetail(
  fixes: readonly NodeFix[],
  estimate: readonly [number, number, number],
  store: Store,
): CorrectionDetail[] {
  return fixes.map((fix) => {
    // Parse the listener's firmware `absorption` setting, defaulting to
    // 2.7 when it's absent OR unusable (zero/negative/non-numeric). A
    // literal "0" gets published on some nodes that never received an
    // auto-fit update, and treating that as nAssumed=0 would make every
    // correction on that listener silently collapse to passthrough.
    const absRaw = store.nodeSettings.get(fix.nodeId)?.get("absorption");
    const parsedAbs = absRaw != null ? parseFloat(absRaw) : NaN;
    const nAssumed =
      Number.isFinite(parsedAbs) && parsedAbs > 0.1 ? parsedAbs : 2.7;
    const passthrough: CorrectionDetail = {
      fix,
      correctedDistance: fix.distance,
      nEffective: null,
      nAssumed,
    };

    const pairFits = store.nodePairFits.get(fix.nodeId);
    if (!pairFits || pairFits.size === 0) return passthrough;

    // L→D path (listener-to-device). 2D direction is what matters for
    // wall traversal; we drop the z component for the similarity check.
    const lx = fix.point[0];
    const ly = fix.point[1];
    const ddx = estimate[0] - lx;
    const ddy = estimate[1] - ly;
    const dLD = Math.sqrt(ddx * ddx + ddy * ddy);
    // Degenerate case — listener is effectively on top of the estimate.
    // There's no meaningful direction. Return passthrough rather than
    // guessing with a direction-blind average.
    if (dLD < 1e-6) return passthrough;
    const uLDx = ddx / dLD;
    const uLDy = ddy / dLD;

    // Blend L's per-pair fits by path similarity to L→D.
    const DIST_TOLERANCE_M = 3;
    /**
     * `totalWeight` at which path matching is considered fully
     * confident. With perfectly-matched pair fits yielding per-fit
     * weights near 1.0, a single great match drives confidence to
     * 100%. Partial matches (moderate direction/distance) scale
     * proportionally.
     */
    const MATCH_SCALE = 1.0;

    /**
     * Minimum pair-fit quality (variance-derived R²-like score) to
     * consider usable. Below this, the per-sample `n` values for
     * this path are too inconsistent to trust for correction.
     */
    const MIN_PAIR_FIT_R2 = 0.25;

    let weightedN = 0;
    let totalWeight = 0;
    for (const [txId, pairFit] of pairFits) {
      if (txId === fix.nodeId) continue; // self-pair is meaningless
      if (pairFit.nReal <= 0) continue;
      if (pairFit.rSquared < MIN_PAIR_FIT_R2) continue; // fit is junk
      const txPoint = store.nodeIndex.get(txId);
      if (!txPoint) continue;

      const tdx = txPoint[0] - lx;
      const tdy = txPoint[1] - ly;
      const dLT = Math.sqrt(tdx * tdx + tdy * tdy);
      if (dLT < 1e-6) continue; // transmitter coincident with listener

      const uLTx = tdx / dLT;
      const uLTy = tdy / dLT;

      // Directional similarity: cosine of the angle between L→T and L→D.
      // Squared so perpendicular paths contribute ~0, clamped at 0 so
      // opposite-direction paths contribute nothing.
      const cosSim = uLTx * uLDx + uLTy * uLDy;
      const dirWeight = cosSim > 0 ? cosSim * cosSim : 0;
      if (dirWeight <= 0) continue;

      // Distance similarity: exponential falloff on the length
      // mismatch. 3 m apart → ~37% weight, 6 m apart → ~14%.
      const distDelta = Math.abs(dLT - dLD);
      const distWeight = Math.exp(-distDelta / DIST_TOLERANCE_M);

      // Scale by the pair's quality score so a tight, consistent fit
      // contributes more than a noisy one, even at matched direction
      // and distance.
      const weight = dirWeight * distWeight * pairFit.rSquared;
      if (weight <= 0) continue;
      weightedN += pairFit.nReal * weight;
      totalWeight += weight;
    }
    // No pair fit contributed any real weight (no directional match).
    // Don't guess — skip the correction entirely.
    if (totalWeight <= 1e-9) return passthrough;

    // Raw path-matched interpolation of n_real.
    const nInterpolated = weightedN / totalWeight;

    // Confidence shrink toward `nAssumed` when we don't have strong
    // matching evidence — preserves the close-clean-path fix from
    // earlier in the PathAware finish line.
    const matchConfidence = Math.min(1, totalWeight / MATCH_SCALE);
    const nEffective =
      nAssumed + matchConfidence * (nInterpolated - nAssumed);

    return buildCorrection(fix, nAssumed, nEffective, passthrough);
  });
}

function buildCorrection(
  fix: NodeFix,
  nAssumed: number,
  nEffective: number,
  passthrough: CorrectionDetail,
): CorrectionDetail {
  if (nAssumed <= 0 || nEffective <= 0 || fix.distance <= 0) {
    return passthrough;
  }
  // Single-parameter correction: the per-pair fit only provides the
  // local path-loss exponent. Constant-offset `C` correction from
  // per-listener 2-param regression is a planned follow-up — once
  // it's wired in, this becomes `pow(...) * exp(−logK/nReal)`.
  const exponent = nAssumed / nEffective;
  const correctedDistance = Math.pow(fix.distance, exponent);
  return { fix, correctedDistance, nEffective, nAssumed };
}

