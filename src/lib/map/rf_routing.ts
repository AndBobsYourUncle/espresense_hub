import type { Config } from "@/lib/config";
import { polygonCentroid } from "@/lib/map/geometry";
import { buildWallSegments, countCrossings, type WallSegment } from "@/lib/map/rf_geometry";
import { getNodeRoomCentroid } from "@/lib/map/rf_cache";
import type { RfParams } from "@/lib/map/rf_propagation";

/**
 * Routing graph for RF propagation modeling.
 *
 * Replaces the assumption that signal travels in a straight line
 * between TX and RX nodes. Real RF takes the easiest path — which
 * for indoor environments is often a longer geometric route through
 * doorways and open areas instead of a shorter route through many
 * walls.
 *
 * The graph:
 *   - Vertices: actual RF nodes + door centers + room centroids
 *   - Edges: straight-line segments between vertices, weighted by
 *     `(free-space loss + wall loss)` along the segment
 *
 * Shortest-weighted-path between two RF nodes (Dijkstra) gives the
 * "lowest-loss route" the signal would plausibly take. The cascade
 * uses the accumulated `(length, interior_walls, exterior_walls,
 * doors)` along that route — instead of the direct-line counts —
 * when fitting RF parameters.
 *
 * **Edge cost approximation:** free-space loss is `10n·log10(d)`
 * which is non-additive across hops (`log(a+b) ≠ log(a) + log(b)`).
 * For Dijkstra we approximate by summing per-hop log losses; this
 * slightly favors multi-hop routes (their summed log-loss is less
 * than the equivalent single-hop). After Dijkstra picks a path, the
 * cascade computes the *correct* total loss using `10n·log10(total_length)`,
 * so the fit isn't affected by the routing approximation.
 *
 * **Convergence:** the routing depends on the RF parameters (which
 * walls hurt how much). Initial routing uses configured params;
 * subsequent cascade fits provide updated params, so a fixed-point
 * iteration of (params, paths) converges naturally over 2–3 refits.
 */

/** Vertex in the routing graph. */
export interface GraphNode {
  /** Stable id for debugging and visualization. */
  id: string;
  /** 2D position in floor coordinates (meters). */
  point: readonly [number, number];
  type: "rf-node" | "door" | "centroid";
}

/** A directed edge with pre-computed geometric properties. */
interface GraphEdge {
  /** Index into `nodes`. */
  to: number;
  /** Length of the segment (m). */
  length: number;
  /** Interior wall crossings along the segment. */
  interior: number;
  /** Exterior wall crossings. */
  exterior: number;
  /** Door crossings. */
  doors: number;
}

export interface RoutingGraph {
  nodes: GraphNode[];
  /** Adjacency list: nodeIdx → neighboring edges. */
  adj: GraphEdge[][];
  /** Lookup: RF node id → graph node index. */
  rfNodeIndex: Map<string, number>;
  /**
   * Walls used by this graph — exposed so per-pair specular
   * reflection computation can run mirror-image geometry + LOS
   * checks against the same geometry the graph was built on.
   */
  walls: readonly WallSegment[];
}

/**
 * Lowest-loss path from one point to another, with accumulated
 * properties suitable for the cascade fit.
 */
export interface RoutedPath {
  /** Total geometric length along the path (m). */
  totalLength: number;
  /** Interior wall crossings accumulated along the path. */
  interior: number;
  exterior: number;
  doors: number;
  /**
   * Number of specular reflections in the path (Phase 1.7+). 0 for
   * direct paths and door-routed paths. Each transit through a
   * reflection vertex (intermediate, not endpoint) increments by 1.
   * The cascade applies `reflectionLossDb` per reflection when
   * computing predicted RSSI.
   */
  reflections: number;
  /** Sequence of (x, y) waypoints — for visualization. */
  pathPoints: Array<readonly [number, number]>;
}

/** Maximum edge length to consider (m). Long edges dominated by free-space loss anyway. */
const MAX_EDGE_LENGTH_M = 30;

/**
 * Build the routing graph from the current config + RF model. One-
 * time computation per config change — cheap (~few hundred edges,
 * each requires one wall-crossing check).
 */
