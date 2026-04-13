import type { Node, Room } from "@/lib/config";
import { openToId } from "@/lib/config/schema";
import { getStore } from "@/lib/state/store";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Room-aware circle-overlap locator.
 *
 * Uses the room topology (where the walls are) to decide which
 * measurements to trust. The key physical insight:
 *
 *   - Same-room paths (no walls between device and node) follow the
 *     log-distance model accurately — the circles are correct.
 *   - Cross-wall paths suffer unpredictable attenuation — the circles
 *     are systematically distorted.
 *
 * For each pair of nodes, if both are in the same room as the
 * candidate position, their pairwise overlap center (midpoint of
 * their circle intersections) gets full weight. Cross-room pairs get
 * heavily down-weighted. The weighted centroid of the overlap centers
 * IS the position estimate.
 *
 * This avoids the centroid bias of IDW (which averages node positions)
 * and the bootstrap problem of residual-based rejection (which can't
 * see outliers from the position they created). The room topology is
 * ground truth from the config — it doesn't depend on the solver's
 * output.
 */

/** Weight multiplier for same-room / adjacent-room / cross-room. */
const SAME_ROOM_WEIGHT = 1.0;
const ADJACENT_ROOM_WEIGHT = 0.8;
/** Cross-room pairs are nearly ignored — the same-room consensus
 *  should dominate once we've identified the device's room from the
 *  closest-node vote. */
const CROSS_ROOM_WEIGHT = 0.005;

/** Vertex distance threshold for detecting shared room edges. */
const ADJACENCY_EPSILON = 0.1;

/**
 * How many refinement iterations: solve → determine which room the
 * device is in → re-weight pairs → re-solve.
 */
const MAX_ITERS = 3;

export class RoomAwareLocator implements Locator {
  readonly name = "room_aware";
  private readonly rooms: Room[];
  private readonly nodeRooms: Map<string, string | null>;
  /** Set of "roomA|roomB" strings for rooms that share a boundary edge. */
  private readonly adjacentPairs: Set<string>;

  constructor(rooms: Room[], nodes: readonly Node[]) {
    this.rooms = rooms;
    // Build a name → id map so `open_to` can reference rooms by either.
    const idByLabel = new Map<string, string>();
    for (const r of rooms) {
      const id = r.id;
      if (!id) continue;
      idByLabel.set(id, id);
      if (r.name) idByLabel.set(r.name, id);
    }
    const resolveRoom = (label: string | undefined): string | null => {
      if (!label) return null;
      return idByLabel.get(label) ?? null;
    };

    // Adjacency: shared edges (auto-detected) PLUS explicit `open_to`
    // declarations from the config (user-marked open passages) PLUS
    // `floor_area` group membership (open-floor-plan zones — every
    // room sharing a tag is mutually adjacent, no need to enumerate).
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

    // floor_area: rooms tagged with the same value form an all-to-all
    // adjacency clique. Models open layouts where there is no wall or
    // even a notional doorway between the rooms.
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

    // Per-node room: explicit `room:` from config wins, else
    // point-in-polygon. Falling back to geometry handles legacy
    // configs without the new field.
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

  /** Check if two rooms are the same or share a boundary. */
  private roomsConnected(roomA: string | null | undefined, roomB: string | null | undefined): boolean {
    if (!roomA || !roomB) return false;
    if (roomA === roomB) return true;
    const key1 = roomA < roomB ? `${roomA}|${roomB}` : `${roomB}|${roomA}`;
    return this.adjacentPairs.has(key1);
  }

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length < 2) return null;

    // Compute ALL pairwise overlap centers.
    const overlaps = computeAllOverlaps(fixes);
    if (overlaps.length === 0) {
      // Fallback: simple IDW if no circles intersect.
      return this.fallbackIDW(fixes);
    }

    // Determine the device's room from the closest-reporting nodes,
    // NOT from a position estimate. The node with the smallest
    // measured distance is almost certainly in the same room (or
    // adjacent) as the device. This avoids the bootstrap problem
    // where a wrong initial position picks the wrong room and then
    // confirms itself via weighting.
    //
    // Voting scheme: take the top 3 closest-measuring nodes and
    // count their rooms. The most-voted room (with weight by
    // 1/distance²) is the device's room.
    const sortedFixes = [...fixes].sort((a, b) => a.distance - b.distance);
    const roomVotes = new Map<string, number>();
    for (const f of sortedFixes.slice(0, Math.min(3, fixes.length))) {
      const r = this.nodeRooms.get(f.nodeId);
      if (!r) continue;
      const w = 1 / (f.distance * f.distance + 1e-6);
      roomVotes.set(r, (roomVotes.get(r) ?? 0) + w);
    }
    let deviceRoom: string | null = null;
    {
      let bestVote = 0;
      for (const [r, v] of roomVotes) {
        if (v > bestVote) {
          bestVote = v;
          deviceRoom = r;
        }
      }
    }

    // Initial position from unweighted centroid (used only as a
    // starting point for the iterative refinement).
    let posX = 0;
    let posY = 0;
    for (const o of overlaps) {
      posX += o.cx;
      posY += o.cy;
    }
    posX /= overlaps.length;
    posY /= overlaps.length;

