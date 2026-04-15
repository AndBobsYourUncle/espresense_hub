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
 * Physics-driven RF locator using raw RSSI.
 *
 * Bypasses firmware's absorption-based distance conversion entirely.
 * For each fix, takes the raw RSSI value the firmware actually
 * received and compares it against what the RF model predicts for
 * the candidate position:
 *
 *     predicted_rssi(p) = ref_1m − 10·n_path·log10(|p−node|) − W(p, node)
 *
 *     residual_dB       = predicted_rssi − observed_rssi
 *
 * Minimize Σ ρ(residual_dB) over all fixes via Nelder-Mead.
 *
 * Why use raw RSSI: firmware converts RSSI → distance using a single
 * absorption setting that's inevitably miscalibrated for some path
 * types (typically: tuned for short cluttered paths, so long open
 * paths systematically undershoot). Working with the firmware-
 * converted distance inherits that lossy conversion. Working with
 * the raw RSSI lets the RF model do the conversion using its full
 * knowledge of walls and path-loss exponent.
 *
 * Asymmetric weighting in dB-space:
 *
 *   residual > 0  (predicted > observed): observed signal is weaker
 *                  than the model predicts. Could be (a) candidate
 *                  too close to node, or (b) model under-predicts
 *                  attenuation along this path (multipath, body
 *                  shadow, walls the map doesn't capture). Light
 *                  penalty — (b) is common and we don't want to
 *                  penalize positions just because our model is
 *                  imperfect.
 *
 *   residual < 0  (predicted < observed): observed signal is
 *                  stronger than the model predicts. The only
 *                  physical explanation is "candidate too far from
 *                  node" — the RF model basically can't UNDER-
 *                  predict attenuation. Heavy penalty.
 *
 * Same physical reasoning as the distance-space asymmetric loss in
 * RfRoomAware, just expressed in the natural (dB) units of the
 * actual measurement.
 *
 * Falls back to RfRoomAware-equivalent distance-based behavior for
 * any fix without raw RSSI (legacy or test-constructed fixes).
 */

const RF_WEIGHT_SCALE_DB = 4;
const SCORE_CONCENTRATION_POWER = 4;
const CLOSEST_ROOM_BONUS = 1.0;
const ADJACENT_ROOM_BONUS = 0.4;
const CLOSEST_PRIOR_MAX_DIST_M = 6;
const REL_TOL = 0.15;

/**
 * Asymmetric weighting in dB-space residuals (predicted − observed).
 * Positive residuals are common when the RF model under-predicts
 * attenuation; negative residuals only happen when the candidate is
 * too far from the node.
 */
const ASYM_OVER_WEIGHT = 1.0;
const ASYM_UNDER_WEIGHT = 0.15;

/**
 * Huber inflection in dB. BLE RSSI noise is ~5–10 dB at the per-
 * measurement level; δ=8 keeps the loss quadratic for typical noise
 * and linear for larger excursions (one heavy-multipath measurement
 * doesn't dominate the fit).
 */
const HUBER_DELTA_DB = 8;

/** Reference / default values when RF cache or per-node data is missing. */
const DEFAULT_REF_RSSI_1M = -59;
const DEFAULT_PATH_LOSS_EXPONENT = 3.0;
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

    // RF model parameters from the cache (or defaults if unavailable).
    const rfParams = getRfParams();
    const refRssi = rfParams?.referenceRssi1m ?? DEFAULT_REF_RSSI_1M;
    const nPath = rfParams?.pathLossExponent ?? DEFAULT_PATH_LOSS_EXPONENT;
    const rfActive = rfParams != null && obstructionFns.size > 0;

    // Per-node firmware absorption — used for the *fallback* path
    // when a fix doesn't carry raw RSSI (back-compute observed RSSI
    // from the firmware-converted distance). For the primary path
    // (raw RSSI present), we don't need it.
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

    /**
     * Resolve the observed RSSI for a fix. Prefers the raw RSSI
     * field from the MQTT message; falls back to back-computing
     * from the firmware-converted distance using the node's
     * absorption setting (which inherits firmware's conversion
     * lossiness, but is better than nothing for legacy fixes).
     */
    const observedRssiFor = (fix: NodeFix): number => {
      if (fix.rssi != null && Number.isFinite(fix.rssi)) return fix.rssi;
      const a = absFor(fix.nodeId);
      // Inverse of m = 10^((tx_ref - rssi)/(10·a)) → rssi = tx_ref − 10·a·log10(m)
      // Approximate tx_ref ≈ refRssi (assumes nodes are calibrated to the
      // same 1 m reference; per-node deviation is absorbed into the
      // overall calibration error budget).
      return refRssi - 10 * a * Math.log10(Math.max(0.1, fix.distance));
    };

    // Closest-node room prior (by measured distance, same as RfRoomAware).
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

    // ── Stage 2: NM in RSSI dB-space ──
    //
    //   predicted_rssi(p, node) = ref_1m − 10·n_path·log10(|p−node|) − W(p, node)
    //   residual                 = predicted_rssi − observed_rssi
    //   minimize Σ ρ_asym(residual)
    //
    // Per-fix weighting: variance of BLE RSSI is roughly constant in
    // dB space across signal levels, so a uniform weight is more
    // appropriate than the 1/d² we used for distance-space objectives.
    // We keep a mild RF-coherence factor — fixes from heavily
    // attenuated paths still get less trust because their predicted
    // RSSI is more sensitive to W errors.
    const objective = (p: [number, number]): number => {
      let sum = 0;
      for (const f of fixes) {
        const dx = p[0] - f.point[0];
        const dy = p[1] - f.point[1];
        const calc = Math.sqrt(dx * dx + dy * dy);
        if (calc < 0.1) continue;

        const W = rfActive ? wAt(f.nodeId, p[0], p[1]) : 0;
        const predictedRssi =
          refRssi - 10 * nPath * Math.log10(calc) - W;
        const observedRssi = observedRssiFor(f);
        const residualDb = predictedRssi - observedRssi;

        const absR = Math.abs(residualDb);
        const lossR =
          absR <= HUBER_DELTA_DB
            ? 0.5 * residualDb * residualDb
            : HUBER_DELTA_DB * (absR - 0.5 * HUBER_DELTA_DB);

        const dirWeight = residualDb > 0 ? ASYM_OVER_WEIGHT : ASYM_UNDER_WEIGHT;
        const coh = rfActive ? Math.exp(-W / RF_WEIGHT_SCALE_DB) : 1;
        sum += coh * dirWeight * lossR;
      }
      return sum;
    };

    // Pick the seed: highest-RF-scored candidate.
    let bestSeedIdx = 0;
    let bestSeedScore = -Infinity;
    for (let i = 0; i < scored.length; i++) {
      const w = Math.pow(Math.max(0, scored[i].score), SCORE_CONCENTRATION_POWER);
      if (w > bestSeedScore) {
        bestSeedScore = w;
        bestSeedIdx = i;
      }
    }
    const seedX = scored[bestSeedIdx].cx;
    const seedY = scored[bestSeedIdx].cy;

    const refined = nelderMead2D(objective, [seedX, seedY]);
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

    // Confidence: fraction of fixes whose RSSI residual at the
    // converged position is within typical BLE noise (Huber delta).
    let agreeing = 0;
    let total = 0;
    for (const f of fixes) {
      const dx = posX - f.point[0];
      const dy = posY - f.point[1];
      const calc = Math.sqrt(dx * dx + dy * dy);
      if (calc < 0.1) continue;
      const W = rfActive ? wAt(f.nodeId, posX, posY) : 0;
      const predictedRssi = refRssi - 10 * nPath * Math.log10(calc) - W;
      const observedRssi = observedRssiFor(f);
      total += 1;
      if (Math.abs(predictedRssi - observedRssi) < HUBER_DELTA_DB) agreeing += 1;
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