export function buildRoutingGraph(config: Config): RoutingGraph {
  const nodes: GraphNode[] = [];
  const rfNodeIndex = new Map<string, number>();
  const seenPoint = new Set<string>(); // dedup near-coincident points

  const addNode = (n: GraphNode): number => {
    // Dedup by rounded position — door centers and rf-nodes can
    // coincide, no point in two graph vertices at the same place.
    const key = `${n.point[0].toFixed(2)},${n.point[1].toFixed(2)}`;
    if (seenPoint.has(key)) {
      // Find existing node at this position
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].point;
        if (
          Math.abs(p[0] - n.point[0]) < 0.05 &&
          Math.abs(p[1] - n.point[1]) < 0.05
        ) {
          return i;
        }
      }
    }
    seenPoint.add(key);
    nodes.push(n);
    return nodes.length - 1;
  };

  // 1. Actual RF nodes
  for (const node of config.nodes) {
    if (!node.id || !node.point) continue;
    const idx = addNode({
      id: node.id,
      point: [node.point[0], node.point[1]],
      type: "rf-node",
    });
    rfNodeIndex.set(node.id, idx);
  }

  // 2. Door centers (across all rooms in all floors)
  for (const floor of config.floors) {
    for (const room of floor.rooms) {
      for (const ot of room.open_to) {
        const door = typeof ot === "object" ? ot.door : null;
        if (!door) continue;
        const otherId = typeof ot === "object" ? ot.id : ot;
        addNode({
          id: `door:${room.id ?? "?"}|${otherId}`,
          point: [door[0], door[1]],
          type: "door",
        });
      }
    }
  }

  // 3. Room centroids — give the graph "transit hubs" inside each
  // room so multi-room paths can route through room interiors
  // instead of jumping wall-to-wall.
  for (const floor of config.floors) {
    for (const room of floor.rooms) {
      if (!room.id || !room.points || room.points.length < 3) continue;
      const c = polygonCentroid(room.points);
      addNode({
        id: `centroid:${room.id}`,
        point: c,
        type: "centroid",
      });
    }
  }

  // Build walls per floor (used for edge-cost computation + reflection
  // vertex placement).
  // Note: we use a single combined wall set since paths may cross
  // multiple floors' geometry. For single-floor configs this is fine.
  const walls: WallSegment[] = [];
  for (const floor of config.floors) {
    for (const w of buildWallSegments([floor])) walls.push(w);
  }

  // (Phase 1.8: reflection-vertex-based routing is gone.) Reflections
  // are now computed per-pair via the mirror-image method in
  // `findSpecularReflections`, which enforces specular geometry
  // (angle-in = angle-out), same-side-of-wall, and LOS on both
  // legs. Generic refl vertices in a static graph couldn't satisfy
  // those constraints — Dijkstra happily routed through them as if
  // they were regular waypoints, producing physically nonsense
  // paths (e.g., "bounce off the far side of a wall two walls
  // away"). Physical reflections are now a check on candidate wall
  // surfaces, not graph vertices.

  // Build adjacency. For each pair of nodes, add an edge with its
  // direct-line wall counts. Skip very long edges as a sanity prune.
  //
  // Direction matters for the wall-at-source side test in
  // `countCrossings`: a wall that touches the source endpoint is
  // kept only when the target lies on the opposite side from the
  // source room's interior. So we compute counts per direction —
  // using the source-endpoint's room centroid when the source is an
  // RF node. Without this, any wall touching a node's mount point
  // is silently dropped from the crossing tally (Phase 1.8 fix).
  //
  // Non-rf-node vertices (door, centroid, reflection) stay on
  // `undefined` centroid: reflection vertices intentionally benefit
  // from the drop (the wall they reflect off shouldn't count as a
  // crossing), and door/centroid vertices aren't on walls.
  const centroidFor = (n: GraphNode): readonly [number, number] | undefined =>
    n.type === "rf-node" ? getNodeRoomCentroid(n.id) ?? undefined : undefined;
  const adj: GraphEdge[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.point[0] - a.point[0];
      const dy = b.point[1] - a.point[1];
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length > MAX_EDGE_LENGTH_M) continue;
      // Pass both endpoints' centroids so walls touching either end
      // get side-tested against that end's room interior. The count
      // is then direction-independent — a→b and b→a share one edge
      // record with identical wall counts.
      const counts = countCrossings(
        a.point[0], a.point[1], b.point[0], b.point[1], walls,
        centroidFor(a), centroidFor(b),
      );
      const edge = {
        length,
        interior: counts.interior,
        exterior: counts.exterior,
        doors: counts.doors,
      };
      adj[i].push({ ...edge, to: j });
      adj[j].push({ ...edge, to: i });
    }
  }

  return { nodes, adj, rfNodeIndex, walls };
}

