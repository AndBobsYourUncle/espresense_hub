import type { Config } from "@/lib/config";
import { buildWallSegments, type WallSegment } from "@/lib/map/rf_geometry";
import { polygonCentroid } from "@/lib/map/geometry";
import { countCrossings } from "@/lib/map/rf_geometry";
import { findRoom } from "@/lib/locators/room_aware";
import type { GroundTruthSample, Store } from "@/lib/state/store";

/**
 * Fit RF model parameters from the node-to-node ground-truth sample
 * matrix. Solves a least-squares problem for the path-loss exponent and
 * the three attenuation constants (interior wall, exterior wall, door)
 * so the configured physics matches what the nodes actually see.
 *
 * Why this exists: the configured defaults (n=3.0, wall=4dB, ext=10dB,
 * door=0dB) are reasonable starting guesses but every house is
 * different. A drywall-heavy ranch with open doorways propagates very
 * differently from a plaster-walled bungalow with closed doors. The
 * per-pair fits already tell us when the model over- or under-
 * attenuates each path; this module aggregates that signal across all
 * paths and recovers the parameters that actually fit.
 *
 * Math:
 *
 *   rssi_observed = tx_ref − 10·absorption · log10(measured)         (firmware)
 *   rssi_observed = ref_1m − 10·n · log10(trueDist) − W              (physics)
 *
 *   where W = interior·w + exterior·e + doors·dr
 *
 * Assuming tx_ref ≈ ref_1m globally (all nodes default to the same
 * −59 dBm reference; per-node deviation is absorbed into per-node
 * absorption fits), equating these two and rearranging:
 *
 *   10·absorption_i · log10(measured_i)
 *     = 10·n · log10(trueDist_i)
 *     + interior_i · w + exterior_i · e + doors_i · dr
 *
 * Linear in (n, w, e, dr). Standard OLS:
 *
 *   y_i = 10·absorption_i · log10(measured_i)             (observed)
 *   X_i = [10·log10(trueDist_i), interior_i, exterior_i, doors_i]
 *   β   = [n, w, e, dr]
 *   β   = (XᵀX)⁻¹ Xᵀy
 *
 * Constraints: parameters should be positive — clamped post-fit. The
 * unconstrained fit usually lands in physical territory anyway because
 * the data has the right shape, but a handful of degenerate samples
 * (very short distances, all same wall count) can tilt β into negatives.
 */

export interface RfParamFitResult {
  /** Fitted path-loss exponent. */
  pathLossExponent: number;
  /** Fitted interior wall attenuation, dB. */
  wallAttenuationDb: number;
  /** Fitted exterior wall attenuation, dB. */
  exteriorWallAttenuationDb: number;
  /** Fitted door attenuation, dB. */
  doorAttenuationDb: number;
  /**
   * Coefficient of determination on the regression. 0..1, higher is
   * better fit. Below ~0.5 means the linear model isn't capturing the
   * data well — typically a sign of strong non-log-linear effects
   * (multipath, body shadow) or geometry mismatch.
   */
  rSquared: number;
  /** Number of samples used (after filtering). */
  sampleCount: number;
  /**
   * Residual standard deviation in dB-equivalent units. A clean indoor
   * dataset usually fits within 3–5 dB; larger means there's a lot of
   * variance the linear model can't explain.
   */
  residualStdDb: number;
}

/** Distance below which log() is too unstable for the regression. */
const MIN_TRUE_DIST = 1.0;
/** Drop samples with measured-distance ≤ 0 or non-finite. */
const MIN_MEASURED = 0.1;
/** Floors for fitted parameters — below these we suspect a degenerate fit. */
const MIN_N = 1.5;
const MIN_ATT_DB = 0;
const MAX_N = 8;
const MAX_ATT_DB = 30;

/**
 * Run the fit using the live store's sample buffers and the supplied
 * config (for walls and node positions). Returns null when there
 * aren't enough samples or the regression matrix is singular.
 *
 * Per-sample obstruction counts are recomputed from the current
 * config's geometry — we don't rely on the `obstructionLossDb` field
 * cached on the sample, since that was computed against whatever the
 * RF params were at sample time. The fit needs raw counts (interior /
 * exterior / doors) so the parameters can be pulled out as variables.
 */
