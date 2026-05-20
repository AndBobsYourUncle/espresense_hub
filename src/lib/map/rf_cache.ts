import type { Config, Floor, Node, Room } from "@/lib/config";
import { polygonCentroid } from "@/lib/map/geometry";
import {
  buildWallSegments,
  countCrossings,
  type WallSegment,
} from "@/lib/map/rf_geometry";
import { obstructionLossDb, rfParamsFromConfig, type RfParams } from "@/lib/map/rf_propagation";
import { findRoom } from "@/lib/locators/room_aware";

/**
 * Server-side cache of walls + node-room geometry, rebuilt whenever the
 * live config reloads. Used by the calibration pipeline to compute the
 * structural-attenuation term (W) for each node-to-node ground-truth
 * sample — that dB loss is subtracted from the observed RSSI before
 * fitting path-loss, so the fitted exponent reflects *true* propagation
 * rather than an architecture-dependent mishmash.
 *
 * Shape:
 *   - wallsByFloor: floor.id → pre-classified WallSegment[]
 *   - nodeRoomCentroid: nodeId → room centroid in floor coords (for the
 *     wall-at-source side test in countCrossings)
 *   - nodeFloor: nodeId → floor id (first floor the node belongs to)
 */
interface RfCache {
  wallsByFloor: Map<string, WallSegment[]>;
  nodeRoomCentroid: Map<string, readonly [number, number]>;
  nodeFloor: Map<string, string>;
  params: RfParams;
}

let cache: RfCache | null = null;

/** Clear the cache on config reload before building the new one. */
export function rebuildRfCache(config: Config): void {
  const wallsByFloor = new Map<string, WallSegment[]>();
  for (const floor of config.floors) {
    if (!floor.id) continue;
    wallsByFloor.set(floor.id, buildWallSegments([floor]));
  }

  const nodeRoomCentroid = new Map<string, readonly [number, number]>();
  const nodeFloor = new Map<string, string>();
  for (const node of config.nodes) {
    if (!node.id || !node.point) continue;
    const floor = pickFloorForNode(node, config.floors);
    if (!floor?.id) continue;
    nodeFloor.set(node.id, floor.id);

    const room = resolveNodeRoom(node, floor);
    if (room?.points && room.points.length >= 3) {
      nodeRoomCentroid.set(node.id, polygonCentroid(room.points));
    }
  }

  cache = {
    wallsByFloor,
    nodeRoomCentroid,
    nodeFloor,
    params: rfParamsFromConfig(config),
  };
}

/**
 * Read the current RF model parameters (or null when the cache isn't
 * built yet). Locators that minimize an RF-physics objective need
 * direct access to the path-loss exponent and reference RSSI to
 * predict expected measurements at a candidate position.
 */
export function getRfParams(): RfParams | null {
  return cache?.params ?? null;
}

/**
 * Build a closure that returns dB obstruction loss from `node` (acting
 * as the source for the wall-at-source side test) to an arbitrary
 * (px, py) target. Use this when scoring many candidate positions
 * against the same node — locators iterate hundreds of candidates per
 * fix, and threading the per-node walls/centroid lookups outside the
 * inner loop saves real work.
 *
 * Returns `null` when the cache isn't built or the node isn't in the
 * cache; callers should treat that as "no obstruction info available"
 * (typically: weight uniformly).
 */
export function buildObstructionFn(
  nodeId: string,
  nodePoint: readonly [number, number],
): ((px: number, py: number) => number) | null {
  if (!cache) return null;
  const floorId = cache.nodeFloor.get(nodeId);
  if (!floorId) return null;
  const walls = cache.wallsByFloor.get(floorId);
  if (!walls) return null;
  const centroid = cache.nodeRoomCentroid.get(nodeId);
  const params = cache.params;
  return (px, py) =>
    obstructionLossDb(
      nodePoint[0],
      nodePoint[1],
      px,
      py,
      walls,
      params,
      centroid,
    );
}

/**
 * Compute obstruction loss (dB) along the line between two configured
 * nodes. Returns 0 when:
 *   - cache isn't built yet (pre-bootstrap)
 *   - either node isn't in the cache (not configured, or missing point)
 *   - the two nodes belong to different floors (out-of-scope for the
 *     2D RF model — floor-to-floor attenuation is a separate problem)
 *
 * `transmitterId` is the signal source: its room centroid drives the
 * wall-at-source side test so a wall-mounted TX doesn't self-attenuate
 * into its own room, but still attenuates emissions crossing the mount
 * wall into a neighboring room.
 */