/**
 * Compute the lowest-loss path between two RF nodes via Dijkstra.
 *
 * Edge cost: `10·n·log10(length+1) + interior·wall_att + exterior·ext_att + doors·door_att`
 *
 * The `+1` in `log10(length+1)` keeps short edges (close-together
 * vertices) from contributing wildly negative costs. The summed
 * log-loss across hops slightly under-counts the "true" total
 * `10n·log10(total_length)`; that's an acceptable approximation
 * because callers compute the true total separately for the cascade
 * fit.
 *
 * Returns null when source/destination IDs aren't in the graph or
 * no path exists (shouldn't happen with a connected graph).
 */
export function findRoutedPath(
  graph: RoutingGraph,
  srcRfNodeId: string,
  dstRfNodeId: string,
  params: RfParams,
): RoutedPath | null {
  const src = graph.rfNodeIndex.get(srcRfNodeId);
  const dst = graph.rfNodeIndex.get(dstRfNodeId);
  if (src === undefined || dst === undefined) return null;
  if (src === dst) {
    return {
      totalLength: 0,
      interior: 0,
      exterior: 0,
      doors: 0,
      reflections: 0,
      pathPoints: [graph.nodes[src].point],
    };
  }

  const N = graph.nodes.length;
  const dist = new Array<number>(N).fill(Infinity);
  const interior = new Array<number>(N).fill(0);
  const exterior = new Array<number>(N).fill(0);
  const doors = new Array<number>(N).fill(0);
  const length = new Array<number>(N).fill(0);
  const prev = new Array<number>(N).fill(-1);
  dist[src] = 0;

  // Set-based priority queue. N is small (~40), so linear scan is fine.
  // For larger graphs we'd want a binary heap.
  const visited = new Set<number>();
  const queue = new Set<number>([src]);

  while (queue.size > 0) {
    let u = -1;
    let minDist = Infinity;
    for (const i of queue) {
      if (dist[i] < minDist) {
        minDist = dist[i];
        u = i;
      }
    }
    if (u === -1) break;
    queue.delete(u);
    visited.add(u);
    if (u === dst) break;

    for (const edge of graph.adj[u]) {
      if (visited.has(edge.to)) continue;
      const wallLoss =
        edge.interior * params.wallAttenuationDb +
        edge.exterior * params.exteriorWallAttenuationDb +
        edge.doors * params.doorAttenuationDb;
      // Use physical distance (not log-distance) as the length
      // component of edge cost. The old approach — per-hop
      // `10n·log10(length)` — systematically penalizes multi-hop
      // routes because `Σ log(Lᵢ) > log(ΣLᵢ)` (Jensen's
      // inequality). A 4-hop route through doors with total length
      // 13 m was rejected in favor of a direct 7 m path through
      // 2 exterior walls because the per-hop log sum inflated the
      // door route's apparent cost by ~10 dB.
      //
      // With linear distance as cost, Dijkstra finds the minimum-
      // wall path (with total distance as tiebreaker), and
      // `findBestPathForPair` applies the correct `10n·log10(total)`
      // when comparing against the direct path. The scale factor
      // converts meters to a comparable dB-like unit so wall costs
      // and distance costs are roughly balanced in Dijkstra's
      // priority ordering.
      const distanceCost = edge.length * params.pathLossExponent;
      const edgeCost = wallLoss + distanceCost;
      const newDist = dist[u] + edgeCost;
      if (newDist < dist[edge.to]) {
        dist[edge.to] = newDist;
        interior[edge.to] = interior[u] + edge.interior;
        exterior[edge.to] = exterior[u] + edge.exterior;
        doors[edge.to] = doors[u] + edge.doors;
        length[edge.to] = length[u] + edge.length;
        prev[edge.to] = u;
        queue.add(edge.to);
      }
    }
  }

  if (dist[dst] === Infinity) return null;

  // Reconstruct path.
  const pathPoints: Array<readonly [number, number]> = [];
  let curr = dst;
  while (curr !== -1) {
    pathPoints.unshift(graph.nodes[curr].point);
    curr = prev[curr];
  }

  return {
    totalLength: length[dst],
    interior: interior[dst],
    exterior: exterior[dst],
    doors: doors[dst],
    reflections: 0,
    pathPoints,
  };
}

