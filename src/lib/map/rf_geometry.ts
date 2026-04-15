import type { Floor, Room } from "@/lib/config";
import { openToDoor, openToWidth } from "@/lib/config/schema";
import { pointInPolygon } from "@/lib/locators/room_aware";

/**
 * Geometry primitives for the RF propagation model. Each room polygon
 * edge becomes a wall segment, optionally annotated with door-opening
 * ranges (fractions along the segment where signal passes without
 * attenuation).
 *
 * Multiple rooms may declare walls at the same physical location (both
 * sides of a shared wall). We dedupe by a tolerance on endpoint
 * position so a shared wall doesn't get counted twice in crossing
 * counts. Door openings from any side accumulate onto the shared wall.
 */

/** Endpoint match tolerance for deduplicating shared walls (metres). */
const DEDUP_EPSILON = 0.05;

/** Default door width (m) when an open_to entry lacks an explicit width. */
const DEFAULT_DOOR_WIDTH = 0.8;

/**
 * A single wall segment in the floor plan. `a` and `b` are its endpoints
 * in config-space metres. `openings` lists one or more door-opening
 * ranges as fractions 0..1 along the segment from `a` toward `b`; a
 * crossing within any of these ranges is treated as door-attenuation
 * rather than wall-attenuation.
 *
 * `isExterior` is auto-detected during construction: a segment is
 * considered exterior when it was declared by only one room's polygon
 * (the other side is unmapped space, i.e. outside the home). Doors
 * declaring `id: outside` on an exterior segment preserve the
 * exterior tag — the wall is still exterior, just with an opening in
 * it.
 */
export interface WallSegment {
  a: readonly [number, number];
  b: readonly [number, number];
  openings: Array<{ t0: number; t1: number }>;
  isExterior: boolean;
}

/**
 * Build wall segments for every floor. Walks each room polygon's edges
 * and dedupes shared walls by endpoint position. For each door declared
 * in `open_to`, projects it onto the nearest wall segment and records
 * the opening range.
 */
export function buildWallSegments(floors: readonly Floor[]): WallSegment[] {
  const rawSegments: Array<{
    a: [number, number];
    b: [number, number];
  }> = [];
  const doors: Array<{ x: number; y: number; width: number }> = [];
  const allRooms: Room[] = floors.flatMap((f) => f.rooms);
  // Collect every polygon vertex across every room — used below to
  // split raw segments where another room's corner lies on them.
  // Without this, a long polygon edge that's only partially adjacent
  // to another room (Dining's south wall is entirely one edge, but only
  // its inner half borders Entryway) gets classified by its midpoint
  // alone, masking the other-half's true interior/exterior nature.
  const allVertices: Array<[number, number]> = [];
  for (const r of allRooms) {
    if (!r.points) continue;
    for (const p of r.points) allVertices.push([p[0], p[1]]);
  }

  for (const floor of floors) {
    for (const room of floor.rooms) {
      if (!room.points || room.points.length < 2) continue;
      const pts = room.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        // Split this edge at any other-room vertex that lies on it,
        // producing one or more sub-segments each of which is
        // geometrically uniform (fully interior or fully exterior).
        const parts = splitSegmentAtForeignVertices(
          [a[0], a[1]],
          [b[0], b[1]],
          allVertices,
        );
        for (const p of parts) {
          rawSegments.push({ a: p.a, b: p.b });
        }
      }

      // Collect doors from this room's open_to list. Doors only live
      // on the room that declared them, but the resulting segment dedup
      // below means a door added on either side of a shared wall lands
      // on the single deduped segment.
      for (const entry of room.open_to) {
        const d = openToDoor(entry);
        if (!d) continue;
        // We don't filter by `id` here — even `id: outside` doors are
        // real openings in the wall, so they contribute.
        doors.push({
          x: d[0],
          y: d[1],
          width: openToWidth(entry) ?? DEFAULT_DOOR_WIDTH,
        });
      }
    }
  }

  // Dedupe by exact endpoint match. Partial-overlap walls (e.g. a long
  // Hallway wall with a shorter Dining Room wall running along the
  // same line but shorter) are *not* caught here — they're handled
  // both at crossing-count time (via `CROSSING_MERGE_EPSILON`) and
  // below when tagging exterior-vs-interior.
  const deduped: WallSegment[] = [];
  for (const seg of rawSegments) {
    const match = deduped.find((d) => segmentsMatch(d, seg));
    if (!match) {
      deduped.push({
        a: seg.a,
        b: seg.b,
        openings: [],
        isExterior: false, // set below via geometric test
      });
    }
  }

  // Classify each segment and drop the ones that aren't physically
  // walls at all. A segment becomes a wall if both sides land in rooms
  // with *different* `floor_area` tags (or no tag, or different
  // non-null tags). Segments between two rooms sharing the same
  // floor_area represent open-plan passages — the config tells us
  // kitchen/dining/living aren't separated by a wall, so signal
  // shouldn't be attenuated there.
  //
  // Interior vs exterior for kept walls:
  //   - Both sides in rooms (regardless of floor_area differences) →
  //     interior.
  //   - Only one side has a room (other is unmapped space) → exterior.
  const classifiableRooms = allRooms.filter(
    (r): r is Room & { points: ReadonlyArray<readonly [number, number]> } =>
      Boolean(r.points && r.points.length >= 3),
  );
  const classified: WallSegment[] = [];
  for (const seg of deduped) {
    const { sideA, sideB } = classifySegmentSides(seg, classifiableRooms);
    // Both sides in the same open-plan floor_area → not a wall.
    if (
      sideA &&
      sideB &&
      sideA.floor_area &&
      sideB.floor_area &&
      sideA.floor_area === sideB.floor_area
    ) {
      continue;
    }
    seg.isExterior = !(sideA && sideB);
    classified.push(seg);
  }
  deduped.length = 0;
  deduped.push(...classified);

  // Project each door onto its nearest wall segment and compute the
  // opening range as [t0, t1] fractions along the segment.
  for (const door of doors) {
    let bestSeg: WallSegment | null = null;
    let bestDistSq = Infinity;
    for (const seg of deduped) {
      const d = pointToSegmentDistSq(door.x, door.y, seg.a, seg.b);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestSeg = seg;
      }
    }
    if (!bestSeg) continue;

    const segLen = Math.hypot(
      bestSeg.b[0] - bestSeg.a[0],
      bestSeg.b[1] - bestSeg.a[1],
    );
    if (segLen < 1e-6) continue;

    // Find the `t` fraction along the segment that projects closest to
    // the door centre, then fan out by half the door width in each
    // direction (clamped to [0, 1]).
    const tCenter = closestTOnSegment(door.x, door.y, bestSeg.a, bestSeg.b);
    const halfTFrac = door.width / (2 * segLen);
    bestSeg.openings.push({
      t0: Math.max(0, tCenter - halfTFrac),
      t1: Math.min(1, tCenter + halfTFrac),
    });
  }

  // Merge overlapping door openings per segment (e.g. if the user
  // declared near-duplicate doors from both sides of a shared wall).
  for (const seg of deduped) {
    seg.openings = mergeOpenings(seg.openings);
  }

  return deduped;
}

