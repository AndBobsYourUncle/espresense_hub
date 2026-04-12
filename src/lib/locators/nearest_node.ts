import type { Node, Room } from "@/lib/config";
import { findRoom } from "./room_aware";
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

      if (!room || !room.points || room.points.length === 0) continue;

      // Polygon centroid: simple arithmetic mean of vertices. Good enough
      // for the convex-ish room shapes this system targets, and stays
      // well inside U-shapes where a true centroid-of-area might escape
      // the polygon.
      let sx = 0;
      let sy = 0;
      for (const [x, y] of room.points) {
        sx += x;
        sy += y;
      }
      const cx = sx / room.points.length;
      const cy = sy / room.points.length;

      // Z: keep the node's own height — we have no per-room ceiling info
      // here and the node's mounting height is the best available proxy
      // for "where in this room is RF activity happening".
      this.nodeRoomCentroid.set(n.id, [cx, cy, n.point[2]]);
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
