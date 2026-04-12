import type { Node, Room } from "@/lib/config";
import { findRoom, pointInPolygon } from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * "Nearest node" locator — picks whichever node reported the smallest
 * measured distance, then places the device at the *centroid of that
 * node's room* rather than at the node itself.
 *
 * Why room centroid instead of node coordinates? The genuine information
 * this baseline produces is "the device is in the same room as node X".
 * Putting the marker at node X's exact position pretends to know more
 * than that, and visually competes with the geometric locators when it
 * shouldn't. The room centroid is the most honest single-point summary
 * of "somewhere in this room".
 *
 * Falls back to the node's own coordinates when:
 *   - no rooms are configured
 *   - the node has no `room:` field and isn't inside any room polygon
 *   - the matched room has no points to compute a centroid from
 *
 * Confidence shrinks linearly with the smallest measured distance —
 * a nearest node that's still 6 m away is much weaker evidence than
 * one that's 0.5 m away.
 */
export class NearestNodeLocator implements Locator {
  readonly name = "nearest_node";

  /** nodeId → (x, y, z) of its room's centroid (z lifted from the node). */
  private readonly nodeRoomCentroid: Map<string, [number, number, number]>;

  constructor(rooms: readonly Room[], nodes: readonly Node[]) {
    this.nodeRoomCentroid = new Map();

    // Index rooms by id and by name so we can resolve `node.room`
    // declarations that use either form.
    const roomById = new Map<string, Room>();
    for (const r of rooms) {
      if (r.id) roomById.set(r.id, r);
      if (r.name) roomById.set(r.name, r);
    }

    for (const n of nodes) {
      if (!n.id || !n.point) continue;

      // Prefer explicit `room:` from config; fall back to point-in-polygon.
      let room: Room | undefined = n.room ? roomById.get(n.room) : undefined;
      if (!room) {
        const matchedId = findRoom(rooms, [n.point[0], n.point[1]]);
        if (matchedId) {
          room = roomById.get(matchedId);
        }
      }

      if (!room || !room.points || room.points.length < 3) continue;

      // Use the polygon's true area centroid (shoelace formula). Each
      // edge contributes weighted by the signed area it sweeps out, so
      // a long flat wall doesn't get out-voted by a short bumpy one
      // densely vertexed in the corner. This is the right "center of
      // the blob" rather than "average of the corners".
      const [cx, cy] = polygonCentroid(room.points);

      // For non-convex polygons (U- or L-shapes) the area centroid can
      // land outside the polygon. If that happens, fall back to the
      // simple vertex mean — not perfect, but always inside the convex
      // hull and well-defined.
      let centerX = cx;
      let centerY = cy;
      if (!pointInPolygon([cx, cy], room.points)) {
        let sx = 0;
        let sy = 0;
        for (const [x, y] of room.points) {
          sx += x;
          sy += y;
        }
        centerX = sx / room.points.length;
        centerY = sy / room.points.length;
      }

      // Z: keep the node's own height — we have no per-room ceiling info
      // here and the node's mounting height is the best available proxy
      // for "where in this room is RF activity happening".
      this.nodeRoomCentroid.set(n.id, [centerX, centerY, n.point[2]]);
    }
  }

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length === 0) return null;

    let best = fixes[0];
    for (let i = 1; i < fixes.length; i++) {
      if (fixes[i].distance < best.distance) best = fixes[i];
    }

    const centroid = this.nodeRoomCentroid.get(best.nodeId);
    const [x, y, z] = centroid ?? best.point;

    // Confidence: 1.0 when the device is "at" the node (distance ≈ 0),
    // decaying to 0 as the smallest distance approaches 10 m. Mirrors
    // the geometric fact that nearest-node is a great room-vote when
    // the device really is on top of a node, and a poor one as the
    // device gets further away.
    const confidence = Math.max(0, 1 - best.distance / 10);

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
 * Polygon centroid via the shoelace formula. Works for any simple
 * (non-self-intersecting) polygon — vertex order can be CW or CCW;
 * we divide by signed area so the sign cancels.
 *
 * For a polygon (x_0, y_0)..(x_{n-1}, y_{n-1}) closing back to (x_0, y_0):
 *   A = ½ Σ (x_i · y_{i+1} − x_{i+1} · y_i)
 *   Cx = (1 / 6A) Σ (x_i + x_{i+1}) · (x_i · y_{i+1} − x_{i+1} · y_i)
 *   Cy = (1 / 6A) Σ (y_i + y_{i+1}) · (x_i · y_{i+1} − x_{i+1} · y_i)
 *
 * Degenerate (zero-area) input falls through to the vertex mean to
 * avoid a divide-by-zero — caller should guard with a points.length
 * check anyway.
 */
function polygonCentroid(
  points: readonly (readonly [number, number])[],
): [number, number] {
  const n = points.length;
  let twiceA = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < n; i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[(i + 1) % n];
    const cross = xi * yj - xj * yi;
    twiceA += cross;
    cx += (xi + xj) * cross;
    cy += (yi + yj) * cross;
  }

  if (Math.abs(twiceA) < 1e-9) {
    // Degenerate polygon — fall back to vertex mean.
    let sx = 0;
    let sy = 0;
    for (const [x, y] of points) {
      sx += x;
      sy += y;
    }
    return [sx / n, sy / n];
  }

  const sixA = 3 * twiceA;
  return [cx / sixA, cy / sixA];
}