/**
 * Distance threshold (metres) for treating a wall as "at the source"
 * rather than an obstacle between source and target. Wall-mounted
 * nodes sit exactly on a wall segment — that wall shouldn't
 * attenuate the signal the node emits into its own room.
 */
const WALL_AT_SOURCE_EPSILON = 0.1;

/**
 * Fraction-along-line tolerance for collapsing multiple wall
 * intersections at the same point. Endpoint-level dedup in
 * `buildWallSegments` only catches walls whose endpoints match; it
 * misses partial overlaps (e.g. Garage's long wall along y=6.77 versus
 * Entryway's short wall along the same line). Two rooms sharing a
 * physical wall should count as ONE crossing, even if one room's
 * polygon edge spans only part of the other's. Collapsing hits within
 * this tolerance fixes that without requiring full collinear-overlap
 * merging at construction time.
 */
const CROSSING_MERGE_EPSILON = 0.005;

/**
 * Count walls crossed by the line segment from `(fx, fy)` to `(tx, ty)`.
 * Returns the number of solid-wall crossings AND the number of door
 * crossings separately — the RF model weights them differently.
 *
 * Walls at the source (within `WALL_AT_SOURCE_EPSILON`) are only
 * skipped when the target lies on the *same side* of the wall as the
 * source's assigned room centroid. This matters for wall-mounted
 * nodes: signal propagating *into* the room (same side as centroid)
 * sees no attenuation from the wall the node is mounted on, but
 * signal propagating *across* the wall into another room is legitimately
 * obstructed by it. Without the side test, the mount wall would
 * vanish from the model entirely, producing a strong "leak" of signal
 * out the back of the node.
 *
 * When `sourceRoomCentroid` is omitted, walls at the source are
 * skipped unconditionally (legacy behavior — use this only when the
 * source's room is unknown).
 *
 * Multiple wall segments that intersect the line at nearly the same
 * point (partially-overlapping polygon edges from different rooms)
 * are collapsed into a single crossing. If any of the overlapping
 * segments has an opening at that point, the whole crossing counts
 * as a door (a door opening beats a solid wall at the same location).
 */