/**
 * Convenience: compute *both* the direct-line path and the routed
 * (Dijkstra-found) path for a pair, return whichever has lower
 * predicted total loss using current params. Useful when you want
 * to ensure the routing only "wins" when it actually beats the
 * straight line.
 */
export function findBestPathForPair(
  graph: RoutingGraph,
  srcRfNodeId: string,
  dstRfNodeId: string,
  params: RfParams,
): RoutedPath | null {
  const routed = findRoutedPath(graph, srcRfNodeId, dstRfNodeId, params);
  if (!routed) return null;

  // Direct path: straight line, recompute its (length, walls).
  const src = graph.rfNodeIndex.get(srcRfNodeId);
  const dst = graph.rfNodeIndex.get(dstRfNodeId);
  if (src === undefined || dst === undefined) return routed;
  const a = graph.nodes[src].point;
  const b = graph.nodes[dst].point;
  // Find direct edge if it exists in the adjacency list (it should
  // for any two graph vertices within MAX_EDGE_LENGTH).
  let direct: RoutedPath | null = null;
  for (const e of graph.adj[src]) {
    if (e.to === dst) {
      direct = {
        totalLength: e.length,
        interior: e.interior,
        exterior: e.exterior,
        doors: e.doors,
        reflections: 0,
        pathPoints: [a, b],
      };
      break;
    }
  }
  if (!direct) return routed;

  const lossOf = (p: RoutedPath): number =>
    10 * params.pathLossExponent * Math.log10(Math.max(0.1, p.totalLength)) +
    p.interior * params.wallAttenuationDb +
    p.exterior * params.exteriorWallAttenuationDb +
    p.doors * params.doorAttenuationDb +
    p.reflections * params.reflectionLossDb;

  // Also consider all valid single-bounce specular reflections.
  // The mirror-image method gives the unique refl point on each
  // wall where angle-in = angle-out; we validate same-side + LOS
  // on both legs so only physically plausible bounces are admitted.
  const specular = findSpecularReflections(
    graph,
    a,
    b,
    params,
    getNodeRoomCentroid(srcRfNodeId) ?? undefined,
    getNodeRoomCentroid(dstRfNodeId) ?? undefined,
  );

  const candidates: RoutedPath[] = [routed, direct, ...specular];
  let best = candidates[0];
  let bestLoss = lossOf(best);
  for (let k = 1; k < candidates.length; k++) {
    const c = candidates[k];
    const l = lossOf(c);
    if (l < bestLoss) {
      best = c;
      bestLoss = l;
    }
  }
  return best;
}

/**
 * Find all *physically valid* single-bounce specular reflections
 * between two points, one per wall where:
 *
 *   1. Source and target lie on the same side of the wall's line
 *      (you can't reflect off a wall you're trying to shoot through).
 *   2. The mirror-image construction (reflect src across the wall,
 *      then line to dst) intersects the wall SEGMENT — not just its
 *      extended line. Only bounces off the actual wall surface count.
 *   3. Both legs (src→R and R→dst) have line-of-sight — no other
 *      walls block either leg. A path that needs to traverse wall A
 *      to reach a reflection point on wall B can't physically do so.
 *
 * For each valid reflection, returns a RoutedPath with points
 * `[src, R, dst]`, accumulated length `|src-R|+|R-dst|`, and
 * `reflections: 1`. Wall counts on the legs are 0 by LOS guarantee.
 *
 * The caller picks the best across all candidates (direct,
 * graph-routed, and each specular reflection) by summed loss.
 */
