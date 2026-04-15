import type { Node, Room } from "@/lib/config";
import { openToId } from "@/lib/config/schema";
import { buildObstructionFn } from "@/lib/map/rf_cache";
import { getStore } from "@/lib/state/store";
import { nelderMead2D } from "./nelder_mead";
import {
  computeAllOverlaps,
  computeRoomAdjacency,
  findRoom,
} from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * RF-aware variant of RoomAwareLocator.
 *
 * Replaces RoomAware's binary cross-room weighting (1.0 / 0.8 / 0.005)
 * with a continuous attenuation-based score from the RF map:
 *
 *     pairWeight = exp( −(W(n1, candidate) + W(n2, candidate)) / SCALE )
 *
 * where W is in dB. Pairs whose signal would have to traverse heavy
 * walls to reach the candidate get exponentially down-weighted, but
 * never to literally zero — they still contribute information about
 * "the device probably isn't on the far side of those walls."
 *
 * Three additional ingredients beyond pure RF weighting:
 *
 * 1. **Score concentration via power**: candidates' centroid weight is
 *    `score^POWER` rather than `score`. Equivalent to a soft "winner
 *    takes most" — keeps wrong-room candidates from tugging the
 *    centroid even when their RF weight isn't quite zero.
 *
 * 2. **Closest-node room prior**: the closest-distance reporting node
 *    is essentially ground truth on which room the device is in (BLE
 *    at very short range is dominated by line-of-sight). Candidates
 *    that fall in the closest-node's room get a meaningful score
 *    bonus; candidates in adjacent rooms get a smaller bonus. This
 *    breaks the symmetry near walls — pure RF weighting from a
 *    wall-mounted node gives nearly-equal weight to candidates on
 *    either side of the wall, which lets the geometric trilateration
 *    pull pick the wrong side. The room prior captures a
 *    measurement-based signal that RF physics alone cannot infer.
 *
 * 3. **Continuous RF coherence (the original idea)**: every cross-pair
 *    contribution scales with how much structural attenuation lies
 *    between the pair's nodes and the candidate position.
 *
 * **Why all three are needed**: the continuous RF weighting handles the
 * far-from-wall cases (RoomAware over-penalized adjacent rooms there).
 * The closest-node room prior handles wall-hugging cases (pure RF
 * weighting is symmetric across walls, so the geometric pull from far
 * nodes can win the wrong side). The score-concentration power keeps
 * the wrong-room minority of candidates from tugging the position.
 *
 * **Falls back to RoomAware-style geometry** when the RF cache isn't
 * available (pre-bootstrap or fresh deploy). The obstruction-fn
 * builder returns null in that case and we treat W as 0.
 */

/**
 * Scale (in dB) for the exponential RF weighting. See the table below
 * for what this maps to in attenuation terms:
 *
 *   W (dB)    weight (scale=4)
 *   ─────────────────────────────
 *   0         1.00     (open path, same room)
 *   2         0.61     (one open doorway / thin wall)
 *   4         0.37     (one drywall)
 *   8         0.14     (two drywalls, or one exterior)
 *   12        0.05     (three drywalls)
 *   20        0.007    (heavy walls + exterior)
 */
const RF_WEIGHT_SCALE_DB = 4;

/**
 * Power applied to candidate scores when computing the position
 * centroid. Higher = more "winner takes most." See doc comment at
 * top of file for the design rationale.
 */
const SCORE_CONCENTRATION_POWER = 4;

/**
 * Multiplicative bonus applied to candidates whose room matches the
 * closest-distance-reporting node's room. With BONUS=1.0, in-room
 * candidates double their score (factor 2.0); after the
 * SCORE_CONCENTRATION_POWER they dominate in-room contributions by a
 * very large margin (2^4 = 16× the centroid weight of out-of-room
 * candidates). Tuned to be strong enough to win wall-hugging cases
 * while still letting clear cross-room evidence override.
 */
const CLOSEST_ROOM_BONUS = 1.0;

/**
 * Multiplicative bonus for candidates in rooms ADJACENT to the
 * closest-node's room. Adjacent = shares a polygon edge or has an
 * `open_to` declaration or shares a `floor_area` tag. Smaller than
 * the in-room bonus so the closest-node's room still wins ties, but
 * non-zero so a device standing at a doorway can land on either side.
 */
