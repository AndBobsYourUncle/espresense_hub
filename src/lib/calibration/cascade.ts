import type { Config } from "@/lib/config";
import { obstructionLossDb, type RfParams } from "@/lib/map/rf_propagation";
import { buildWallSegments, countCrossings, type WallSegment } from "@/lib/map/rf_geometry";
import { polygonCentroid } from "@/lib/map/geometry";
import { findRoom } from "@/lib/locators/room_aware";
import {
  buildRoutingGraph,
  findBestPathForPair,
  type RoutedPath,
  type RoutingGraph,
} from "@/lib/map/rf_routing";
import type { Store } from "@/lib/state/store";

/**
 * Cascade calibration system — Phase 1 of the state-tracker rebuild.
 * See `docs/state-tracker.md` for the full design.
 *
 * **What this is:** a self-fitting RF model that consumes raw RSSI
 * from the continuous stream of node-to-node observations and learns
 *
 *   Layer 1: global RF parameters (n_path, wall_att, ext_att, door_att)
 *   Layer 2: per-node TX/RX offsets
 *
 * Both endpoints of a node-to-node observation have known positions
 * and known walls between them, so each observation is a calibrated
 * (input, output) pair for the model. Over hours of operation the
 * fit converges from data alone — no human input required.
 *
 * **What this is NOT yet:** a locator. Phase 1 ships as parallel
 * diagnostic only — feeds itself, exposes its state via API + UI,
 * but no positioning logic consumes it. Once we've validated that
 * the parameters converge to plausible values and residuals settle
 * (success criterion in the doc), Phase 2/3 builds the consumer.
 *
 * **The math:**
 *
 *   For TX node B heard at RX node A with raw RSSI r:
 *     predicted_rssi(A,B) = ref_1m
 *                         + tx_offset[B]
 *                         − 10·n_path · log10(d_AB)
 *                         − W(A, B)
 *                         − rx_offset[A]
 *
 *   Per pair, accumulate (r, d_AB, walls_AB). At fit time, average
 *   per pair to get one (mean RSSI, walls, distance) row, then
 *   solve a single linear system in
 *     β = [n_path, wall_att, ext_att, door_att,
 *          tx_offset[N1], ..., tx_offset[NK],
 *          rx_offset[N1], ..., rx_offset[NK]]
 *
 *   With ridge regularization toward physical priors. The reference
 *   degree of freedom (constant shift in all tx_offset and rx_offset
 *   simultaneously is invariant) is broken by the ridge.
 */

// ─── Public types ────────────────────────────────────────────────────────

/** Walls + door counts on the line between two nodes. */
export interface PathObstruction {
  interior: number;
  exterior: number;
  doors: number;
}

/** A single recent observation kept on the per-pair ring buffer. */
export interface PairRssiSample {
  rssi: number;
  trueDist: number;
  walls: PathObstruction;
  timestamp: number;
}

/**
 * Per-pair RSSI residual statistics.
 *
 * Aggregate stats are recency-decayed and feed the cascade fit. The
 * recent ring buffer is for diagnostic UI ("show me the last 50
 * samples on this pair") and future outlier-rejection use.
 */
export interface PairRssiStats {
  /** Effective sample count after recency decay. */
  weight: number;
  /** Σ w·rssi (decayed). */
  sumRssi: number;
  /** Σ w·rssi² (decayed) — for variance / sigma. */
  sumRssiSq: number;
  /**
   * Geometry of this pair, captured the first time we see it. The
   * walls/distance won't change unless the config does, so we don't
   * need to update these per sample.
   */
  trueDist: number;
  walls: PathObstruction;
  /** Last update timestamp (ms). */
  lastUpdateMs: number;
  /** Total raw samples seen (uncapped, no decay). */
  totalSamples: number;
  /** Ring buffer of recent samples for diagnostics. Newest at end. */
  recent: PairRssiSample[];
}

/** Per-node TX and RX offsets (Layer 2 output). */
export interface NodeOffsets {
  txOffsetDb: number;
  rxOffsetDb: number;
}