export function findSpecularReflections(
  graph: RoutingGraph,
  src: readonly [number, number],
  dst: readonly [number, number],
  params: RfParams,
  /**
   * Room centroid of each endpoint — used for the wall-at-endpoint
   * side test on the LOS legs. Without these, countCrossings would
   * silently drop every wall touching either endpoint, including
   * real blockers between the rooms. Pass `undefined` only when the
   * endpoint genuinely has no associated room (shouldn't happen for
   * RF-node endpoints).
   */
  srcRoomCentroid?: readonly [number, number],
  dstRoomCentroid?: readonly [number, number],
): RoutedPath[] {
  const results: RoutedPath[] = [];
  const EPS = 1e-6;

  for (const wall of graph.walls) {
    // Wall line direction and normal.
    const wx = wall.b[0] - wall.a[0];
    const wy = wall.b[1] - wall.a[1];
    const wLen2 = wx * wx + wy * wy;
    if (wLen2 < 1e-9) continue;

    // 1. Same-side-of-wall test for src and dst. Signed distance of
    // each point from the wall's line (ax + by + c = 0 form); if
    // the two have the same sign they're on the same side.
    const sideSrc = wx * (src[1] - wall.a[1]) - wy * (src[0] - wall.a[0]);
    const sideDst = wx * (dst[1] - wall.a[1]) - wy * (dst[0] - wall.a[0]);
    if (sideSrc * sideDst <= 0) continue; // opposite sides or on the line

    // 2. Mirror-image: reflect src across the wall's infinite line.
    // Then the line from src' to dst crosses the wall line at the
    // specular reflection point R. Using parametric form:
    //   R = src' + t * (dst - src')
    // where t is chosen so R lies on the wall line.
    const t = sideSrc / wLen2; // signed perpendicular distance / wLen²
    // src' = src - 2 * t * perp_normal · |wall|. In component form:
    const srcMx = src[0] + 2 * t * wy;
    const srcMy = src[1] - 2 * t * wx;

    // Parametric intersection of line(src', dst) with line(wall.a, wall.b):
    //   P = src' + u * (dst - src') = wall.a + v * (wall.b - wall.a)
    const dmx = dst[0] - srcMx;
    const dmy = dst[1] - srcMy;
    const denom = dmx * wy - dmy * wx;
    if (Math.abs(denom) < EPS) continue; // parallel — no bounce

    const ax = wall.a[0] - srcMx;
    const ay = wall.a[1] - srcMy;
    const u = (ax * wy - ay * wx) / denom; // along mirrored line
    const v = (ax * dmy - ay * dmx) / denom; // along wall segment
    if (u <= 0 || u >= 1) continue; // reflection not between src' and dst
    if (v <= 0 || v >= 1) continue; // bounce point outside wall segment

    const rx = srcMx + u * dmx;
    const ry = srcMy + u * dmy;

    // 3. LOS on both legs. If the reflection point falls on a wall
    // that isn't the one we're bouncing off, skip. We don't pass
    // a sourceRoomCentroid here because src/dst are arbitrary
    // points; any wall between them (including the bouncing wall
    // itself, which will be at source distance 0 on leg 2) is a
    // legitimate blocker. To tolerate the "wall we're reflecting
    // off touches the refl point" case, we require crossings to be
    // at-most 0 of the *other* walls.
    //
    // We take a small step off the wall (toward src for leg1, toward
    // dst for leg2) so the LOS check's endpoint doesn't sit on the
    // reflecting wall and collapse to the "at-source" epsilon.
    const nx = -wy / Math.sqrt(wLen2);
    const ny = wx / Math.sqrt(wLen2);
    // Normal points toward the side src/dst are on (sideSrc > 0 means
    // src is on the "left" wrt wall direction; flip if needed).
    const normalSign = sideSrc > 0 ? 1 : -1;
    const epsN = 0.02;
    const nearR: [number, number] = [
      rx + normalSign * nx * epsN,
      ry + normalSign * ny * epsN,
    ];

    // Leg 1: src → refl-point. Source is the RF node (pass its
    // centroid so walls touching the node's mount point are side-
    // tested). The refl-point end is near the reflecting wall but
    // offset into the room (`nearR`) — we pass `undefined` for its
    // centroid because the reflecting wall itself will be at-source
    // from nearR's perspective and should be skipped (we're
    // reflecting off it, not crossing it).
    const leg1 = countCrossings(
      src[0], src[1], nearR[0], nearR[1], graph.walls,
      srcRoomCentroid, undefined,
    );
    if (leg1.interior + leg1.exterior + leg1.doors > 0) continue;
    // Leg 2: refl-point → dst. Same reasoning in reverse — dst is
    // an RF node; its centroid enables correct handling of the
    // mount wall, while the reflecting wall remains implicitly
    // dropped via at-source from nearR.
    const leg2 = countCrossings(
      nearR[0], nearR[1], dst[0], dst[1], graph.walls,
      undefined, dstRoomCentroid,
    );
    if (leg2.interior + leg2.exterior + leg2.doors > 0) continue;

    const len1 = Math.hypot(rx - src[0], ry - src[1]);
    const len2 = Math.hypot(dst[0] - rx, dst[1] - ry);
    results.push({
      totalLength: len1 + len2,
      interior: 0,
      exterior: 0,
      doors: 0,
      reflections: 1,
      pathPoints: [src, [rx, ry], dst],
    });
  }

  // Suppress when reflection cost is meaningless for downstream cost
  // compare — the caller still does cost compare.
  void params;
  return results;
}