export function obstructionLossForPair(
  listenerId: string,
  transmitterId: string,
  listenerPoint: readonly [number, number, number],
  transmitterPoint: readonly [number, number, number],
): number {
  if (!cache) return 0;
  const lFloor = cache.nodeFloor.get(listenerId);
  const tFloor = cache.nodeFloor.get(transmitterId);
  if (!lFloor || !tFloor || lFloor !== tFloor) return 0;
  const walls = cache.wallsByFloor.get(lFloor);
  if (!walls) return 0;
  const txCentroid = cache.nodeRoomCentroid.get(transmitterId);
  // Note: obstructionLossDb goes through a direct-to-endpoint path
  // and uses only the TX centroid — same signature as before. Direct
  // count symmetry (both endpoints' mount walls side-tested) is
  // handled by obstructionCountsForPair below, which is what the
  // cascade pipeline actually uses. Leaving this path as-is because
  // its callers (older locators) don't depend on direction-
  // independent counts.
  return obstructionLossDb(
    transmitterPoint[0],
    transmitterPoint[1],
    listenerPoint[0],
    listenerPoint[1],
    walls,
    cache.params,
    txCentroid,
  );
}

/**
 * Room centroid for the given configured node, used by the routing
 * graph's edge-wall-count step so walls that touch a node's mount
 * point get properly side-tested (otherwise `countCrossings` silently
 * skips them when no centroid is passed — bug that under-counts
 * crossings for any node mounted on/near a wall).
 *
 * Returns null when the cache isn't built, the node isn't known, or
 * the node's room has no polygon.
 */
export function getNodeRoomCentroid(
  nodeId: string,
): readonly [number, number] | null {
  if (!cache) return null;
  return cache.nodeRoomCentroid.get(nodeId) ?? null;
}

/**
 * Same path-segment lookup as `obstructionLossForPair` but returns
 * the raw counts (interior, exterior, doors) instead of the dB sum.
 *
 * Needed by the cascade calibration system, which fits per-wall-type
 * attenuation as separate parameters and therefore needs the
 * counts, not the sum. Returns null when geometry isn't available
 * (cache not built, nodes on different floors, etc.); callers can
 * treat that as "skip this observation."
 */
export function obstructionCountsForPair(
  listenerId: string,
  transmitterId: string,
  listenerPoint: readonly [number, number, number],
  transmitterPoint: readonly [number, number, number],
): { interior: number; exterior: number; doors: number } | null {
  if (!cache) return null;
  const lFloor = cache.nodeFloor.get(listenerId);
  const tFloor = cache.nodeFloor.get(transmitterId);
  if (!lFloor || !tFloor || lFloor !== tFloor) return null;
  const walls = cache.wallsByFloor.get(lFloor);
  if (!walls) return null;
  const txCentroid = cache.nodeRoomCentroid.get(transmitterId);
  const rxCentroid = cache.nodeRoomCentroid.get(listenerId);
  // Pass BOTH endpoint centroids so walls touching either endpoint
  // get properly side-tested against that endpoint's room interior.
  // This makes the count truly direction-independent: tx→rx and
  // rx→tx produce identical `{interior, exterior, doors}` for the
  // same physical line. Before the fix, only the TX centroid was
  // consulted, so swapping endpoints gave different counts due to
  // asymmetric at-source treatment of mount walls — surfaced
  // visibly as `office→kitchen: 1i/2e` vs `kitchen→office: 2i/2e`.
  return countCrossings(
    transmitterPoint[0],
    transmitterPoint[1],
    listenerPoint[0],
    listenerPoint[1],
    walls,
    txCentroid,
    rxCentroid,
  );
}

// ─── Internals ───────────────────────────────────────────────────────────

function pickFloorForNode(
  node: Node,
  floors: readonly Floor[],
): Floor | null {
  // Nodes with an explicit `floors` array belong to that set. Without
  // one, a node belongs to the first floor that contains its point —
  // matching the upstream "no floors = all floors" convention.
  if (node.floors && node.floors.length > 0) {
    for (const f of floors) {
      if (f.id && node.floors.includes(f.id)) return f;
    }
  }
  return floors[0] ?? null;
}

function resolveNodeRoom(
  node: Node,
  floor: Floor,
): Room | null {
  if (!node.point) return null;
  const label = node.room;
  if (label) {
    const match = floor.rooms.find((r) => r.id === label || r.name === label);
    if (match) return match;
  }
  // Fall back to point-in-polygon lookup.
  const roomId = findRoom(floor.rooms, [node.point[0], node.point[1]]);
  if (!roomId) return null;
  return (
    floor.rooms.find((r) => r.id === roomId || r.name === roomId) ?? null
  );
}