/** Output of the cascade fitter. */
export interface CascadeFit {
  // Layer 1 — global RF parameters
  pathLossExponent: number;
  wallAttenuationDb: number;
  exteriorWallAttenuationDb: number;
  doorAttenuationDb: number;
  /**
   * Specular reflection loss in dB per bounce (Phase 1.7+). Fit
   * from data: paths through reflection vertices in the routing
   * graph contribute `reflections × this value` of attenuation.
   */
  reflectionLossDb: number;
  /** Reference RSSI used during fit (held fixed, not optimized). */
  referenceRssi1m: number;
  // Layer 2 — per-node offsets, keyed by node id
  nodeOffsets: Map<string, NodeOffsets>;
  /** Reference node — its tx_offset is fixed at 0 to anchor the gauge DOF. */
  referenceNodeId: string | null;
  // Quality
  /** Coefficient of determination on the per-pair fit. */
  rSquared: number;
  /** Residual standard deviation (dB) at the fitted parameters. */
  residualStdDb: number;
  /** Number of pairs that contributed to the fit. */
  pairCount: number;
  /** Total raw observations summed across pairs (capped at MAX_WEIGHT each). */
  totalWeight: number;
  /** Wall-clock time the fit was computed. */
  fittedAtMs: number;
  /**
   * Per-pair routed path used during this fit, keyed `txId|rxId`.
   * Captures both the accumulated counts (for the model) and the
   * waypoint sequence (for visualization). Useful for "show me how
   * the cascade thinks the signal travels for this pair" — exposed
   * via the API so the cascade map overlay can draw the routed
   * path instead of (or alongside) the straight line.
   */
  routedPaths: Map<string, RoutedPath>;
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Recency decay time constant (ms). 6 h half-life. */
const RECENCY_TAU_MS = 6 * 3600 * 1000;

/** Defensive cap on per-pair weight; same pattern as elsewhere. */
const MAX_WEIGHT = 1000;

/** How many recent samples to keep on each pair for diagnostics. */
const RING_BUFFER_SIZE = 50;

/** Distances below this give numerically unstable predictions. */
const MIN_TRUE_DIST_M = 1.0;

/** Reject implausibly weak observations (suggests broken hardware/multipath). */
const MIN_RSSI_DBM = -110;
/** Reject implausibly strong (would mean closer than 1 m or RX saturation). */
const MAX_RSSI_DBM = -10;

/** Minimum pairs before we attempt a fit. Fewer = under-determined. */
const MIN_PAIRS_FOR_FIT = 5;

/**
 * Ridge regularization toward physical priors. Same role as in
 * rf_param_fit.ts: keeps the fit in physically-plausible territory
 * when the linear system is degenerate or noisy. Values are
 * `weightFraction × XᵀWX[i][i]`, so they self-scale to the data.
 *
 * `tx_offset` and `rx_offset` priors are anchored at 0 (the model
 * is invariant under a constant shift across all offsets, so
 * regularization breaks the gauge DOF).
 */
const PRIORS = {
  pathLossExponent: { mean: 3.0, weightFraction: 0.02 },
  wallAttenuationDb: { mean: 4.0, weightFraction: 0.1 },
  exteriorWallAttenuationDb: { mean: 10.0, weightFraction: 0.2 },
  doorAttenuationDb: { mean: 0.0, weightFraction: 1.0 },
  /**
   * Per-bounce specular reflection loss. For routing-useful
   * reflections — i.e. the ones Dijkstra would actually pick —
   * the relevant physical case is *grazing-incidence* bounces
   * off smooth interior surfaces (drywall, glass, metal). Fresnel
   * analysis + indoor measurement literature puts that lower tail
   * at ~3–5 dB, not the 6–9 dB "average-bounce" number. Prior at
   * 3.5 dB with weak strength so the data can move it freely; if
   * reflections are truly useful here, the fit will find them.
   */
  reflectionLossDb: { mean: 3.5, weightFraction: 0.05 },
  /** Per-node tx/rx offset priors. Weak — let data drive when it has signal. */
  nodeOffsetMean: 0.0,
  nodeOffsetWeightFraction: 0.1,
};

/** Bounds on fitted parameters (post-clamp). */
const N_MIN = 1.5;
const N_MAX = 8;
const ATT_MIN = 0;
const ATT_MAX = 30;
const OFFSET_BOUND_DB = 15;

// ─── Per-pair stat updates ───────────────────────────────────────────────

/**
 * Incorporate a single node-to-node RSSI observation into the
 * pair's residual stats. Called from the MQTT handler on every
 * node-to-node measurement. O(1).
 */
export function accumulatePairRssiSample(
  store: Store,
  txId: string,
  rxId: string,
  rssi: number,
  trueDist: number,
  walls: PathObstruction,
): void {
  if (!Number.isFinite(rssi)) return;
  if (rssi < MIN_RSSI_DBM || rssi > MAX_RSSI_DBM) return;
  if (!Number.isFinite(trueDist) || trueDist < MIN_TRUE_DIST_M) return;
  if (txId === rxId) return;

  let byRx = store.pairRssiStats.get(txId);
  if (!byRx) {
    byRx = new Map();
    store.pairRssiStats.set(txId, byRx);
  }
  let stats = byRx.get(rxId);
  if (!stats) {
    stats = {
      weight: 0,
      sumRssi: 0,
      sumRssiSq: 0,
      trueDist,
      walls: { ...walls },
      lastUpdateMs: 0,
      totalSamples: 0,
      recent: [],
    };
    byRx.set(rxId, stats);
  }

  const now = Date.now();
  // Recency decay before incorporating the new sample.
  if (stats.lastUpdateMs > 0) {
    const dt = Math.max(0, now - stats.lastUpdateMs);
    if (dt > 0) {
      const factor = Math.exp(-dt / RECENCY_TAU_MS);
      stats.weight *= factor;
      stats.sumRssi *= factor;
      stats.sumRssiSq *= factor;
    }
  }
  if (stats.weight > MAX_WEIGHT) {
    const f = MAX_WEIGHT / stats.weight;
    stats.weight = MAX_WEIGHT;
    stats.sumRssi *= f;
    stats.sumRssiSq *= f;
  }

  stats.weight += 1;
  stats.sumRssi += rssi;
  stats.sumRssiSq += rssi * rssi;
  stats.totalSamples += 1;
  stats.lastUpdateMs = now;
  // Keep walls / trueDist current (rare config changes).
  stats.trueDist = trueDist;
  stats.walls = { ...walls };

  // Ring buffer.
  stats.recent.push({ rssi, trueDist, walls: { ...walls }, timestamp: now });
  if (stats.recent.length > RING_BUFFER_SIZE) stats.recent.shift();
}

// ─── Cascade fit ─────────────────────────────────────────────────────────

/**
 * Solve for (Layer 1 + Layer 2) parameters from the current per-pair
 * stats. Linear weighted ridge regression in a single pass.
 *
 * Returns `null` when there isn't enough data (fewer than
 * `MIN_PAIRS_FOR_FIT` pairs with non-zero weight) or the matrix
 * inversion fails despite ridge.
 */
export function fitCascade(store: Store, config: Config): CascadeFit | null {
  // Collect node IDs (those with at least one observation).
  const nodeIds = new Set<string>();
  for (const [txId, byRx] of store.pairRssiStats) {
    if (byRx.size === 0) continue;
    nodeIds.add(txId);
    for (const rxId of byRx.keys()) nodeIds.add(rxId);
  }
  if (nodeIds.size < 2) return null;

  // Pick a reference node — the one with the most outgoing
  // observations. Anchoring its tx_offset to 0 breaks the gauge DOF.
  // Most-active node minimizes variance from this choice.
  const txCounts = new Map<string, number>();
  for (const [txId, byRx] of store.pairRssiStats) {
    let c = 0;
    for (const stats of byRx.values()) c += stats.totalSamples;
    txCounts.set(txId, c);
  }
  let referenceNodeId: string | null = null;
  let bestCount = -1;
  for (const [id, c] of txCounts) {
    if (c > bestCount) {
      bestCount = c;
      referenceNodeId = id;
    }
  }
  if (referenceNodeId == null) return null;

  // Build an ordered list of nodes excluding the reference for tx_offset.
  // rx_offset is fitted for ALL nodes (including reference) — the gauge
  // DOF is broken by removing reference's tx_offset.
  const sortedNodes = [...nodeIds].sort();
  const txParamIndex = new Map<string, number>();
  const rxParamIndex = new Map<string, number>();

  // Parameter layout:
  //   [0]   path_loss_exponent
  //   [1]   wall_attenuation_db
  //   [2]   exterior_wall_attenuation_db
  //   [3]   door_attenuation_db
  //   [4]   reflection_loss_db
  //   [5..] tx_offset[N] for N != reference, in sortedNodes order
  //   [...] rx_offset[N] for N in sortedNodes order
  let nextIdx = 5;
  for (const id of sortedNodes) {
    if (id === referenceNodeId) continue;
    txParamIndex.set(id, nextIdx++);
  }
  for (const id of sortedNodes) {
    rxParamIndex.set(id, nextIdx++);
  }
  const P = nextIdx; // total parameters

  // Reference RSSI: fixed (not fitted). Subtracted from observations
  // to make the linear system smaller. Use config value.
  const refRssi = config.rf.reference_rssi_1m;

  // Build the routing graph for shortest-path-loss computation.
  // For each pair, we compute the path the signal *most plausibly*
  // takes (via doors, open areas) instead of assuming straight-line
  // propagation through every intervening wall.
  //
  // Routing parameters: use the *previous* fit's params if we have
  // one, else fall back to configured params. This implements the
  // (params, paths) fixed-point iteration — converges over 2–3 refits.
  const routingParams: RfParams = store.latestCascadeFit
    ? {
        referenceRssi1m: store.latestCascadeFit.referenceRssi1m,
        pathLossExponent: store.latestCascadeFit.pathLossExponent,
        wallAttenuationDb: store.latestCascadeFit.wallAttenuationDb,
        exteriorWallAttenuationDb:
          store.latestCascadeFit.exteriorWallAttenuationDb,
        doorAttenuationDb: store.latestCascadeFit.doorAttenuationDb,
        reflectionLossDb: store.latestCascadeFit.reflectionLossDb,
      }
    : {
        referenceRssi1m: config.rf.reference_rssi_1m,
        pathLossExponent: config.rf.path_loss_exponent,
        wallAttenuationDb: config.rf.wall_attenuation_db,
        exteriorWallAttenuationDb: config.rf.exterior_wall_attenuation_db,
        doorAttenuationDb: config.rf.door_attenuation_db,
        reflectionLossDb: config.rf.reflection_loss_db,
      };
  const routingGraph = buildRoutingGraph(config);

  // Build per-pair rows. y = mean_observed_rssi − ref_1m. The X row
  // encodes the routed path's accumulated counts, so the cascade
  // params are fit against the *real* propagation route, not the
  // straight-line approximation.
  interface Row {
    x: number[];
    y: number;
    w: number;
    txId: string;
    rxId: string;
    routed: RoutedPath;
  }
  const rows: Row[] = [];
  for (const [txId, byRx] of store.pairRssiStats) {
    for (const [rxId, stats] of byRx) {
      if (stats.weight < 1) continue;
      const meanRssi = stats.sumRssi / stats.weight;

      // Routed path (via Dijkstra) — falls back to direct line if
      // routing isn't available or if the direct path is already
      // optimal.
      const routed =
        findBestPathForPair(routingGraph, txId, rxId, routingParams) ??
        // Fallback: synthesize a "direct path" object from the
        // pair's stored direct-line counts. Happens when nodes
        // aren't in the routing graph (shouldn't, but defensive).
        ({
          totalLength: stats.trueDist,
          interior: stats.walls.interior,
          exterior: stats.walls.exterior,
          doors: stats.walls.doors,
          reflections: 0,
          pathPoints: [],
        } satisfies RoutedPath);

      // Cascade fit uses the *true* total length (10·log10(total)),
      // not per-hop approximation, since `pathLossExponent` is fit
      // against this term.
      const length = Math.max(0.1, routed.totalLength);
      const x = new Array(P).fill(0);
      x[0] = -10 * Math.log10(length);
      x[1] = -routed.interior;
      x[2] = -routed.exterior;
      x[3] = -routed.doors;
      x[4] = -routed.reflections;
      const txIdx = txParamIndex.get(txId);
      if (txIdx != null) x[txIdx] = 1; // tx_offset[reference] is fixed at 0
      const rxIdx = rxParamIndex.get(rxId);
      if (rxIdx != null) x[rxIdx] = -1;
      rows.push({
        x,
        y: meanRssi - refRssi,
        w: stats.weight,
        txId,
        rxId,
        routed,
      });
    }
  }
  if (rows.length < MIN_PAIRS_FOR_FIT) return null;

  // Build XᵀWX and XᵀWy.
  const XtWX = Array.from({ length: P }, () => new Array<number>(P).fill(0));
  const XtWy = new Array<number>(P).fill(0);
  for (const r of rows) {
    for (let i = 0; i < P; i++) {
      if (r.x[i] === 0) continue;
      const xi = r.x[i];
      XtWy[i] += r.w * xi * r.y;
      for (let j = 0; j < P; j++) {
        if (r.x[j] === 0) continue;
        XtWX[i][j] += r.w * xi * r.x[j];
      }
    }
  }

  // Apply ridge: λ_i = weightFraction_i × data-diagonal_i (so the
  // ridge auto-scales with how much evidence each parameter has).
  const dataDiag = XtWX.map((_, i) => XtWX[i][i]);
  const priors = [
    PRIORS.pathLossExponent,
    PRIORS.wallAttenuationDb,
    PRIORS.exteriorWallAttenuationDb,
    PRIORS.doorAttenuationDb,
    PRIORS.reflectionLossDb,
  ];
  for (let i = 0; i < 5; i++) {
    const lambda = priors[i].weightFraction * Math.max(dataDiag[i], 1);
    XtWX[i][i] += lambda;
    XtWy[i] += lambda * priors[i].mean;
  }
  // Per-node offsets — same scheme but with the offset prior.
  for (let i = 5; i < P; i++) {
    const lambda =
      PRIORS.nodeOffsetWeightFraction * Math.max(dataDiag[i], 1);
    XtWX[i][i] += lambda;
    XtWy[i] += lambda * PRIORS.nodeOffsetMean;
  }

  const inv = invertMatrix(XtWX);
  if (!inv) return null;
  const beta = new Array<number>(P).fill(0);
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < P; j++) beta[i] += inv[i][j] * XtWy[j];
  }

  // Quality metrics — computed against the data fit only (not
  // including the ridge penalty), so the user-visible numbers
  // reflect "how well does β explain the observations."
  let sumW = 0;
  let sumWy = 0;
  for (const r of rows) {
    sumW += r.w;
    sumWy += r.w * r.y;
  }
  const meanY = sumWy / sumW;
  let sse = 0;
  let sst = 0;
  for (const r of rows) {
    let yhat = 0;
    for (let i = 0; i < P; i++) yhat += r.x[i] * beta[i];
    const e = r.y - yhat;
    sse += r.w * e * e;
    sst += r.w * (r.y - meanY) * (r.y - meanY);
  }
  const rSquared = sst > 1e-9 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0;
  const effN = sumW;
  const residualStd = Math.sqrt(sse / Math.max(1, effN - P));

  // Extract + clamp parameters.
  const pathLossExponent = clamp(beta[0], N_MIN, N_MAX);
  const wallAttenuationDb = clamp(beta[1], ATT_MIN, ATT_MAX);
  const exteriorWallAttenuationDb = clamp(beta[2], ATT_MIN, ATT_MAX);
  const doorAttenuationDb = clamp(beta[3], ATT_MIN, ATT_MAX);
  const reflectionLossDb = clamp(beta[4], ATT_MIN, ATT_MAX);

  const nodeOffsets = new Map<string, NodeOffsets>();
  for (const id of sortedNodes) {
    const txIdx = txParamIndex.get(id);
    const rxIdx = rxParamIndex.get(id);
    nodeOffsets.set(id, {
      txOffsetDb:
        txIdx != null
          ? clamp(beta[txIdx], -OFFSET_BOUND_DB, OFFSET_BOUND_DB)
          : 0, // reference node anchored at 0
      rxOffsetDb:
        rxIdx != null
          ? clamp(beta[rxIdx], -OFFSET_BOUND_DB, OFFSET_BOUND_DB)
          : 0,
    });
  }

  // Build routed-paths map keyed by "txId|rxId" — the API + UI use
  // this to visualize the inferred propagation routes.
  const routedPaths = new Map<string, RoutedPath>();
  for (const r of rows) {
    routedPaths.set(`${r.txId}|${r.rxId}`, r.routed);
  }

  return {
    pathLossExponent,
    wallAttenuationDb,
    exteriorWallAttenuationDb,
    doorAttenuationDb,
    reflectionLossDb,
    referenceRssi1m: refRssi,
    nodeOffsets,
    referenceNodeId,
    rSquared,
    residualStdDb: residualStd,
    pairCount: rows.length,
    totalWeight: effN,
    fittedAtMs: Date.now(),
    routedPaths,
  };
}