/**
 * Build a "route field" closure for an RF node: given any point
 * (px, py) on the floor, returns the best (lowest-loss) route from
 * that point to the node, accumulated as a RoutedPath.
 *
 * Used by the particle locator — the route field IS the topology of
 * the RSSI likelihood landscape for that node. Doors become channels
 * of low loss, walls become ridges of high loss, centroids create
 * broad in-room basins. Particles evaluating their position on this
 * surface naturally settle into the physically consistent regions.
 *
 * How it works:
 *   1. Precompute (once): Dijkstra from `srcRfNodeId` over the whole
 *      graph, giving shortest-path `(length, walls, doors)` from every
 *      graph vertex back to the node.
 *   2. Query (per (px, py)): the best route from (px, py) to the node
 *      passes through some graph vertex v (or goes direct). For each
 *      candidate v, check visibility from (px, py) to v — if clear,
 *      the route is `(px, py) → v → ... → node` with total cost
 *      `wall_loss_to_v + precomputed_loss_from_v`.
 *
 * "Visibility" is defined permissively — the leg from (px, py) to v
 * accumulates wall crossings via countCrossings, and walls along the
 * leg are added to the precomputed walls from v to the node. So the
 * result is a full RoutedPath reflecting all obstructions on the
 * best-choice route.
 *
 * Cost comparison during the per-vertex loop uses the cost function
 * from `findBestPathForPair`:
 *    10·n·log10(total_length) + wall_loss
 *
 * This is O(|V|) per query where |V| is the number of graph vertices
 * (typically ~40–100). Fast enough for particle-filter evaluation.
 */
