import type { Floor } from "@/lib/config";
import { openToDoor, openToWidth } from "@/lib/config/schema";

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
 */
export interface WallSegment {
  a: readonly [number, number];
  b: readonly [number, number];
  openings: Array<{ t0: number; t1: number }>;
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

  for (const floor of floors) {
    for (const room of floor.rooms) {
      if (!room.points || room.points.length < 2) continue;
      const pts = room.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        rawSegments.push({
          a: [a[0], a[1]],
          b: [b[0], b[1]],
        });
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

  // Dedupe: collapse segments that share both endpoints (within epsilon)
  // regardless of orientation. Produces one canonical segment per
  // shared wall so crossing counts aren't doubled.
  const deduped: WallSegment[] = [];
  for (const seg of rawSegments) {
    const match = deduped.find((d) => segmentsMatch(d, seg));
    if (!match) {
      deduped.push({ a: seg.a, b: seg.b, openings: [] });
    }
  }

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
 * Count walls crossed by the line segment from `(fx, fy)` to `(tx, ty)`.
 * Returns the number of solid-wall crossings AND the number of door
 * crossings separately — the RF model weights them differently.
 */
export function countCrossings(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  walls: readonly WallSegment[],
): { walls: number; doors: number } {
  let wallHits = 0;
  let doorHits = 0;
  for (const seg of walls) {
    const hit = segmentIntersection(fx, fy, tx, ty, seg.a, seg.b);
    if (!hit) continue;
    const inOpening = seg.openings.some(
      (o) => hit.segT >= o.t0 && hit.segT <= o.t1,
    );
    if (inOpening) doorHits++;
    else wallHits++;
  }
  return { walls: wallHits, doors: doorHits };
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
 * point with the parameter along Q (0..1 for a crossing inside Q), or
 * null if they don't cross.
 */
function segmentIntersection(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  q1: readonly [number, number],
  q2: readonly [number, number],
): { x: number; y: number; segT: number } | null {
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
