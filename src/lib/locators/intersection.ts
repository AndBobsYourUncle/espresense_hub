import { NadarayaWatsonLocator } from "./nadaraya_watson";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Circle-intersection trilateration locator.
 *
 * Instead of computing a weighted average of node positions (IDW) or
 * minimizing a global objective (BFGS/NM), this locator finds the
 * position where distance circles INTERSECT most consistently:
 *
 *   1. For every pair of nodes, compute the two 2D points where their
 *      measured-distance circles intersect.
 *   2. For each intersection point, score it: how many OTHER circles
 *      pass within a tolerance of it?
 *   3. The intersection point with the highest score is the seed.
 *   4. Refine with a weighted average of the best-scoring intersection
 *      points.
 *
 * Why this works for body-shadow / long-range compression: the 3-4
 * accurate nodes' circles genuinely cross at the true position. The
 * 6-8 inaccurate nodes produce intersections scattered around the map
 * that don't agree with anyone else. The scoring step naturally finds
 * the cluster of real intersections and ignores the noise.
 *
 * Cost: O(n² × n) for n nodes. With n=12 that's ~1700 operations —
 * trivial.
 */
export class IntersectionLocator implements Locator {
  readonly name = "intersection";
  private readonly fallback = new NadarayaWatsonLocator();

  /** Tolerance for "a circle passes near an intersection point". */
  private readonly toleranceM: number;

  constructor(toleranceM = 1.5) {
    this.toleranceM = toleranceM;
  }

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length < 3) {
      return this.fallback.solve(fixes);
    }

    // Step 1: compute all pairwise circle intersections.
    const candidates: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < fixes.length; i++) {
      for (let j = i + 1; j < fixes.length; j++) {
        const pts = circleIntersections(fixes[i], fixes[j]);
        if (pts) {
          candidates.push(pts[0], pts[1]);
        }
      }
    }

    if (candidates.length === 0) {
      return this.fallback.solve(fixes);
    }

    // Step 2: score each candidate — how many circles pass within
    // tolerance of this point?
    let bestScore = -1;
    let bestIdx = 0;
    const scores: number[] = [];

    for (let c = 0; c < candidates.length; c++) {
      const pt = candidates[c];
      let score = 0;
      for (const f of fixes) {
        const dx = pt.x - f.point[0];
        const dy = pt.y - f.point[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const residual = Math.abs(dist - f.distance);
        if (residual <= this.toleranceM) {
          // Weight by closeness to the circle edge — a perfect
          // intersection (residual=0) scores 1.0, tolerance edge
          // scores 0.
          score += 1 - residual / this.toleranceM;
        }
      }
      scores.push(score);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = c;
      }
    }

    // Step 3: refine — weighted average of the top-scoring candidates.
    // Take all candidates that scored at least 70% of the best score.
    const threshold = bestScore * 0.7;
    let wx = 0;
    let wy = 0;
    let wTotal = 0;
    for (let c = 0; c < candidates.length; c++) {
      if (scores[c] >= threshold) {
        const w = scores[c];
        wx += w * candidates[c].x;
        wy += w * candidates[c].y;
        wTotal += w;
      }
    }

    if (wTotal <= 0) {
      return this.fallback.solve(fixes);
    }

    const x = wx / wTotal;
    const y = wy / wTotal;

    // Z from IDW (we only do 2D intersection).
    let zw = 0;
    let zTotal = 0;
    for (const f of fixes) {
      const w = 1 / (f.distance * f.distance + 1e-6);
      zw += w * f.point[2];
      zTotal += w;
    }
    const z = zTotal > 0 ? zw / zTotal : 0;

    // Confidence: based on how many circles agreed at the best point
    // and how tight the cluster is.
    const agreeing = fixes.filter((f) => {
      const dx = x - f.point[0];
      const dy = y - f.point[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      return Math.abs(dist - f.distance) <= this.toleranceM;
    }).length;
    const agreeRatio = agreeing / fixes.length;
    const fixScore = Math.min(1, fixes.length / 6);
    const confidence = Math.max(
      0,
      Math.min(1, agreeRatio * 0.7 + fixScore * 0.3),
    );

    return {
      x,
      y,
      z,
      confidence,
      fixes: fixes.length,
      algorithm: this.name,
    };
  }
}

/**
 * Compute the two intersection points of two circles in 2D.
 * Returns null if the circles don't intersect (too far apart or
 * one contains the other).
 */
function circleIntersections(
  a: NodeFix,
  b: NodeFix,
): [{ x: number; y: number }, { x: number; y: number }] | null {
  const dx = b.point[0] - a.point[0];
  const dy = b.point[1] - a.point[1];
  const d = Math.sqrt(dx * dx + dy * dy);

  // Circles too far apart or one inside the other?
  if (d > a.distance + b.distance) return null;
  if (d < Math.abs(a.distance - b.distance)) return null;
  if (d < 1e-9) return null; // coincident centers

  const aLen =
    (a.distance * a.distance - b.distance * b.distance + d * d) / (2 * d);
  const hSq = a.distance * a.distance - aLen * aLen;
  if (hSq < 0) return null;
  const h = Math.sqrt(hSq);

  // Unit vector from a to b.
  const ux = dx / d;
  const uy = dy / d;

  // Point on the line between centers at distance `aLen` from a.
  const px = a.point[0] + aLen * ux;
  const py = a.point[1] + aLen * uy;

  // Offset perpendicular to the center line.
  return [
    { x: px + h * (-uy), y: py + h * ux },
    { x: px - h * (-uy), y: py - h * ux },
  ];
}