const ADJACENT_ROOM_BONUS = 0.4;

/**
 * Minimum distance at which the closest-node room prior fires. If the
 * "closest" node is itself far away, its room signal is weak and we'd
 * rather let pure RF weighting decide. 6 m is roughly the threshold
 * where BLE measurements become geometry-noisy enough that "device is
 * in this node's room" stops being a reliable inference.
 */
const CLOSEST_PRIOR_MAX_DIST_M = 6;

/**
 * Relative tolerance for "circle agrees with candidate" — same as
 * RoomAware. A circle counts as agreeing if its residual is within
 * 15% of its measured distance.
 */
const REL_TOL = 0.15;

/**
 * Asymmetric loss inflection point in the post-seed trilateration
 * step (replaces the symmetric Huber from earlier iterations).
 *
 * Why asymmetric: BLE distance measurements are nearly always
 * upper-bound estimates of the true device-to-node distance — path
 * loss, walls, body shadow, and clutter all *add* attenuation
 * (making the device look further than it is); essentially nothing
 * makes the firmware's distance shorter than reality. So the
 * residual `r = calc(p) − measured` has a meaningful sign:
 *
 *   r > 0  (calc > measured): the candidate position is FARTHER
 *          from the node than the measurement says. The
 *          measurement is approximately an upper bound, so this
 *          violates physics — the candidate should not be there.
 *          Heavy quadratic penalty.
 *
 *   r < 0  (calc < measured): the candidate is CLOSER than the
 *          measured distance. Exactly what we expect for any path
 *          with any obstruction. Light penalty.
 *
 * The asymmetric weighting steers the optimizer into the
 * intersection of the disks centered at each node (radius =
 * measured distance) — and the intersection of disks always
 * contains the true position. Naturally keeps the position inside
 * the building without any geometric patches.
 *
 * This is the principled answer to "trilateration converges
 * outside the building": the symmetric Huber treats overshoot and
 * undershoot equally, even though overshoot is the only physical
 * possibility. Asymmetric loss aligns the math with the physics.
 */
const ASYM_OVER_WEIGHT = 1.0;
const ASYM_UNDER_WEIGHT = 0.1;
const HUBER_DELTA = 1.5;

export class RfRoomAwareLocator implements Locator {
  readonly name = "rf_room_aware";
  private readonly rooms: Room[];
  private readonly nodeRooms: Map<string, string | null>;
  private readonly adjacentPairs: Set<string>;

