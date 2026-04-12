import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * "Nearest node" locator — returns the position of whichever node reported
 * the smallest measured distance. Matches the upstream
 * ESPresense-companion `nearest_node` baseline.
 *
 * Useful as a sanity-check baseline in compare mode: if a fancy locator
 * lands further from the device than this, something is wrong.
 *
 * Confidence shrinks as the smallest distance grows — a nearest node that's
 * still 6 m away is much weaker evidence than one that's 0.5 m away.
 */
export class NearestNodeLocator implements Locator {
  readonly name = "nearest_node";

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length === 0) return null;

    let best = fixes[0];
    for (let i = 1; i < fixes.length; i++) {
      if (fixes[i].distance < best.distance) best = fixes[i];
    }

    // Confidence: 1.0 when the device is "at" the node (distance ≈ 0),
    // decaying to 0 as the smallest distance approaches 10 m. This
    // mirrors the geometric fact that nearest-node is a great estimator
    // when the device really is on top of a node, and a poor one as the
    // device gets further away.
    const confidence = Math.max(0, 1 - best.distance / 10);

    return {
      x: best.point[0],
      y: best.point[1],
      z: best.point[2],
      confidence,
      fixes: fixes.length,
      algorithm: this.name,
    };
  }
}