export function fitRfParametersFromStore(
  store: Store,
  config: Config,
): RfParamFitResult | null {
  // Build per-floor walls + node-room centroid lookups once.
  const wallsByFloor = new Map<string, WallSegment[]>();
  for (const f of config.floors) {
    if (f.id) wallsByFloor.set(f.id, buildWallSegments([f]));
  }
  const nodeFloor = new Map<string, string>();
  const nodePoint = new Map<string, readonly [number, number, number]>();
  const nodeCentroid = new Map<string, readonly [number, number]>();
  for (const node of config.nodes) {
    if (!node.id || !node.point) continue;
    const floor = node.floors?.[0]
      ? config.floors.find((f) => f.id === node.floors![0])
      : config.floors[0];
    if (!floor?.id) continue;
    nodeFloor.set(node.id, floor.id);
    nodePoint.set(node.id, node.point);
    const label = node.room;
    let room =
      label && floor.rooms.find((r) => r.id === label || r.name === label);
    if (!room) {
      const rid = findRoom(floor.rooms, [node.point[0], node.point[1]]);
      room = rid ? floor.rooms.find((r) => r.id === rid || r.name === rid) : undefined;
    }
    if (room?.points && room.points.length >= 3) {
      nodeCentroid.set(node.id, polygonCentroid(room.points));
    }
  }

  // Build the regression matrix. Each row contributes:
  //   [10·log10(trueDist), interior, exterior, doors]  →  10·absorption·log10(measured)
  const X: number[][] = [];
  const y: number[] = [];

  for (const [listenerId, samples] of store.nodeGroundTruthSamples) {
    const lFloor = nodeFloor.get(listenerId);
    const lPoint = nodePoint.get(listenerId);
    if (!lFloor || !lPoint) continue;
    const walls = wallsByFloor.get(lFloor);
    if (!walls) continue;

    for (const s of samples) {
      if (!isFiniteSample(s)) continue;
      const tPoint = nodePoint.get(s.transmitterId);
      const tFloor = nodeFloor.get(s.transmitterId);
      if (!tPoint || tFloor !== lFloor) continue;

      // Source for the wall-at-source side test = transmitter's room
      // centroid (signal originates at TX).
      const txCentroid = nodeCentroid.get(s.transmitterId);
      const { interior, exterior, doors } = countCrossings(
        tPoint[0],
        tPoint[1],
        lPoint[0],
        lPoint[1],
        walls,
        txCentroid,
      );

      const yi = 10 * s.absorptionAtTime * Math.log10(s.measured);
      const xi = [
        10 * Math.log10(s.trueDist),
        interior,
        exterior,
        doors,
      ];
      X.push(xi);
      y.push(yi);
    }
  }

  if (X.length < 20) return null; // Need a meaningful sample size.

  return solveOls(X, y);
}

/**
 * Closed-form OLS via the normal equations β = (XᵀX)⁻¹ Xᵀy. Fine for
 * a 4-parameter problem with a few thousand rows — no need for
 * iterative solvers. Returns null when the design matrix is singular
 * (e.g., all samples have the same wall configuration).
 */
function solveOls(X: number[][], y: number[]): RfParamFitResult | null {
  const n = X.length;
  const p = X[0].length;

  // XᵀX (p×p) and Xᵀy (p×1).
  const XtX: number[][] = Array.from({ length: p }, () =>
    new Array(p).fill(0),
  );
  const Xty: number[] = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) {
        XtX[a][b] += X[i][a] * X[i][b];
      }
    }
  }

  const inv = invertMatrix(XtX);
  if (!inv) return null;

  const beta = new Array(p).fill(0);
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) beta[a] += inv[a][b] * Xty[b];
  }

  // Residuals + R².
  let sse = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) sumY += y[i];
  const meanY = sumY / n;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    let yhat = 0;
    for (let a = 0; a < p; a++) yhat += X[i][a] * beta[a];
    const r = y[i] - yhat;
    sse += r * r;
    sst += (y[i] - meanY) * (y[i] - meanY);
  }
  const rSquared = sst > 1e-9 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0;
  const residualStd = Math.sqrt(sse / Math.max(1, n - p));

  // Clamp into physically plausible territory. Negative attenuations
  // are nonsensical (the model would produce stronger-than-1m signal
  // at distance), and a near-zero or negative path-loss exponent makes
  // the model unable to differentiate distances at all.
  return {
    pathLossExponent: clamp(beta[0], MIN_N, MAX_N),
    wallAttenuationDb: clamp(beta[1], MIN_ATT_DB, MAX_ATT_DB),
    exteriorWallAttenuationDb: clamp(beta[2], MIN_ATT_DB, MAX_ATT_DB),
    doorAttenuationDb: clamp(beta[3], MIN_ATT_DB, MAX_ATT_DB),
    rSquared,
    sampleCount: n,
    residualStdDb: residualStd,
  };
}

function isFiniteSample(s: GroundTruthSample): boolean {
  return (
    Number.isFinite(s.measured) &&
    s.measured > MIN_MEASURED &&
    Number.isFinite(s.trueDist) &&
    s.trueDist > MIN_TRUE_DIST &&
    Number.isFinite(s.absorptionAtTime) &&
    s.absorptionAtTime > 0.1
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Gaussian-elimination matrix inverse. p≤8 in practice (we have 4
 * parameters today; leave headroom for future per-floor or per-room
 * extensions). Returns null when the matrix is singular within tolerance.
 */
function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  // Augmented matrix [m | I]
  const a: number[][] = m.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });

  for (let i = 0; i < n; i++) {
    // Partial pivot — find the row with largest |a[k][i]| for k≥i.
    let pivotRow = i;
    let pivotVal = Math.abs(a[i][i]);
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(a[k][i]) > pivotVal) {
        pivotVal = Math.abs(a[k][i]);
        pivotRow = k;
      }
    }
    if (pivotVal < 1e-12) return null;
    if (pivotRow !== i) {
      const tmp = a[i];
      a[i] = a[pivotRow];
      a[pivotRow] = tmp;
    }
    // Normalize pivot row.
    const piv = a[i][i];
    for (let j = 0; j < 2 * n; j++) a[i][j] /= piv;
    // Eliminate other rows.
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = a[k][i];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[k][j] -= factor * a[i][j];
    }
  }

  const inv: number[][] = a.map((row) => row.slice(n));
  return inv;
}