export function buildRouteFieldForNode(
  graph: RoutingGraph,
  dstRfNodeId: string,
  params: RfParams,
): (px: number, py: number) => RoutedPath | null {
  const dst = graph.rfNodeIndex.get(dstRfNodeId);
  if (dst === undefined) {
    return () => null;
  }

  // Precompute Dijkstra from dst to all graph vertices, reusing the
  // same cost function + wall accumulation as findRoutedPath. Since
  // the graph's edges are symmetric (same wall counts a→b as b→a
  // after the both-centroids fix), a single Dijkstra gives us routes
  // FROM any vertex TO dst.
  const N = graph.nodes.length;
  const dist = new Array<number>(N).fill(Infinity);
  const interior = new Array<number>(N).fill(0);
  const exterior = new Array<number>(N).fill(0);
  const doors = new Array<number>(N).fill(0);
  const length = new Array<number>(N).fill(0);
  const prev = new Array<number>(N).fill(-1);
  dist[dst] = 0;
  const visited = new Set<number>();
  const queue = new Set<number>([dst]);

  while (queue.size > 0) {
    let u = -1;
    let minDist = Infinity;
    for (const i of queue) {
      if (dist[i] < minDist) {
        minDist = dist[i];
        u = i;
      }
    }
    if (u === -1) break;
    queue.delete(u);
    visited.add(u);

    for (const edge of graph.adj[u]) {
      if (visited.has(edge.to)) continue;
      const wallLoss =
        edge.interior * params.wallAttenuationDb +
        edge.exterior * params.exteriorWallAttenuationDb +
        edge.doors * params.doorAttenuationDb;
      const distanceCost = edge.length * params.pathLossExponent;
      const edgeCost = wallLoss + distanceCost;
      const newDist = dist[u] + edgeCost;
      if (newDist < dist[edge.to]) {
        dist[edge.to] = newDist;
        interior[edge.to] = interior[u] + edge.interior;
        exterior[edge.to] = exterior[u] + edge.exterior;
        doors[edge.to] = doors[u] + edge.doors;
        length[edge.to] = length[u] + edge.length;
        prev[edge.to] = u;
        queue.add(edge.to);
      }
    }
  }

  const dstPoint = graph.nodes[dst].point;

  // Returned closure: best route from (px, py) back to dst.
  return (px: number, py: number): RoutedPath | null => {
    let bestCost = Infinity;
    let best: RoutedPath | null = null;

    // Candidate 1: straight-line direct, no intermediate vertex.
    {
      const dx = dstPoint[0] - px;
      const dy = dstPoint[1] - py;
      const len = Math.sqrt(dx * dx + dy * dy);
      const counts = countCrossings(
        px,
        py,
        dstPoint[0],
        dstPoint[1],
        graph.walls,
      );
      const wallLoss =
        counts.interior * params.wallAttenuationDb +
        counts.exterior * params.exteriorWallAttenuationDb +
        counts.doors * params.doorAttenuationDb;
      const cost =
        10 *
          params.pathLossExponent *
          Math.log10(Math.max(0.1, len)) +
        wallLoss;
      if (cost < bestCost) {
        bestCost = cost;
        best = {
          totalLength: len,
          interior: counts.interior,
          exterior: counts.exterior,
          doors: counts.doors,
          reflections: 0,
          pathPoints: [[px, py], dstPoint],
        };
      }
    }

    // Candidate 2..N: route via each graph vertex v. Leg 1: particle
    // → v (direct with wall counts). Leg 2: precomputed route from v
    // to dst.
    for (let v = 0; v < N; v++) {
      if (v === dst) continue;
      if (dist[v] === Infinity) continue;
      const vp = graph.nodes[v].point;
      const dx = vp[0] - px;
      const dy = vp[1] - py;
      const legLen = Math.sqrt(dx * dx + dy * dy);
      // Skip distant vertices — no way they beat closer options.
      if (legLen > 30) continue;
      const legCounts = countCrossings(px, py, vp[0], vp[1], graph.walls);
      const legWallLoss =
        legCounts.interior * params.wallAttenuationDb +
        legCounts.exterior * params.exteriorWallAttenuationDb +
        legCounts.doors * params.doorAttenuationDb;
      const totalLen = legLen + length[v];
      const totalWallLoss =
        (legCounts.interior + interior[v]) * params.wallAttenuationDb +
        (legCounts.exterior + exterior[v]) *
          params.exteriorWallAttenuationDb +
        (legCounts.doors + doors[v]) * params.doorAttenuationDb;
      const cost =
        10 *
          params.pathLossExponent *
          Math.log10(Math.max(0.1, totalLen)) +
        totalWallLoss;
      void legWallLoss;
      if (cost < bestCost) {
        bestCost = cost;
        // Reconstruct path points from v → dst.
        const legPoints: Array<readonly [number, number]> = [[px, py]];
        let curr: number = v;
        while (curr !== -1) {
          legPoints.push(graph.nodes[curr].point);
          curr = prev[curr];
        }
        best = {
          totalLength: totalLen,
          interior: legCounts.interior + interior[v],
          exterior: legCounts.exterior + exterior[v],
          doors: legCounts.doors + doors[v],
          reflections: 0,
          pathPoints: legPoints,
        };
      }
    }

    return best;
  };
}