  constructor(rooms: Room[], nodes: readonly Node[]) {
    this.rooms = rooms;

    // Same room/node bookkeeping RoomAware does — id-or-name resolver,
    // adjacency from shared edges + open_to + floor_area, and per-node
    // explicit-or-geometric room assignment.
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

    // Pre-build per-fix obstruction closures.
    const obstructionFns = new Map<string, (px: number, py: number) => number>();
    for (const f of fixes) {
      const fn = buildObstructionFn(f.nodeId, [f.point[0], f.point[1]]);
      if (fn) obstructionFns.set(f.nodeId, fn);
    }
    const wAt = (nodeId: string, px: number, py: number): number => {
      const fn = obstructionFns.get(nodeId);
      return fn ? fn(px, py) : 0;
    };

    // Closest-node room prior: identify the closest-distance reporting
    // node and use its assigned room as a tiebreaker for candidates.
    // Skipped (set to null) when the closest node is far enough away
    // that its room inference is no longer reliable.
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

    // Per-pair calibration r².
    const store = getStore();
    const lookupR2 = (a: string, b: string): number => {
      const aFits = store.nodePairFits.get(a);
      const bFits = store.nodePairFits.get(b);
      const r1 = aFits?.get(b)?.rSquared ?? 0;
      const r2 = bFits?.get(a)?.rSquared ?? 0;
      return Math.max(r1, r2);
    };

    interface ScoredCandidate {
      cx: number;
      cy: number;
      score: number;
    }
    const scored: ScoredCandidate[] = [];

    for (const o of overlaps) {
      // RF coherence between the pair and the candidate position.
      const w1 = wAt(o.nodeId1, o.cx, o.cy);
      const w2 = wAt(o.nodeId2, o.cx, o.cy);
      const rfWeight = Math.exp(-(w1 + w2) / RF_WEIGHT_SCALE_DB);

      const r2 = lookupR2(o.nodeId1, o.nodeId2);
      let pairWeight = o.gdop * rfWeight * (0.5 + 0.5 * r2) * o.sizeWeight;

      // Closest-node room prior: figure out which room the candidate
      // sits in via point-in-polygon, then bonus based on relationship
      // to the closest-node's room. This is the bit that breaks
      // wall-hugging symmetry — pure RF weighting from a wall-mounted
      // node gives near-equal scores to candidates on either side of
      // the wall, but the closest-node's room is a strong measurement-
      // based signal that breaks the tie.
      if (closestRoom != null) {
        const candidateRoom = findRoom(this.rooms, [o.cx, o.cy]);
        if (candidateRoom === closestRoom) {
          pairWeight *= 1 + CLOSEST_ROOM_BONUS;
        } else if (this.roomsConnected(candidateRoom, closestRoom)) {
          pairWeight *= 1 + ADJACENT_ROOM_BONUS;
        }
        // Non-adjacent: no bonus (factor 1.0). The RF weighting
        // already discounts these via W; we don't pile on additional
        // penalty here, the prior is purely a positive nudge.
      }

      // Consensus: how many OTHER circles pass through this candidate,
      // each contribution weighted by its own RF coherence with the
      // candidate position?
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

    // Two-stage position: first pick a room-aware seed via the
    // RF-weighted scoring, then refine via Nelder-Mead trilateration
    // for geometric accuracy.
    //
    // Why two stages: the score-weighted centroid alone (the original
    // RfRoomAware design) finds the *right room* but is positionally
    // biased — the centroid averages many candidate intersection
    // points, and most pairs contribute candidates that aren't at the
    // true geometric solution. Trilateration solvers (MLE/NM/BFGS) get
    // the position right but can land in the wrong room when the
    // geometry is ambiguous near walls. Combining them: use the
    // RF-weighted top candidate as the NM seed (room-correct), then
    // let NM find the geometric optimum within that room's basin.
    //
    // The seed is the single highest-scoring candidate (after
    // SCORE_CONCENTRATION_POWER amplification), not the weighted
    // centroid — picking a real intersection point rather than an
    // averaged one gives NM a starting point that's already near a
    // local minimum of the objective.
    if (scored.length === 0) return fallbackIDW(fixes, this.name);
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

    // NM with an asymmetric weighted Huber objective. Σ w_i · ρ(r_i)
    // where r_i = ||p − node_i|| − measured_i and ρ is the asymmetric
    // Huber: full weight when r > 0 (candidate is farther from node
    // than measured, which violates the upper-bound physics of BLE
    // distance), 10% weight when r < 0 (candidate is closer than
    // measured, which is the expected direction of measurement
    // overshoot — perfectly fine, no need to penalize).
    //
    // The standard 1/d² weighting still applies (closer measurements
    // are more reliable than far ones). Huber linearization above
    // delta=1.5m keeps a single wild outlier from dominating.
    //
    // This is the principled fix for "trilateration converges
    // outside the building." Symmetric loss treats `calc > measured`
    // and `calc < measured` equally, but only the latter is
    // physically possible — every BLE measurement overestimates true
    // distance by some amount. Asymmetric loss aligns the math with
    // the physics; the optimum naturally sits inside the
    // intersection of the disks (radius = measured) which always
    // contains the device. No outside-room patch needed.
    const objective = (p: [number, number]): number => {
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
        const dirWeight = r > 0 ? ASYM_OVER_WEIGHT : ASYM_UNDER_WEIGHT;
        const w = (1 / (f.distance * f.distance + 1e-6)) * dirWeight;
        sum += w * lossR;
      }
      return sum;
    };
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

    // Confidence: weighted "how many circles agree at the chosen
    // position" where the weight is each fix's RF coherence with the
    // final position.
    let agreeNum = 0;
    let totalDen = 0;
    for (const f of fixes) {
      const w = wAt(f.nodeId, posX, posY);
      const rfWeight = Math.exp(-w / RF_WEIGHT_SCALE_DB);
      totalDen += rfWeight;
      const dx = posX - f.point[0];
      const dy = posY - f.point[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(dist - f.distance) < 1.5) agreeNum += rfWeight;
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