// ─── Compute geometry + dispatch a sample (helper called by handler) ────

/**
 * Convenience helper for the MQTT handler: takes node IDs and the
 * raw RSSI, computes obstruction + distance from config, and
 * accumulates into the pair stats. Returns silently when the geometry
 * isn't available (nodes missing from config, etc.).
 */
export function recordCascadeObservation(
  store: Store,
  txId: string,
  rxId: string,
  rssi: number,
  txPoint: readonly [number, number, number],
  rxPoint: readonly [number, number, number],
  walls: PathObstruction,
  trueDistOverride?: number,
): void {
  const dx = txPoint[0] - rxPoint[0];
  const dy = txPoint[1] - rxPoint[1];
  const dz = txPoint[2] - rxPoint[2];
  const trueDist =
    trueDistOverride ?? Math.sqrt(dx * dx + dy * dy + dz * dz);
  accumulatePairRssiSample(store, txId, rxId, rssi, trueDist, walls);
}

/**
 * Standalone wall-counting wrapper that the handler can use without
 * threading the RF cache. Computes interior/exterior/door counts
 * between two points using the floor's walls. Returns null when the
 * RF cache isn't built or the points aren't on a known floor.
 *
 * (Hands off to existing geometry primitives — kept here so callers
 * have a single import for "set up a cascade observation.")
 */
