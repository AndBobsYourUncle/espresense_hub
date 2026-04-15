import { buildObstructionFn } from "@/lib/map/rf_cache";
import { getStore } from "@/lib/state/store";
import { computeAllOverlaps } from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * RF-aware variant of RoomAwareLocator.
 *
 * RoomAware downweights cross-room circle overlaps via a hardcoded
 * ternary (1.0 / 0.8 / 0.005) based on whether the two pair nodes are
 * in the same / adjacent / non-adjacent room as a vote-determined
 * "device room." That weighting is insensitive to HOW different two
 * rooms are RF-wise: nursery↔guest_bedroom (one drywall) and
 * garage↔master_bathroom (5+ walls + exterior) both collapse to the
 * same 0.005 weight, which is too punishing for the former and too
 * lenient for the latter.
 *
 * This locator replaces the ternary with a continuous weighting based
 * on the actual structural attenuation between each pair node and the
 * candidate position, computed from the RF map (`obstructionLossDb`):
 *
 *     pairWeight = exp( −(W(n1, candidate) + W(n2, candidate)) / SCALE )
 *
 * where W is in dB. Pairs whose signal would have to traverse heavy
 * walls to reach the candidate get exponentially down-weighted, but
 * never to literally zero — they still contribute information about
 * "the device probably isn't on the far side of those walls."
 *
 * The closest-node room vote and the iterative room refinement from
 * RoomAware are dropped — they were a workaround for the ternary's
 * binary "is this room or not" question. With continuous RF cost,
 * every candidate position is scored on its own RF coherence with
 * each pair, no need to commit to a room first.
 *
 * **Why same-or-similar weighting still works for short paths**: when
 * both pair nodes are in the same room as the candidate (W ≈ 0 for
 * both), the exponent is 1.0 — equivalent to RoomAware's SAME_ROOM
 * weight. When one node is across one wall (W ≈ 2–4 dB), weight drops
 * to ~0.5–0.7 — between RoomAware's SAME (1.0) and ADJACENT (0.8).
 * When across multiple walls or an exterior (W ≈ 10+ dB), weight drops
 * to ~0.2 or below — comparable to RoomAware's CROSS_ROOM (0.005)
 * but never quite zero.
 *
 * **Falls back to RoomAware's geometry** when the RF cache isn't
 * available (pre-bootstrap or fresh deploy). The obstruction-fn
 * builder returns null in that case and we treat W as 0 — the locator
 * reduces to a uniformly-weighted pairwise overlap voter.
 */

/**
 * Scale (in dB) for the exponential RF weighting. Hand-tuned so the
 * per-wall penalty is meaningful but not catastrophic:
 *
 *   W (dB)    weight
 *   ─────────────────
 *   0         1.00     (open path, same room)
 *   2         0.61     (one open doorway through a thin wall)
 *   4         0.37     (one drywall)
 *   8         0.14     (two drywalls, or one exterior)
 *   12        0.05     (three drywalls)
 *   20        0.007    (heavy walls + exterior)
 *
 * Smaller scale → harder cutoff (more like the old ternary). Larger
 * scale → softer cutoff (cross-wall paths matter more). 4 dB is the
 * sweet spot we landed on after observing wrong-room failures with
 * scale=6: scale=6 left cross-wall candidates with too much weight
 * (one wall → 0.51, still nearly half the influence of a clean path),
 * which let a noisy wrong-room fix pull the centroid out of the right
 * room. scale=4 drops one wall to ~0.37 and two walls to ~0.14 —
 * cross-wall candidates contribute but no longer dominate.
 */
const RF_WEIGHT_SCALE_DB = 4;

/**
 * Power applied to candidate scores when computing the position
 * centroid: `position = Σ score_i^POWER × candidate_i / Σ score_i^POWER`.
 *
 * With POWER=1 (plain weighted centroid), a wrong-room candidate
 * with score 0.4 contributes 40% as much to the position as a
 * right-room candidate with score 1.0 — enough to noticeably tug the
 * estimate when several wrong-room candidates pile up. With POWER=4,
 * the same wrong-room candidate contributes only 0.4⁴ = 2.5% — the
 * top-scoring cluster dominates and the wrong-room contributions
 * fade to near-zero noise.
 *
 * Equivalent to a soft "winner takes most" without the brittleness
 * of picking a single hard winner (which would be vulnerable to a
 * lucky high-score candidate at the wrong spot). The power value is
 * a tuning knob: too low and wrong-room failures recur; too high and
 * single-candidate sensitivity returns.
 */
const SCORE_CONCENTRATION_POWER = 4;

/**
 * Relative tolerance for "circle agrees with candidate" — same as
 * RoomAware. A circle counts as agreeing if its residual is within
 * 15% of its measured distance.
 */
const REL_TOL = 0.15;

export class RfRoomAwareLocator implements Locator {
  readonly name = "rf_room_aware";

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length < 2) return null;

    const overlaps = computeAllOverlaps(fixes);
    if (overlaps.length === 0) return fallbackIDW(fixes, this.name);

    // Pre-build per-fix obstruction closures. Each computes dB loss
    // from that node to a target point. Cached at the start so we
    // don't re-do the floor/wall lookup per candidate.
    const obstructionFns = new Map<string, (px: number, py: number) => number>();
    for (const f of fixes) {
      const fn = buildObstructionFn(f.nodeId, [f.point[0], f.point[1]]);
      if (fn) obstructionFns.set(f.nodeId, fn);
    }
    const wAt = (nodeId: string, px: number, py: number): number => {
      const fn = obstructionFns.get(nodeId);
      return fn ? fn(px, py) : 0;
    };

    // Per-pair calibration r² — same trust signal RoomAware uses.
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
      // RF coherence: how much would signal need to traverse to
      // reach this candidate from each of the pair's two nodes?
      // Sum and exponentiate — joint coherence of the pair.
      const w1 = wAt(o.nodeId1, o.cx, o.cy);
      const w2 = wAt(o.nodeId2, o.cx, o.cy);
      const rfWeight = Math.exp(-(w1 + w2) / RF_WEIGHT_SCALE_DB);

      const r2 = lookupR2(o.nodeId1, o.nodeId2);
      const pairWeight = o.gdop * rfWeight * (0.5 + 0.5 * r2) * o.sizeWeight;

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

    // Concentrated weighted centroid: weight ∝ score^POWER. Pure
    // weighted centroid (POWER=1) lets wrong-room candidates with
    // moderate scores still pull the position; raising to a power
    // amplifies the dominance of the top-scoring cluster so the
    // centroid lands in it rather than in the no-man's-land between
    // it and the runner-up. Equivalent to a soft "winner takes most."
    let wx = 0;
    let wy = 0;
    let wTotal = 0;
    for (const s of scored) {
      const w = Math.pow(Math.max(0, s.score), SCORE_CONCENTRATION_POWER);
      wx += w * s.cx;
      wy += w * s.cy;
      wTotal += w;
    }
    if (wTotal <= 1e-9) return fallbackIDW(fixes, this.name);
    const posX = wx / wTotal;
    const posY = wy / wTotal;

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
    // final position. Penalizes solutions where high-coherence fixes
    // (clear-path nodes) disagree with the picked spot.
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

/**
 * Same fallback as RoomAware's: pure IDW when no circles intersect
 * (typically because all reported distances are mutually exclusive,
 * which means at least some are wildly off and any geometric solver
 * would struggle).
 */
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