    // Look up per-pair calibration R² from the store. This is a trust
    // signal for each path — well-calibrated paths agree with their
    // historical average.
    const store = getStore();
    const lookupR2 = (a: string, b: string): number => {
      const aFits = store.nodePairFits.get(a);
      const bFits = store.nodePairFits.get(b);
      const r1 = aFits?.get(b)?.rSquared ?? 0;
      const r2 = bFits?.get(a)?.rSquared ?? 0;
      return Math.max(r1, r2);
    };

    // Score each candidate intersection point by:
    //  - How many OTHER circles pass through it (consensus signal —
    //    this is the user's visual "the circles cross right HERE")
    //  - Each agreeing circle weighted by its room connectivity to
    //    the device's room (same-room agreement counts most)
    //  - R² of the pair that produced this candidate
    //  - GDOP and size (geometric quality of the crossing)
    interface ScoredCandidate {
      cx: number;
      cy: number;
      score: number;
    }
    const scored: ScoredCandidate[] = [];
    /** Relative tolerance — circle agrees if residual < REL_TOL × r. */
    const REL_TOL = 0.15;

    for (const o of overlaps) {
      // Pair-intrinsic weight (the pair's own quality).
      const room1 = this.nodeRooms.get(o.nodeId1);
      const room2 = this.nodeRooms.get(o.nodeId2);
      const r2 = lookupR2(o.nodeId1, o.nodeId2);
      let pairRoomW = CROSS_ROOM_WEIGHT;
      if (deviceRoom != null) {
        const c1 = this.roomsConnected(room1, deviceRoom);
        const c2 = this.roomsConnected(room2, deviceRoom);
        if (c1 && c2) {
          const both = room1 === deviceRoom && room2 === deviceRoom;
          pairRoomW = both ? SAME_ROOM_WEIGHT : ADJACENT_ROOM_WEIGHT;
        } else if (c1 || c2) pairRoomW = 0.3;
      } else pairRoomW = 0.3;

      const pairWeight = o.gdop * pairRoomW * (0.5 + 0.5 * r2) * o.sizeWeight;

      // Consensus: how many OTHER circles pass through this candidate?
      let consensus = 0;
      for (const f of fixes) {
        if (f.nodeId === o.nodeId1 || f.nodeId === o.nodeId2) continue;
        const dx = o.cx - f.point[0];
        const dy = o.cy - f.point[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const residual = Math.abs(dist - f.distance);
        const tol = REL_TOL * f.distance;
        if (residual <= tol) {
          // Same-room agreement counts more.
          const otherRoom = this.nodeRooms.get(f.nodeId);
          const sameRoomBonus = this.roomsConnected(otherRoom, deviceRoom)
            ? 1.0
            : 0.3;
          // Tighter agreement counts more.
          consensus += sameRoomBonus * (1 - residual / tol);
        }
      }

      // Final score: pair quality × (1 + consensus). The +1 ensures
      // pairs with no other agreement still contribute their pair
      // weight; multiplier rewards pairs whose intersection is also
      // an intersection of OTHER circles.
      const score = pairWeight * (1 + consensus);
      scored.push({ cx: o.cx, cy: o.cy, score });
    }

    // Position = score-weighted centroid of all candidates.
    let wx = 0;
    let wy = 0;
    let wTotal = 0;
    for (const s of scored) {
      wx += s.score * s.cx;
      wy += s.score * s.cy;
      wTotal += s.score;
    }
    if (wTotal > 0) {
      posX = wx / wTotal;
      posY = wy / wTotal;
    }

    // Z from distance-weighted average.
    let zw = 0;
    let zt = 0;
    for (const f of fixes) {
      const w = 1 / (f.distance * f.distance + 1e-6);
      zw += w * f.point[2];
      zt += w;
    }

    // Confidence: how many same-room circles agree at the final position?
    // Use the room we identified earlier from the closest-node vote.
    let agreeing = 0;
    let total = 0;
    for (const f of fixes) {
      const nodeRoom = this.nodeRooms.get(f.nodeId);
      if (!this.roomsConnected(nodeRoom, deviceRoom)) continue;
      total++;
      const dx = posX - f.point[0];
      const dy = posY - f.point[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(dist - f.distance) < 1.5) agreeing++;
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

  private fallbackIDW(fixes: readonly NodeFix[]): LocatorResult {
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
      algorithm: this.name,
    };
  }
}

// ─── Circle overlap computation ─────────────────────────────────────────

interface OverlapCenter {
  /** Candidate position — one of the two ACTUAL intersection points
   *  of the two circles (not the lens midpoint). Each pair produces
   *  TWO candidates; we add both and let scoring pick the winner. */
  cx: number;
  cy: number;
  nodeId1: string;
  nodeId2: string;
  sizeWeight: number;
  gdop: number;
}

function computeAllOverlaps(fixes: readonly NodeFix[]): OverlapCenter[] {
  const overlaps: OverlapCenter[] = [];
  for (let i = 0; i < fixes.length; i++) {
    for (let j = i + 1; j < fixes.length; j++) {
      const a = fixes[i];
      const b = fixes[j];
      const dx = b.point[0] - a.point[0];
      const dy = b.point[1] - a.point[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > a.distance + b.distance) continue;
      if (dist < Math.abs(a.distance - b.distance)) continue;
      if (dist < 1e-6) continue;

      const aLen =
        (a.distance * a.distance - b.distance * b.distance + dist * dist) /
        (2 * dist);
      const hSq = a.distance * a.distance - aLen * aLen;
      if (hSq < 0) continue;
      const h = Math.sqrt(hSq);

      const ux = dx / dist;
      const uy = dy / dist;

      // Point on the center line, between the two intersection points.
      const px = a.point[0] + aLen * ux;
      const py = a.point[1] + aLen * uy;

      // The two ACTUAL intersection points (perpendicular offset by ±h).
      const i1x = px + h * -uy;
      const i1y = py + h * ux;
      const i2x = px - h * -uy;
      const i2y = py - h * ux;

      const cosAngle =
        (a.distance * a.distance + b.distance * b.distance - dist * dist) /
        (2 * a.distance * b.distance);
      const cosClamped = Math.max(-1, Math.min(1, cosAngle));
      const gdop = Math.max(0.01, 1 - cosClamped * cosClamped);
      const sizeWeight = 1 / (a.distance * b.distance);

      // Add BOTH intersection points as candidates. The scoring step
      // will weight them by how many other circles pass through them.
      overlaps.push({
        cx: i1x,
        cy: i1y,
        nodeId1: a.nodeId,
        nodeId2: b.nodeId,
        sizeWeight,
        gdop,
      });
      overlaps.push({
        cx: i2x,
        cy: i2y,
        nodeId1: a.nodeId,
        nodeId2: b.nodeId,
        sizeWeight,
        gdop,
      });
    }
  }
  return overlaps;
}

// ─── Point-in-polygon ───────────────────────────────────────────────────

/**
 * Find which room a 2D point is inside. Returns the room's id/name,
 * or null if the point isn't in any defined room. Uses ray-casting.
 */
export function findRoom(
  rooms: readonly Room[],
  point: readonly [number, number],
): string | null {
  for (const room of rooms) {
    if (!room.points || room.points.length < 3) continue;
    if (pointInPolygon(point, room.points)) {
      return room.id ?? room.name ?? null;
    }
  }
  return null;
}

/**
 * Ray-casting point-in-polygon test. Standard algorithm: cast a ray
 * from the point along +x, count edge crossings. Odd = inside.
 */
export function pointInPolygon(
  point: readonly [number, number],
  polygon: readonly (readonly [number, number])[],
): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Compute which rooms share a boundary edge. Two rooms are adjacent if
 * any of their polygon edges are coincident (share two vertices within
 * epsilon). Returns a Set of "roomA|roomB" strings (alphabetically
 * ordered) for quick lookup.
 */
function computeRoomAdjacency(rooms: readonly Room[]): Set<string> {
  const pairs = new Set<string>();
  const eps = ADJACENCY_EPSILON;

  // For each room, collect its edges as (vertex, vertex) pairs.
  const roomEdges: Array<{
    roomId: string;
    edges: Array<readonly [readonly [number, number], readonly [number, number]]>;
  }> = [];

  for (const room of rooms) {
    const id = room.id ?? room.name ?? "";
    if (!id || !room.points || room.points.length < 3) continue;
    const edges: Array<readonly [readonly [number, number], readonly [number, number]]> = [];
    for (let i = 0; i < room.points.length; i++) {
      const j = (i + 1) % room.points.length;
      edges.push([room.points[i], room.points[j]]);
    }
    roomEdges.push({ roomId: id, edges });
  }

  // For each pair of rooms, check if any edges are shared (same two
  // vertices, possibly reversed).
  for (let a = 0; a < roomEdges.length; a++) {
    for (let b = a + 1; b < roomEdges.length; b++) {
      let shared = false;
      outer: for (const [a1, a2] of roomEdges[a].edges) {
        for (const [b1, b2] of roomEdges[b].edges) {
          // Check both orientations: (a1≈b1 && a2≈b2) || (a1≈b2 && a2≈b1)
          const match1 =
            Math.abs(a1[0] - b1[0]) < eps &&
            Math.abs(a1[1] - b1[1]) < eps &&
            Math.abs(a2[0] - b2[0]) < eps &&
            Math.abs(a2[1] - b2[1]) < eps;
          const match2 =
            Math.abs(a1[0] - b2[0]) < eps &&
            Math.abs(a1[1] - b2[1]) < eps &&
            Math.abs(a2[0] - b1[0]) < eps &&
            Math.abs(a2[1] - b1[1]) < eps;
          if (match1 || match2) {
            shared = true;
            break outer;
          }
        }
      }
      if (shared) {
        const idA = roomEdges[a].roomId;
        const idB = roomEdges[b].roomId;
        const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
        pairs.add(key);
      }
    }
  }

  return pairs;
}
