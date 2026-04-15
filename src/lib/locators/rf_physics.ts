import type { Node, Room } from "@/lib/config";
import { openToId } from "@/lib/config/schema";
import { buildObstructionFn, getRfParams } from "@/lib/map/rf_cache";
import { getStore } from "@/lib/state/store";
import { nelderMead2D } from "./nelder_mead";
import {
  computeAllOverlaps,
  computeRoomAdjacency,
  findRoom,
} from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Physics-driven RF locator.
 *
 * RfRoomAware uses the RF map for *weighting* — it scores candidate
 * positions by their RF coherence with each pair, then refines via a
 * trilateration-style Nelder-Mead. Geometry is the primary signal;
 * RF is a secondary trust modifier.
 *
 * RfPhysics extends that by using the RF model to **pre-adjust the
 * measurements themselves** before trilateration. For each fix:
 *
 *     measured_adjusted = measured / 10^(W(p, node) / (10·a_n))
 *
 * This strips the model-predicted wall attenuation out of the
 * firmware-reported distance, leaving (approximately) the true
 * geometric distance plus whatever attenuation the model didn't
 * capture. Asymmetric distance-space NM then converges to a
 * position that's geometrically consistent with the corrected
 * distances.
 *
 * Why this rather than dB-space residuals: a previous iteration
 * minimized `predicted_rssi - observed_rssi` directly. That's
 * theoretically cleaner but requires the RF model to be very
 * accurate — when the model under-predicts wall loss by 5–15 dB
 * (typical, since multipath / body shadow / fading add real loss the
 * configured walls don't see), the dB-space optimizer is
 * systematically biased to push positions away from nodes to
 * compensate. The measured-distance correction approach degrades
 * gracefully: if W is correct, measured_adjusted = true distance and
 * fit is perfect; if W under-predicts, measured_adjusted is still
 * larger than true but the asymmetric loss handles that exactly the
 * way RfRoomAware does today.
 *
 * Differences from RfRoomAware:
 *
 *   1. **Pre-adjusted measurements** (above) — RfRoomAware fits raw
 *      measured distances; RfPhysics fits measured-with-walls-removed.
 *      In well-modeled paths the corrected distance is closer to
 *      truth, so NM converges tighter.
 *
 *   2. **Per-fix RF coherence weighting.** Fixes from nodes with
 *      heavy attenuation to the candidate are trusted less — noisier
 *      paths contribute less to the position estimate.
 *
 *   3. **Seed selection by physics fit, not just RF score.** After
 *      RF-coherence scoring, evaluate the top candidates against the
 *      physics objective and pick the one with lowest residual as
 *      the NM seed.
 *
 * Falls back to RfRoomAware-equivalent behavior (no measurement
 * adjustment) when the RF cache isn't built yet.
 */

/**
 * Scale (in dB) for the exponential RF weighting in candidate scoring
 * and per-fix weighting. Same as RfRoomAware's value; tested at 4 dB.
 */
const RF_WEIGHT_SCALE_DB = 4;

/** Score concentration power for seed selection (winner takes most). */
const SCORE_CONCENTRATION_POWER = 4;

/** Closest-node room prior bonuses (mirrors RfRoomAware). */
const CLOSEST_ROOM_BONUS = 1.0;
const ADJACENT_ROOM_BONUS = 0.4;
const CLOSEST_PRIOR_MAX_DIST_M = 6;

/** Relative tolerance for "circle agrees with candidate." */
const REL_TOL = 0.15;

/**
 * Asymmetric weighting in the distance-space objective on
 * RF-corrected measurements. Same semantics as RfRoomAware:
 *
 *   residual = calc - measured_adjusted
 *
 *   residual > 0 (calc > adjusted): candidate is FARTHER from node
 *     than the corrected measurement says. Violates the upper-bound
 *     intuition (corrected ≈ true_distance after stripping known
 *     walls). Heavy penalty.
 *
 *   residual < 0 (calc < adjusted): candidate is CLOSER. Possible
 *     when the model under-predicted W (real attenuation > model).
 *     Light penalty.
 */
const ASYM_OVER_WEIGHT = 1.0;
const ASYM_UNDER_WEIGHT = 0.1;

/** Huber inflection in distance-space (meters). Same as RfRoomAware. */
const HUBER_DELTA = 1.5;

/** Number of top RF-scored candidates to evaluate against the physics
 *  objective when picking the seed. More = better seed but more compute. */
const SEED_CANDIDATE_K = 5;

/** Default firmware absorption when a node's value isn't available. */
const DEFAULT_ABSORPTION = 4.0;

/** Default path-loss exponent when RF cache isn't built. */
const DEFAULT_PATH_LOSS_EXPONENT = 3.0;

export class RfPhysicsLocator implements Locator {
  readonly name = "rf_physics";
  private readonly rooms: Room[];
  private readonly nodeRooms: Map<string, string | null>;
  private readonly adjacentPairs: Set<string>;

  constructor(rooms: Room[], nodes: readonly Node[]) {
    this.rooms = rooms;

    const idByLabel = new Map<string, string>();
    for (const r of rooms) {
      const id = r.id;
      if (!id) continue;
      idByLabel.set(id, id);
      if (r.name) idByLabel.set(r.name, id);
    }
    const resolveRoom = (label: string | undefined): string | null =>
      label ? (idByLabel.get(label) ?? null) : null;

    this.adjacentPairs = computeRoomAdjacency(rooms);
    for (const r of rooms) {
      const aId = r.id;
      if (!aId) continue;
      for (const ot of r.open_to) {
        const bId = resolveRoom(openToId(ot));
        if (!bId || bId === aId) continue;
        const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
        this.adjacentPairs.add(key);
      }
    }
    const byArea = new Map<string, string[]>();
    for (const r of rooms) {
      if (!r.id || !r.floor_area) continue;
      const list = byArea.get(r.floor_area) ?? [];
      list.push(r.id);
      byArea.set(r.floor_area, list);
    }
    for (const ids of byArea.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const aId = ids[i];
          const bId = ids[j];
          const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
          this.adjacentPairs.add(key);
        }
      }
    }

    this.nodeRooms = new Map();
    for (const n of nodes) {
      if (!n.id) continue;
      const explicit = resolveRoom(n.room);
      if (explicit) {
        this.nodeRooms.set(n.id, explicit);
      } else if (n.point) {
        this.nodeRooms.set(n.id, findRoom(rooms, [n.point[0], n.point[1]]));
      } else {
        this.nodeRooms.set(n.id, null);
      }
    }
  }

  private roomsConnected(a: string | null, b: string | null): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    return this.adjacentPairs.has(key);
  }

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length < 2) return null;

    const overlaps = computeAllOverlaps(fixes);
    if (overlaps.length === 0) return fallbackIDW(fixes, this.name);

    const obstructionFns = new Map<string, (px: number, py: number) => number>();
    for (const f of fixes) {
      const fn = buildObstructionFn(f.nodeId, [f.point[0], f.point[1]]);
      if (fn) obstructionFns.set(f.nodeId, fn);
    }
    const wAt = (nodeId: string, px: number, py: number): number => {
      const fn = obstructionFns.get(nodeId);
      return fn ? fn(px, py) : 0;
    };

    const store = getStore();
    const lookupR2 = (a: string, b: string): number => {
      const aFits = store.nodePairFits.get(a);
      const bFits = store.nodePairFits.get(b);
      const r1 = aFits?.get(b)?.rSquared ?? 0;
      const r2 = bFits?.get(a)?.rSquared ?? 0;
      return Math.max(r1, r2);
    };

    // Per-node firmware absorption (the value firmware uses to convert
    // RSSI → distance). Used to back-compute the firmware-implied RSSI
    // from the measured distance, and to predict measurements at
    // candidate positions.
    const absorptionByNode = new Map<string, number>();
    for (const f of fixes) {
      const absRaw = store.nodeSettings.get(f.nodeId)?.get("absorption");
      const parsed = absRaw != null ? parseFloat(absRaw) : NaN;
      const a =
        Number.isFinite(parsed) && parsed > 0.1 ? parsed : DEFAULT_ABSORPTION;
      absorptionByNode.set(f.nodeId, a);
    }
    const absFor = (nodeId: string): number =>
      absorptionByNode.get(nodeId) ?? DEFAULT_ABSORPTION;

    // RF model parameters. When the cache isn't built yet, fall back
    // to defaults — the locator degrades to pure trilateration in
    // that mode.
    const rfParams = getRfParams();
    const nPath = rfParams?.pathLossExponent ?? DEFAULT_PATH_LOSS_EXPONENT;
    const rfActive = rfParams != null && obstructionFns.size > 0;

    // Closest-node room prior (same logic as RfRoomAware).
    let closestRoom: string | null = null;
    {
      let bestDist = Infinity;
      let bestNode: string | null = null;
      for (const f of fixes) {
        if (f.distance < bestDist) {
          bestDist = f.distance;
          bestNode = f.nodeId;
        }
      }
      if (bestNode != null && bestDist <= CLOSEST_PRIOR_MAX_DIST_M) {
        closestRoom = this.nodeRooms.get(bestNode) ?? null;
      }
    }

    // ── Stage 1: candidate scoring (same as RfRoomAware) ──
    interface ScoredCandidate {
      cx: number;
      cy: number;
      score: number;
    }
    const scored: ScoredCandidate[] = [];
    for (const o of overlaps) {
      const w1 = wAt(o.nodeId1, o.cx, o.cy);
      const w2 = wAt(o.nodeId2, o.cx, o.cy);
      const rfWeight = Math.exp(-(w1 + w2) / RF_WEIGHT_SCALE_DB);
      const r2 = lookupR2(o.nodeId1, o.nodeId2);
      let pairWeight = o.gdop * rfWeight * (0.5 + 0.5 * r2) * o.sizeWeight;

      if (closestRoom != null) {
        const candidateRoom = findRoom(this.rooms, [o.cx, o.cy]);
        if (candidateRoom === closestRoom) pairWeight *= 1 + CLOSEST_ROOM_BONUS;
        else if (this.roomsConnected(candidateRoom, closestRoom))
          pairWeight *= 1 + ADJACENT_ROOM_BONUS;
      }

      let consensus = 0;
      for (const f of fixes) {
        if (f.nodeId === o.nodeId1 || f.nodeId === o.nodeId2) continue;
        const dx = o.cx - f.point[0];
        const dy = o.cy - f.point[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const residual = Math.abs(dist - f.distance);
        const tol = REL_TOL * f.distance;
        if (residual <= tol) {
          const w = wAt(f.nodeId, o.cx, o.cy);
          const rfBonus = Math.exp(-w / RF_WEIGHT_SCALE_DB);
          consensus += rfBonus * (1 - residual / tol);
        }
      }
      const score = pairWeight * (1 + consensus);
      scored.push({ cx: o.cx, cy: o.cy, score });
    }
    if (scored.length === 0) return fallbackIDW(fixes, this.name);

    // ── Stage 2: distance-space NM with RF-corrected measurements ──
    //
    // For each fix, strip the model-predicted wall loss out of the
    // firmware-reported distance:
    //
    //   measured_adjusted = measured / 10^(W(p, node) / (10·a_n))
    //
    // then minimize the asymmetric Huber residual
    //   r = calc - measured_adjusted
    // (over-residuals heavily penalized; under-residuals lightly,
    // accepting that the model may under-predict W).
    //
    // Per-fix coherence weighting: fixes from heavily-obstructed
    // paths are noisier; trust them less.
    //
    // Note that W (and thus measured_adjusted) is recomputed at every
    // NM step because it depends on the candidate position. That's
    // the point — the RF map participates in defining the objective
    // throughout the optimization.
    const objective = (p: [number, number]): number => {
      let sum = 0;
      for (const f of fixes) {
        const dx = p[0] - f.point[0];
        const dy = p[1] - f.point[1];
        const calc = Math.sqrt(dx * dx + dy * dy);
        if (calc < 0.1) continue;

        const W = rfActive ? wAt(f.nodeId, p[0], p[1]) : 0;
        const aN = absFor(f.nodeId);

        // Strip model-predicted wall loss from the firmware reading.
        // For a path the model captures correctly, adjusted ≈ true
        // distance. For an under-modeled path, adjusted is still
        // bigger than true but only by the unmodeled portion.
        const measuredAdjusted =
          f.distance / Math.pow(10, W / (10 * aN));

        const r = calc - measuredAdjusted;
        const absR = Math.abs(r);
        const lossR =
          absR <= HUBER_DELTA
            ? 0.5 * r * r
            : HUBER_DELTA * (absR - 0.5 * HUBER_DELTA);

        const dirWeight = r > 0 ? ASYM_OVER_WEIGHT : ASYM_UNDER_WEIGHT;
        // Per-fix weighting: closer and less-obstructed → more reliable.
        // Weight uses the *original* measured distance for the 1/d²
        // baseline (closer fixes are intrinsically more reliable
        // regardless of model corrections); the RF coherence factor
        // is independent.
        const baseW = 1 / (f.distance * f.distance + 1e-6);
        const coh = rfActive
          ? Math.exp(-W / RF_WEIGHT_SCALE_DB)
          : 1;
        sum += baseW * coh * dirWeight * lossR;
      }
      return sum;
    };

    // ── Stage 3: pick the seed that the physics objective likes best ──
    //
    // Standard "highest-RF-scored candidate" gives a room-correct
    // seed but may not be the geometric basin NM should converge to.
    // Evaluate the top-K RF-scored candidates against the physics
    // objective itself, pick the one with the lowest residual. NM
    // converges from the most-physics-consistent starting point.
    const topK = [...scored]
      .map((s) => ({
        ...s,
        concentratedScore: Math.pow(
          Math.max(0, s.score),
          SCORE_CONCENTRATION_POWER,
        ),
      }))
      .sort((a, b) => b.concentratedScore - a.concentratedScore)
      .slice(0, Math.min(SEED_CANDIDATE_K, scored.length));

    let bestSeed = topK[0];
    let bestObj = objective([topK[0].cx, topK[0].cy]);
    for (let i = 1; i < topK.length; i++) {
      const obj = objective([topK[i].cx, topK[i].cy]);
      if (obj < bestObj) {
        bestObj = obj;
        bestSeed = topK[i];
      }
    }

    // ── Stage 4: NM refinement ──
    const refined = nelderMead2D(objective, [bestSeed.cx, bestSeed.cy]);
    const posX = refined.x[0];
    const posY = refined.x[1];

    // Z from distance-weighted average.
    let zw = 0;
    let zt = 0;
    for (const f of fixes) {
      const w = 1 / (f.distance * f.distance + 1e-6);
      zw += w * f.point[2];
      zt += w;
    }

    // Confidence: fraction of fixes whose RF-corrected distance is
    // close to |p − node|, weighted by RF coherence. High agreement →
    // high confidence.
    let agreeNum = 0;
    let totalDen = 0;
    for (const f of fixes) {
      const dx = posX - f.point[0];
      const dy = posY - f.point[1];
      const calc = Math.sqrt(dx * dx + dy * dy);
      if (calc < 0.1) continue;
      const W = rfActive ? wAt(f.nodeId, posX, posY) : 0;
      const aN = absFor(f.nodeId);
      const measuredAdjusted =
        f.distance / Math.pow(10, W / (10 * aN));
      const coh = rfActive ? Math.exp(-W / RF_WEIGHT_SCALE_DB) : 1;
      totalDen += coh;
      if (Math.abs(calc - measuredAdjusted) < HUBER_DELTA) agreeNum += coh;
    }
    const agreeRatio = totalDen > 0 ? agreeNum / totalDen : 0;
    const fixScore = Math.min(1, fixes.length / 6);
    const confidence = Math.max(
      0,
      Math.min(1, agreeRatio * 0.6 + fixScore * 0.4),
    );

    return {
      x: posX,
      y: posY,
      z: zt > 0 ? zw / zt : 0,
      confidence,
      fixes: fixes.length,
      algorithm: this.name,
    };
  }
}

function fallbackIDW(fixes: readonly NodeFix[], name: string): LocatorResult {
  let wx = 0;
  let wy = 0;
  let wz = 0;
  let wt = 0;
  for (const f of fixes) {
    const w = 1 / (f.distance * f.distance + 1e-6);
    wx += w * f.point[0];
    wy += w * f.point[1];
    wz += w * f.point[2];
    wt += w;
  }
  return {
    x: wx / wt,
    y: wy / wt,
    z: wz / wt,
    confidence: 0.3,
    fixes: fixes.length,
    algorithm: name,
  };
}
