import type { Floor, Node } from "@/lib/config";

export type Point2D = readonly [number, number];
export type Point3D = readonly [number, number, number];

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Serializable parameters describing how to map config-space → SVG-space. */
export interface FloorTransform {
  bounds: Bounds2D;
  flipX: boolean;
  flipY: boolean;
}

/** Apply a FloorTransform to an x coordinate (returns SVG-space x). */
export function tx(t: FloorTransform, x: number): number {
  return t.flipX ? t.bounds.maxX - x : x - t.bounds.minX;
}

/** Apply a FloorTransform to a y coordinate (returns SVG-space y). */
export function ty(t: FloorTransform, y: number): number {
  return t.flipY ? t.bounds.maxY - y : y - t.bounds.minY;
}

/** Inverse of `tx` — convert SVG-space x back to config-space x. */
export function txInv(t: FloorTransform, svgX: number): number {
  return t.flipX ? t.bounds.maxX - svgX : svgX + t.bounds.minX;
}

/** Inverse of `ty` — convert SVG-space y back to config-space y. */
export function tyInv(t: FloorTransform, svgY: number): number {
  return t.flipY ? t.bounds.maxY - svgY : svgY + t.bounds.minY;
}

/**
 * Filter a config node list to those that belong on a given floor. A node
 * with no `floors` field is treated as belonging to all floors (matches
 * upstream behavior). Nodes without a `point` are dropped — we can't render
 * them on a map.
 */
export function nodesForFloor<
  T extends { point?: Point3D; floors?: readonly string[] | null },
>(nodes: readonly T[], floorId: string | undefined): T[] {
  return nodes.filter((n) => {
    if (!n.point) return false;
    if (!n.floors || n.floors.length === 0) return true;
    return floorId ? n.floors.includes(floorId) : false;
  });
}

/**
 * A reference to a single edge of a room polygon — used by the wall-based
 * node placement UI. The `direction` and `normal` are pre-computed unit
 * vectors so the position math at edit time is a single multiply-add.
 */
export interface WallRef {
  /** Identifier of the parent room (for display only). */
  roomId: string;
  /** Display name of the parent room. */
  roomName: string;
  /** Edge endpoints in floor coordinates. */
  a: Point2D;
  b: Point2D;
  /** Edge length in meters. */
  length: number;
  /** Unit vector pointing A → B. */
  direction: Point2D;
  /** Unit vector perpendicular to the wall, pointing into the room. */
  normal: Point2D;
}

/**
 * Build a `WallRef` for a polygon edge. Picks the perpendicular direction
 * that points toward the room centroid (the "interior" side) so a positive
 * `perp` offset always means "into the room".
 */
export function buildWallRef(
  roomId: string,
  roomName: string,
  a: Point2D,
  b: Point2D,
  centroid: Point2D,
): WallRef | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const dirX = dx / length;
  const dirY = dy / length;
  // Rotate direction by +90° as a candidate normal.
  let nx = -dirY;
  let ny = dirX;
  // Flip if it points away from the centroid.
  const midX = (a[0] + b[0]) / 2;
  const midY = (a[1] + b[1]) / 2;
  if (nx * (centroid[0] - midX) + ny * (centroid[1] - midY) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return {
    roomId,
    roomName,
    a,
    b,
    length,
    direction: [dirX, dirY],
    normal: [nx, ny],
  };
}

/**
 * Compute a 3D node position from a wall + offsets.
 *
 * @param along  distance along the wall from the chosen start corner
 * @param perp   perpendicular offset (positive = into the room)
 * @param z      mounting height above the floor
 * @param flipped if true, measure `along` from corner B instead of A
 */
export function pointFromWall(
  wall: WallRef,
  along: number,
  perp: number,
  z: number,
  flipped: boolean,
): readonly [number, number, number] {
  const start = flipped ? wall.b : wall.a;
  const dirX = flipped ? -wall.direction[0] : wall.direction[0];
  const dirY = flipped ? -wall.direction[1] : wall.direction[1];
  const x = start[0] + dirX * along + wall.normal[0] * perp;
  const y = start[1] + dirY * along + wall.normal[1] * perp;
  return [x, y, z];
}

/**
 * A reference to a polygon corner — used by the corner-based node placement
 * UI. A corner can be shared by several rooms (a vertex where N polygons
 * meet); we keep all the room names for display.
 */