export function countCrossings(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  walls: readonly WallSegment[],
  sourceRoomCentroid?: readonly [number, number],
): { interior: number; exterior: number; doors: number } {
  const hits: Array<{ lineT: number; opening: boolean; exterior: boolean }> = [];
  for (const seg of walls) {
    const atSource =
      pointToSegmentDistSq(fx, fy, seg.a, seg.b) <
      WALL_AT_SOURCE_EPSILON * WALL_AT_SOURCE_EPSILON;
    if (atSource) {
      if (!sourceRoomCentroid) continue;
      // Side test: is the target on the same side of the wall line as
      // the room's centroid? Cross product of wall vector × (point −
      // wall-a) gives a signed area whose sign tells us which side of
      // the line the point lies on. Same sign → same side → skip.
      const side =
        sidednessSign(sourceRoomCentroid[0], sourceRoomCentroid[1], seg.a, seg.b) *
        sidednessSign(tx, ty, seg.a, seg.b);
      if (side >= 0) continue; // same side (or target on the line itself)
    }
    const hit = segmentIntersection(fx, fy, tx, ty, seg.a, seg.b);
    if (!hit) continue;
    const inOpening = seg.openings.some(
      (o) => hit.segT >= o.t0 && hit.segT <= o.t1,
    );
    hits.push({
      lineT: hit.lineT,
      opening: inOpening,
      exterior: seg.isExterior,
    });
  }
  // Collapse hits at the same point along the line (shared walls that
  // show up as multiple polygon edges). Merging rules when multiple
  // segments coincide at the same crossing:
  //
  //   - If any has an opening (door) at that point → counts as a door.
  //   - Else if any is exterior → counts as exterior.
  //   - Else → interior.
  //
  // The "any-opening" rule means a declared door on one side of a
  // shared wall correctly converts the crossing to a door even if the
  // other side's polygon edge doesn't also declare one.
  hits.sort((a, b) => a.lineT - b.lineT);
  let interior = 0;
  let exterior = 0;
  let doors = 0;
  let i = 0;
  while (i < hits.length) {
    let j = i + 1;
    let anyOpening = hits[i].opening;
    let anyExterior = hits[i].exterior;
    while (
      j < hits.length &&
      hits[j].lineT - hits[i].lineT < CROSSING_MERGE_EPSILON
    ) {
      if (hits[j].opening) anyOpening = true;
      if (hits[j].exterior) anyExterior = true;
      j++;
    }
    if (anyOpening) doors++;
    else if (anyExterior) exterior++;
    else interior++;
    i = j;
  }
  return { interior, exterior, doors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function segmentsMatch(
  a: WallSegment,
  b: { a: readonly [number, number]; b: readonly [number, number] },
): boolean {
  const sameAB =
    near(a.a, b.a) && near(a.b, b.b);
  const sameBA =
    near(a.a, b.b) && near(a.b, b.a);
  return sameAB || sameBA;
}

function near(
  p: readonly [number, number],
  q: readonly [number, number],
): boolean {
  return Math.abs(p[0] - q[0]) < DEDUP_EPSILON && Math.abs(p[1] - q[1]) < DEDUP_EPSILON;
}

/** Tolerance (metres) for a vertex being "on" a segment line. */
const SPLIT_POINT_EPS = 0.05;
/**
 * Minimum sub-segment t-length below which a split piece is discarded
 * as a numerical sliver. Segments shorter than this wouldn't classify
 * reliably and aren't useful for RF modelling anyway.
 */
const MIN_SUBSEG_T = 0.02;

/**
 * Split a raw polygon edge at every point where some *other* room's
 * polygon vertex lies on it. Returns the sub-segments (one or more).
 *
 * The rationale: a single polygon edge may be partly interior (shared
 * with another room) and partly exterior (sticks out past the adjacent
 * room's extent). If we classify the whole edge by its midpoint, we
 * miss the transition. Splitting at every foreign vertex gives us
 * pieces whose geometry is uniform, and each piece's midpoint then
 * correctly reflects its classification.
 */
function splitSegmentAtForeignVertices(
  a: readonly [number, number],
  b: readonly [number, number],
  vertices: ReadonlyArray<readonly [number, number]>,
): Array<{ a: [number, number]; b: [number, number] }> {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const segLen = Math.sqrt(len2);
  if (len2 < 1e-9) return [{ a: [a[0], a[1]], b: [b[0], b[1]] }];

  // Collect split-point t-values from vertices that lie on this edge's
  // line AND within its endpoints (excluding the endpoints themselves).
  const ts: number[] = [];
  for (const v of vertices) {
    // Perpendicular distance from v to the line A→B
    const perpSigned = (v[0] - a[0]) * dy - (v[1] - a[1]) * dx;
    const perpDist = Math.abs(perpSigned) / segLen;
    if (perpDist > SPLIT_POINT_EPS) continue;
    // Projection parameter onto the segment
    const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / len2;
    if (t > MIN_SUBSEG_T && t < 1 - MIN_SUBSEG_T) ts.push(t);
  }
  if (ts.length === 0) return [{ a: [a[0], a[1]], b: [b[0], b[1]] }];

  // Sort, dedupe nearby values (vertices shared between rooms appear
  // twice in `vertices`).
  ts.sort((x, y) => x - y);
  const deduped: number[] = [0];
  for (const t of ts) {
    if (t - deduped[deduped.length - 1] > MIN_SUBSEG_T) deduped.push(t);
  }
  if (1 - deduped[deduped.length - 1] > MIN_SUBSEG_T) deduped.push(1);
  else deduped[deduped.length - 1] = 1;

  const out: Array<{ a: [number, number]; b: [number, number] }> = [];
  for (let i = 0; i < deduped.length - 1; i++) {
    const t0 = deduped[i];
    const t1 = deduped[i + 1];
    out.push({
      a: [a[0] + t0 * dx, a[1] + t0 * dy],
      b: [a[0] + t1 * dx, a[1] + t1 * dy],
    });
  }
  return out;
}

/**
 * Offset (metres) applied perpendicular to a wall segment when
 * probing which side(s) land inside a room polygon. Needs to be
 * large enough to cross the numerical epsilon of point-in-polygon
 * but small enough that the probe point stays within the adjacent
 * room rather than crossing into yet another one.
 */
const INTERIOR_PROBE_OFFSET = 0.15;

/**
 * Classify a wall segment by probing which room (if any) lies on each
 * side of its midpoint. Returns the two room references; either may
 * be null when that side is unmapped space.
 */
function classifySegmentSides(
  seg: { a: readonly [number, number]; b: readonly [number, number] },
  rooms: ReadonlyArray<Room & { points: ReadonlyArray<readonly [number, number]> }>,
): {
  sideA: (Room & { points: ReadonlyArray<readonly [number, number]> }) | null;
  sideB: (Room & { points: ReadonlyArray<readonly [number, number]> }) | null;
} {
  const mx = (seg.a[0] + seg.b[0]) / 2;
  const my = (seg.a[1] + seg.b[1]) / 2;
  const dx = seg.b[0] - seg.a[0];
  const dy = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { sideA: null, sideB: null };
  const nx = -dy / len;
  const ny = dx / len;
  const p1x = mx + nx * INTERIOR_PROBE_OFFSET;
  const p1y = my + ny * INTERIOR_PROBE_OFFSET;
  const p2x = mx - nx * INTERIOR_PROBE_OFFSET;
  const p2y = my - ny * INTERIOR_PROBE_OFFSET;
  let sideA: typeof rooms[number] | null = null;
  let sideB: typeof rooms[number] | null = null;
  for (const r of rooms) {
    if (!sideA && pointInPolygon([p1x, p1y], r.points)) sideA = r;
    if (!sideB && pointInPolygon([p2x, p2y], r.points)) sideB = r;
    if (sideA && sideB) break;
  }
  return { sideA, sideB };
}

/**
 * Signed twice-area of the triangle (a, b, p). The sign tells us which
 * side of the infinite line through `a`→`b` the point `p` lies on:
 * positive → one side, negative → the other, ~0 → on the line itself.
 * Used to decide whether a target is on the same side of a wall as the
 * source's assigned room centroid (i.e. signal stays in-room vs.
 * crosses through the wall).
 */
function sidednessSign(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const t = closestTOnSegment(px, py, a, b);
  const cx = a[0] + t * (b[0] - a[0]);
  const cy = a[1] + t * (b[1] - a[1]);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function closestTOnSegment(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return 0;
  const t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}

/**
 * Intersect line segment P1→P2 with segment Q1→Q2. Returns the crossing
 * point with parameters along both segments (`lineT` along P, `segT`
 * along Q, both in [0, 1] for a real crossing), or null if they don't
 * cross.
 */
function segmentIntersection(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  q1: readonly [number, number],
  q2: readonly [number, number],
): { x: number; y: number; lineT: number; segT: number } | null {
  const rx = p2x - p1x;
  const ry = p2y - p1y;
  const sx = q2[0] - q1[0];
  const sy = q2[1] - q1[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = q1[0] - p1x;
  const qpy = q1[1] - p1y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {
    x: p1x + t * rx,
    y: p1y + t * ry,
    lineT: t,
    segT: u,
  };
}

function mergeOpenings(
  list: Array<{ t0: number; t1: number }>,
): Array<{ t0: number; t1: number }> {
  if (list.length <= 1) return list;
  const sorted = [...list].sort((x, y) => x.t0 - y.t0);
  const out: Array<{ t0: number; t1: number }> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.t0 <= last.t1) {
      last.t1 = Math.max(last.t1, cur.t1);
    } else {
      out.push(cur);
    }
  }
  return out;
}
