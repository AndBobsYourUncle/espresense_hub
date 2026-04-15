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
 * Two RF-map-driven changes from RfRoomAware:
 *
 *   1. **Measurement correction**: each firmware-reported distance
 *      is divided by `10^(W / (10·a_n))` to strip the model-predicted
 *      wall loss before trilateration. For paths the RF map captures
 *      correctly, the corrected distance is approximately the true
 *      geometric distance.
 *
 *   2. **Per-fix RF reliability weighting**: each fix's contribution
 *      to the NM objective is weighted by `exp(-W / 2 dB)`. Far or
 *      wall-heavy fixes effectively drop out of the optimization.
 *      Mirrors RoomAware's hard cross-room weight cut, but
 *      continuous and tied to actual attenuation rather than binary
 *      topology.
 *
 * The motivating problem: in real BLE deployments, *long-distance
 * fixes systematically undershoot* — firmware absorption is tuned for
 * short cluttered paths, so for long open paths it over-attenuates
 * and reports distances much shorter than reality. The asymmetric
 * loss in RfRoomAware (which assumes overshoot is the typical
 * direction) then pulls position toward those wrong far-fix
 * measurements.
 *
 * Per-fix RF reliability weighting downweights those problematic
 * long fixes, letting nearby clean-path fixes dominate. The
 * measurement correction further refines what's left.
 *
 * Falls back to RfRoomAware-equivalent behavior (no measurement
 * adjustment, uniform per-fix weight) when the RF cache isn't built.
 */

/**
 * Scale (in dB) for the exponential RF weighting in candidate
 * scoring (pair coherence). Same as RfRoomAware's value; tested at
 * 4 dB.
 */
const RF_WEIGHT_SCALE_DB = 4;

/**
 * Scale (in dB) for per-fix reliability weighting inside the NM
 * objective. Sharper than the candidate-scoring scale because we
 * want fixes from far/walled paths to effectively drop out of the
 * fit — these measurements are noisy enough (multipath, body shadow,
 * firmware-absorption mismatch over long paths) that they actively
 * mislead the optimizer when included with non-trivial weight.
 *
 *   W (dB)    weight
 *   ─────────────────
 *   0         1.00     (open path, fully trusted)
 *   2         0.37     (one open doorway, half-trusted)
 *   4         0.14     (one drywall, mostly ignored)
 *   6         0.05     (two walls, near-zero)
 *   8         0.018    (heavy obstruction, dropped)
 *
 * Effectively a continuous "drop fixes whose paths the model says
 * are unreliable" — the analogue of RoomAware's hard ternary cut for
 * cross-room measurements, but graded by actual attenuation.
 */
const RF_FIX_RELIABILITY_SCALE_DB = 2;

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

/** Default firmware absorption when a node's value isn't available. */
const DEFAULT_ABSORPTION = 4.0;

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

    // RF model active flag. When the cache isn't built yet, the
    // measurement correction degrades to a no-op (W=0 → adjustment
    // factor = 1 → measured_adjusted = measured) and behavior is
    // identical to RfRoomAware.
    const rfParams = getRfParams();
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

    // Distance-space NM with RF-corrected measurements AND per-fix
    // RF reliability weighting. For each fix:
    //
    //   measured_adjusted = measured / 10^(W(p, node) / (10·a_n))
    //   r                 = calc - measured_adjusted
    //   reliability       = exp(-W(p, node) / RF_FIX_RELIABILITY_SCALE_DB)
    //
    // then minimize Σ (1/d²) · reliability · ρ_asym(r).
    //
    // The reliability factor is the new ingredient. Far/walled fixes
    // (high W from the candidate) get exponentially down-weighted,
    // mirroring what RoomAware achieves with its hard cross-room
    // weight cut — except continuously and tied to the actual RF map
    // rather than binary topology. The sharper scale (2 dB vs 4 for
    // pair scoring) makes it aggressive enough that high-W fixes
    // effectively drop out: at W≥6 dB their contribution is <5%.
    //
    // Why this matters: long-path measurements undershoot
    // systematically (firmware absorption is calibrated for short
    // cluttered paths, so it over-attenuates the long ones and
    // reports too-short distances). Without per-fix RF weighting,
    // those wrong measurements pull the optimizer in the wrong
    // direction. With it, they're effectively ignored and the
    // optimizer focuses on local clean fixes.
    //
    // W is recomputed at every NM step because it depends on the
    // candidate position — that's the point, the RF map participates
    // in the objective throughout the optimization.
    const objective = (p: [number, number]): number => {
      let sum = 0;
      for (const f of fixes) {
        const dx = p[0] - f.point[0];
        const dy = p[1] - f.point[1];
        const calc = Math.sqrt(dx * dx + dy * dy);
        if (calc < 0.1) continue;

        const W = rfActive ? wAt(f.nodeId, p[0], p[1]) : 0;
        const aN = absFor(f.nodeId);

        const measuredAdjusted =
          f.distance / Math.pow(10, W / (10 * aN));

        const r = calc - measuredAdjusted;
        const absR = Math.abs(r);
        const lossR =
          absR <= HUBER_DELTA
            ? 0.5 * r * r
            : HUBER_DELTA * (absR - 0.5 * HUBER_DELTA);

        const dirWeight = r > 0 ? ASYM_OVER_WEIGHT : ASYM_UNDER_WEIGHT;
        const baseW = 1 / (f.distance * f.distance + 1e-6);
        const reliability = rfActive
          ? Math.exp(-W / RF_FIX_RELIABILITY_SCALE_DB)
          : 1;
        sum += baseW * reliability * dirWeight * lossR;
      }
      return sum;
    };

    // Pick the seed: highest-RF-scored candidate (after concentration
    // power amplification). Same selection as RfRoomAware.
    let bestSeedIdx = 0;
    let bestSeedScore = -Infinity;
    for (let i = 0; i < scored.length; i++) {
      const w = Math.pow(Math.max(0, scored[i].score), SCORE_CONCENTRATION_POWER);
      if (w > bestSeedScore) {
        bestSeedScore = w;
        bestSeedIdx = i;
      }
    }

    const refined = nelderMead2D(objective, [
      scored[bestSeedIdx].cx,
      scored[bestSeedIdx].cy,
    ]);
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
    // within Huber-delta of |p − node|. Same form as RfRoomAware,
    // computed on corrected distances.
    let agreeing = 0;
    let total = 0;
    for (const f of fixes) {
      const dx = posX - f.point[0];
      const dy = posY - f.point[1];
      const calc = Math.sqrt(dx * dx + dy * dy);
      if (calc < 0.1) continue;
      const W = rfActive ? wAt(f.nodeId, posX, posY) : 0;
      const aN = absFor(f.nodeId);
      const measuredAdjusted =
        f.distance / Math.pow(10, W / (10 * aN));
      total += 1;
      if (Math.abs(calc - measuredAdjusted) < HUBER_DELTA) agreeing += 1;
    }
    const agreeRatio = total > 0 ? agreeing / total : 0;
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