export interface CornerRef {
  /** Corner location in floor coordinates. */
  point: Point2D;
  /** Names of every room polygon that includes this vertex. */
  roomNames: readonly string[];
}

/**
 * Build a deduplicated list of corners across all the rooms on a floor. Two
 * vertices that round to the same millimetre are treated as the same
 * corner — that handles the very common "two adjacent rooms share an
 * interior wall" case where each room has its own copy of the same point.
 */
export function buildCornerIndex(
  rooms: ReadonlyArray<{
    name?: string;
    id?: string;
    points?: ReadonlyArray<readonly [number, number]>;
  }>,
): CornerRef[] {
  const map = new Map<string, { point: Point2D; rooms: Set<string> }>();
  for (const room of rooms) {
    if (!room.points) continue;
    const label = room.name ?? room.id ?? "";
    for (const p of room.points) {
      const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
      const existing = map.get(key);
      if (existing) {
        if (label) existing.rooms.add(label);
      } else {
        map.set(key, {
          point: [p[0], p[1]] as Point2D,
          rooms: new Set(label ? [label] : []),
        });
      }
    }
  }
  return Array.from(map.values()).map((entry) => ({
    point: entry.point,
    roomNames: Array.from(entry.rooms),
  }));
}

/**
 * Compute a 3D node position by offsetting from a corner. dx and dy are in
 * the same coordinate system as the floor (config-space, before any flips).
 */
export function pointFromCorner(
  corner: CornerRef,
  dx: number,
  dy: number,
  z: number,
): readonly [number, number, number] {
  return [corner.point[0] + dx, corner.point[1] + dy, z];
}

/**
 * Signed-area polygon centroid. Handles concave polygons correctly (simple
 * vertex-averaging would misplace labels on L-shaped rooms like garages).
 * Falls back to vertex mean for degenerate (zero-area) polygons.
 */
export function polygonCentroid(points: readonly Point2D[]): Point2D {
  if (points.length === 0) return [0, 0];
  if (points.length < 3) {
    const sx = points.reduce((s, p) => s + p[0], 0);
    const sy = points.reduce((s, p) => s + p[1], 0);
    return [sx / points.length, sy / points.length];
  }

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  if (twiceArea === 0) {
    const sx = points.reduce((s, p) => s + p[0], 0);
    const sy = points.reduce((s, p) => s + p[1], 0);
    return [sx / points.length, sy / points.length];
  }

  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

/** Absolute polygon area (signed-area formula, unsigned result). */
export function polygonArea(points: readonly Point2D[]): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    twice += x0 * y1 - x1 * y0;
  }
  return Math.abs(twice) / 2;
}

/** Axis-aligned bounding box of a polygon. */
export function polygonBBox(points: readonly Point2D[]): Bounds2D {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Pick a label font size in meters that fits `label` inside `points` at the
 * centroid. Returns `null` when even the minimum size would overflow — caller
 * should skip rendering the label in that case.
 */
export function fitLabelSize(
  label: string,
  points: readonly Point2D[],
  opts: { min?: number; max?: number; charWidth?: number } = {},
): number | null {
  const min = opts.min ?? 0.14;
  const max = opts.max ?? 0.32;
  const charWidth = opts.charWidth ?? 0.58; // sans-serif avg glyph width / em

  const n = Math.max(label.length, 1);
  const area = polygonArea(points);
  const bb = polygonBBox(points);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  if (w <= 0 || h <= 0) return null;

  // Three upper bounds: don't outgrow the room, its width, or its height.
  const byArea = Math.sqrt(area) * 0.33;
  const byWidth = w / (charWidth * n);
  const byHeight = h / 2.5;
  const ideal = Math.min(byArea, byWidth, byHeight);

  if (ideal < min) return null;
  return Math.min(ideal, max);
}

/** Resolve the 2D extent of a floor, preferring explicit config bounds. */
export function computeFloorBounds(floor: Floor, nodes: Node[]): Bounds2D {
  if (floor.bounds) {
    const [[minX, minY], [maxX, maxY]] = floor.bounds;
    return { minX, minY, maxX, maxY };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const room of floor.rooms) {
    for (const [x, y] of room.points ?? []) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  for (const n of nodes) {
    if (!n.point) continue;
    if (n.floors && floor.id && !n.floors.includes(floor.id)) continue;
    const [x, y] = n.point;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  return { minX, minY, maxX, maxY };
}