export function obstructionCounts(
  walls: readonly WallSegment[],
  txPoint: readonly [number, number, number],
  rxPoint: readonly [number, number, number],
  txCentroid: readonly [number, number] | undefined,
): PathObstruction {
  return countCrossings(
    txPoint[0],
    txPoint[1],
    rxPoint[0],
    rxPoint[1],
    walls,
    txCentroid,
  );
}

// ─── Internal helpers ────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Gauss-Jordan matrix inverse. Same routine as rf_param_fit.ts uses;
 * duplicated here to keep the module self-contained. Returns null
 * when the matrix is singular within numerical tolerance.
 */
function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const a: number[][] = m.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let i = 0; i < n; i++) {
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
    const piv = a[i][i];
    for (let j = 0; j < 2 * n; j++) a[i][j] /= piv;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = a[k][i];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[k][j] -= factor * a[i][j];
    }
  }
  return a.map((row) => row.slice(n));
}

// ─── Self-test helpers (kept exported for potential test use) ────────────

/**
 * Re-export of the building blocks needed to set up cascade
 * observations from outside this file (avoids the handler needing
 * to import from rf_geometry directly).
 */
export {
  buildWallSegments,
  obstructionLossDb,
  polygonCentroid,
  findRoom,
  type RfParams,
  type WallSegment,
};
