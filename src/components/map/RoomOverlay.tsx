"use client";

import { useCallback, useMemo, useState } from "react";
import type { Floor } from "@/lib/config";
import { polygonCentroid, tx, ty, txInv, tyInv, type FloorTransform } from "@/lib/map/geometry";
import { useMapTool } from "./MapToolProvider";
import { usePresenceZones, ZONE_COLORS } from "./PresenceZonesProvider";
import { useRoomRelations } from "./RoomRelationsProvider";

interface Props {
  floor: Floor;
  transform: FloorTransform;
}

const ARROW_COLOR = "#14b8a6";
const ARROW_STROKE = 0.05;
const MARKER_ID = "room-conn-arrow";

// Door swing arc geometry (metres).
/**
 * Default door width — standard interior door (~32" / 0.81 m). Used when
 * a connection doesn't specify its own `width` override. Wider openings
 * (sliding glass, archways) set a per-edge width via `open_to[].width`.
 */
const DEFAULT_DOOR_WIDTH = 0.8;
const DOOR_STROKE_W = 0.04; // stroke width for door leaf and arc

/**
 * Return the outward unit normal AND edge tangent for the edge of `points`
 * nearest to `(doorX, doorY)`, with normal oriented toward `(facingX, facingY)`.
 */
function wallEdgeInfoAt(
  doorX: number,
  doorY: number,
  points: readonly (readonly number[])[],
  facingX: number,
  facingY: number,
): { nx: number; ny: number; tanX: number; tanY: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let bestDist = Infinity;
  let best: { nx: number; ny: number; tanX: number; tanY: number } | null = null;
  for (let i = 0; i < n; i++) {
    const ax = points[i][0], ay = points[i][1];
    const bx = points[(i + 1) % n][0], by = points[(i + 1) % n][1];
    const edgeDx = bx - ax, edgeDy = by - ay;
    const len2 = edgeDx * edgeDx + edgeDy * edgeDy;
    let px: number, py: number;
    if (len2 < 1e-12) { px = ax; py = ay; }
    else {
      const t = Math.max(0, Math.min(1, ((doorX - ax) * edgeDx + (doorY - ay) * edgeDy) / len2));
      px = ax + t * edgeDx; py = ay + t * edgeDy;
    }
    const dist = Math.hypot(doorX - px, doorY - py);
    if (dist < bestDist) {
      bestDist = dist;
      const el = Math.sqrt(len2) || 1;
      const perpX = edgeDy / el, perpY = -edgeDx / el;
      const dot = perpX * (facingX - px) + perpY * (facingY - py);
      const nx = dot >= 0 ? perpX : -perpX;
      const ny = dot >= 0 ? perpY : -perpY;
      best = { nx, ny, tanX: edgeDx / el, tanY: edgeDy / el };
    }
  }
  return best;
}

export const GROUP_COLORS = [
  "#f59e0b", // amber-500
  "#ec4899", // pink-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
  "#a78bfa", // violet-400
  "#fb7185", // rose-400
];

// ─── Grid-based group boundary ───────────────────────────────────────────────
//
// We rasterise every room polygon onto a fine grid, optionally dilate by one
// cell to bridge small gaps between adjacent rooms, then trace directed
// boundary edges into closed polygons.  This is the only approach that is
// fully correct: it works regardless of whether room polygons share exact
// vertices, and it can never produce lines that pass through a room interior.

function pointInPolygon(
  px: number,
  py: number,
  poly: readonly (readonly number[])[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

type RoomLike = { points?: readonly (readonly number[])[] | null };

/**
 * Rasterise `rooms` at `res` metres/cell, dilate by `dilate` cells to bridge
 * small gaps, then trace the binary boundary into closed polygon paths
 * (in room-coordinate space).
 */
function rasterBoundary(
  rooms: RoomLike[],
  res = 0.1,
  dilate = 1,
): [number, number][][] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const room of rooms) {
    for (const p of room.points ?? []) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
  }
  if (!isFinite(x0)) return [];

  // Pad so boundary cells are always surrounded by empty cells.
  const pad = dilate + 1;
  x0 -= pad * res; y0 -= pad * res;
  const W = Math.ceil((x1 + pad * res - x0) / res) + 1;
  const H = Math.ceil((y1 + pad * res - y0) / res) + 1;

  // ── Rasterise ──────────────────────────────────────────────────────────────
  const raw = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const px = x0 + (c + 0.5) * res, py = y0 + (r + 0.5) * res;
      for (const room of rooms) {
        if (room.points && pointInPolygon(px, py, room.points)) {
          raw[r * W + c] = 1;
          break;
        }
      }
    }
  }

  // ── Dilate ─────────────────────────────────────────────────────────────────
  const grid = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (raw[r * W + c]) { grid[r * W + c] = 1; continue; }
      outer: for (let dr = -dilate; dr <= dilate; dr++) {
        for (let dc = -dilate; dc <= dilate; dc++) {
          const r2 = r + dr, c2 = c + dc;
          if (r2 >= 0 && r2 < H && c2 >= 0 && c2 < W && raw[r2 * W + c2]) {
            grid[r * W + c] = 1; break outer;
          }
        }
      }
    }
  }

  const at = (c: number, r: number) =>
    c >= 0 && c < W && r >= 0 && r < H ? grid[r * W + c] : 0;

  // ── Directed boundary edges ─────────────────────────────────────────────────
  // Grid corners are integer (col, row) pairs; the corner at (c,r) maps to
  // room coord (x0 + c*res, y0 + r*res).
  //
  // CCW convention (interior on the left of the directed edge):
  //   horizontal boundary between rows r-1 and r:
  //     filled-above / empty-below  → edge goes LEFT:  [c+1,r] → [c,r]
  //     empty-above  / filled-below → edge goes RIGHT: [c,r]   → [c+1,r]
  //   vertical boundary between cols c-1 and c:
  //     filled-left / empty-right   → edge goes DOWN:  [c,r]   → [c,r+1]
  //     empty-left  / filled-right  → edge goes UP:    [c,r+1] → [c,r]
  const edgeMap = new Map<string, string>(); // "fc,fr" → "tc,tr"
  const add = (fc: number, fr: number, tc: number, tr: number) =>
    edgeMap.set(`${fc},${fr}`, `${tc},${tr}`);

  for (let r = 0; r <= H; r++) {
    for (let c = 0; c < W; c++) {
      const above = at(c, r - 1), below = at(c, r);
      if (above && !below) add(c + 1, r, c, r);
      else if (!above && below) add(c, r, c + 1, r);
    }
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c <= W; c++) {
      const left = at(c - 1, r), right = at(c, r);
      if (left && !right) add(c, r, c, r + 1);
      else if (!left && right) add(c, r + 1, c, r);
    }
  }

  // ── Trace chains ───────────────────────────────────────────────────────────
  const visited = new Set<string>();
  const polygons: [number, number][][] = [];

  for (const startKey of edgeMap.keys()) {
    if (visited.has(startKey)) continue;
    const poly: [number, number][] = [];
    let key = startKey;
    while (!visited.has(key) && edgeMap.has(key)) {
      visited.add(key);
      const comma = key.indexOf(",");
      const col = +key.slice(0, comma), row = +key.slice(comma + 1);
      // Remove collinear point: check if previous, this, and next are colinear.
      // (We defer this check to after the loop since we don't have "next" yet.)
      poly.push([x0 + col * res, y0 + row * res]);
      key = edgeMap.get(key)!;
    }
    if (poly.length >= 4) {
      // Remove collinear points (consecutive edges in the same direction).
      const simplified: [number, number][] = [];
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
        const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(cross) > 1e-9) simplified.push(b);
      }
      if (simplified.length >= 4) polygons.push(simplified);
    }
  }

  return polygons;
}

// ─────────────────────────────────────────────────────────────────────────────


export default function RoomOverlay({ floor, transform }: Props) {
  const { activeTool } = useMapTool();
  const relations = useRoomRelations();
  const zones = usePresenceZones();

  const isRelationsMode = activeTool === "room-relations";
  const isZonesMode = activeTool === "presence-zones";

  // Room polygon geometry — before any conditional return.
  const roomPolygons = useMemo(() => {
    return floor.rooms.map((room, i) => {
      if (!room.points || room.points.length < 3) return null;
      const pts = room.points
        .map(([x, y]) => `${tx(transform, x)},${ty(transform, y)}`)
        .join(" ");
      const [cx, cy] = polygonCentroid(room.points);
      return { room, idx: i, pts, sx: tx(transform, cx), sy: ty(transform, cy) };
    });
  }, [floor.rooms, transform]);

  // Zone membership lookup — unconditional for stable hook order.
  const roomZoneMap = useMemo(() => {
    const m = new Map<string, number>();
    zones.draftZones.forEach((z, i) => {
      for (const r of z.rooms) { if (!m.has(r)) m.set(r, i); }
    });
    return m;
  }, [zones.draftZones]);

  // floor_area group → colour (by first-seen order).
  const groupColorMap = useMemo(() => {
    const m = new Map<string, string>();
    let n = 0;
    for (const room of floor.rooms) {
      if (room.floor_area && !m.has(room.floor_area))
        m.set(room.floor_area, GROUP_COLORS[n++ % GROUP_COLORS.length]);
    }
    return m;
  }, [floor.rooms]);

  // Raster boundary per floor_area group, as SVG point-string arrays.
  // Each group may produce more than one closed polygon (e.g. if two sub-sets
  // of group rooms are not physically adjacent).
  const groupBoundaries = useMemo(() => {
    const groupRooms = new Map<string, typeof floor.rooms>();
    for (const room of floor.rooms) {
      if (!room.floor_area || !room.points || room.points.length < 3) continue;
      const arr = groupRooms.get(room.floor_area) ?? [];
      arr.push(room);
      groupRooms.set(room.floor_area, arr);
    }

    return [...groupRooms.entries()].map(([tag, rooms]) => {
      const polys = rasterBoundary(rooms as RoomLike[]);
      const color = groupColorMap.get(tag) ?? GROUP_COLORS[0];
      return {
        tag,
        color,
        svgPolys: polys.map((poly) =>
          poly.map(([x, y]) => `${tx(transform, x)},${ty(transform, y)}`).join(" "),
        ),
      };
    });
  }, [floor.rooms, groupColorMap, transform]);

  // Door placement — hover snaps a preview dot to the cursor position on the edge.
  const [hoverSnap, setHoverSnap] = useState<{ svgX: number; svgY: number } | null>(null);

  const handleEdgeMouseMove = useCallback(
    (
      e: React.MouseEvent<SVGLineElement>,
      sx1: number, sy1: number,
      sx2: number, sy2: number,
    ) => {
      const svg = (e.currentTarget as SVGElement).ownerSVGElement;
      if (!svg) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const { x, y } = pt.matrixTransform(ctm.inverse());
      const dx = sx2 - sx1, dy = sy2 - sy1;
      const len2 = dx * dx + dy * dy;
      let svgX: number, svgY: number;
      if (len2 < 1e-12) {
        svgX = sx1; svgY = sy1;
      } else {
        const t = Math.max(0, Math.min(1, ((x - sx1) * dx + (y - sy1) * dy) / len2));
        svgX = sx1 + t * dx; svgY = sy1 + t * dy;
      }
      setHoverSnap({ svgX, svgY });
    },
    [],
  );

  const handleEdgeMouseLeave = useCallback(() => setHoverSnap(null), []);

  // Click on a specific wall edge: snap to nearest point on that edge in config space.
  const handleEdgeClick = useCallback(
    (
      e: React.MouseEvent<SVGLineElement>,
      ax: number, ay: number,  // config-space edge endpoints
      bx: number, by: number,
    ) => {
      e.stopPropagation();
      const rid = relations.doorPlacingForRoom;
      if (!rid) return;
      const svg = (e.currentTarget as SVGElement).ownerSVGElement;
      if (!svg) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const svgPt = pt.matrixTransform(ctm.inverse());
      const clickX = txInv(transform, svgPt.x);
      const clickY = tyInv(transform, svgPt.y);
      const edgeDx = bx - ax, edgeDy = by - ay;
      const len2 = edgeDx * edgeDx + edgeDy * edgeDy;
      let sx: number, sy: number;
      if (len2 < 1e-12) { sx = ax; sy = ay; }
      else {
        const t = Math.max(0, Math.min(1, ((clickX - ax) * edgeDx + (clickY - ay) * edgeDy) / len2));
        sx = ax + t * edgeDx; sy = ay + t * edgeDy;
      }
      setHoverSnap(null);
      relations.setDoor(rid, [sx, sy]);
    },
    [relations, transform],
  );

  if (!isRelationsMode && !isZonesMode) return null;

  const selectedZoneIdx = isZonesMode
    ? zones.draftZones.findIndex((z) => z.id === zones.selectedZoneId)
    : -1;
  const selectedZone = selectedZoneIdx >= 0 ? zones.draftZones[selectedZoneIdx] : null;

  const selectedEntry =
    isRelationsMode && relations.editingRoomId
      ? (roomPolygons.find((e) => e?.room.id === relations.editingRoomId) ?? null)
      : null;

  const activeDraftGroup = relations.draftFloorArea.trim();

  return (
    <>
      {isRelationsMode && (
        <defs>
          <marker
            id={MARKER_ID}
            markerUnits="strokeWidth"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill={ARROW_COLOR} />
          </marker>
        </defs>
      )}

      <g className="room-overlay" style={{ cursor: isRelationsMode || isZonesMode ? "pointer" : "default" }}>

        {/* ── Floor-area group boundaries (relations mode only) ─────────────── */}
        {isRelationsMode && (
          <g style={{ pointerEvents: "none" }}>
            {groupBoundaries.map(({ tag, color, svgPolys }) => {
              const isActiveGroup = activeDraftGroup !== "" && tag === activeDraftGroup;
              return svgPolys.map((pts, i) => (
                <polygon
                  key={`boundary-${tag}-${i}`}
                  points={pts}
                  fill={isActiveGroup ? color : "none"}
                  fillOpacity={isActiveGroup ? 0.12 : 0}
                  stroke={color}
                  strokeWidth={0.07}
                  strokeDasharray="0.18 0.1"
                  strokeLinejoin="round"
                />
              ));
            })}
          </g>
        )}

        {/* ── Room hit-area / fill overlays ────────────────────────────────── */}
        {roomPolygons.map((entry) => {
          if (!entry) return null;
          const { room, idx, pts } = entry;
          const rid = room.id;
          if (!rid) return null;

          let fill = "transparent";
          let fillOpacity = 0;
          let stroke = "transparent";
          let strokeWidth = 0;

          if (isRelationsMode) {
            const isSelected = rid === relations.editingRoomId;
            if (isSelected) {
              fill = "#3b82f6";
              fillOpacity = 0.4;
              stroke = "#1d4ed8";
              strokeWidth = 0.06;
            } else {
              fill = "#6b7280";
              fillOpacity = relations.editingRoomId ? 0.08 : 0;
            }
          } else if (isZonesMode) {
            const isInSelectedZone = selectedZone?.rooms.includes(rid) ?? false;
            const zoneIdx = roomZoneMap.get(rid);
            if (isInSelectedZone) {
              const color = ZONE_COLORS[selectedZoneIdx % ZONE_COLORS.length];
              fill = color; fillOpacity = 0.5;
              stroke = color; strokeWidth = 0.06;
            } else if (zoneIdx !== undefined) {
              fill = ZONE_COLORS[zoneIdx % ZONE_COLORS.length];
              fillOpacity = 0.15;
            } else {
              fill = "#6b7280"; fillOpacity = 0.08;
            }
          }

          const handleClick = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (isRelationsMode) {
              if (!relations.editingRoomId) {
                relations.startEditing(floor.id ?? "", room, floor.rooms);
              } else if (rid === relations.editingRoomId) {
                relations.cancel();
              } else {
                relations.toggleOpenTo(rid);
              }
            } else if (isZonesMode && zones.selectedZoneId) {
              zones.toggleRoom(rid);
            }
          };

          return (
            <polygon
              key={`room-overlay-${room.id ?? idx}`}
              points={pts}
              fill={fill}
              fillOpacity={fillOpacity}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinejoin="round"
              onClick={handleClick}
            >
              <title>
                {room.name ?? room.id}
                {room.floor_area ? ` · group: ${room.floor_area}` : ""}
              </title>
            </polygon>
          );
        })}

        {/* ── Connection indicators ─────────────────────────────────────────── */}
        {/* Without a door: centroid→centroid arrow.
            With a door: classic architectural door swing arc (leaf + quarter-circle). */}
        {isRelationsMode &&
          selectedEntry &&
          relations.draftOpenTo.map((connId) => {
            const connEntry = roomPolygons.find((e) => e?.room.id === connId);
            if (!connEntry) return null;
            const door = relations.draftDoors[connId];

            if (door && selectedEntry.room.points) {
              const [doorX, doorY] = door;
              const doorWidth = relations.draftWidths[connId] ?? DEFAULT_DOOR_WIDTH;
              // Swing arc stays door-scale even for wide openings. A 2.4 m
              // sliding door shouldn't render with a 2.4 m-radius arc — the
              // arc is a conventional "door symbol," not to-scale geometry.
              // The leaf line still spans the full `doorWidth` so the opening
              // size is visible; the arc sits at one end of the leaf, radius
              // capped at DEFAULT_DOOR_WIDTH.
              const arcRadius = Math.min(doorWidth, DEFAULT_DOOR_WIDTH);
              const connCentroid = connEntry.room.points
                ? polygonCentroid(connEntry.room.points)
                : null;
              const edgeInfo = connCentroid
                ? wallEdgeInfoAt(doorX, doorY, selectedEntry.room.points, connCentroid[0], connCentroid[1])
                : null;

              if (edgeInfo) {
                const sx = tx(transform, doorX);
                const sy = ty(transform, doorY);
                // Adjust normal and tangent for SVG axis flips.
                const snx = transform.flipX ? -edgeInfo.nx : edgeInfo.nx;
                const sny = transform.flipY ? -edgeInfo.ny : edgeInfo.ny;
                const stx = transform.flipX ? -edgeInfo.tanX : edgeInfo.tanX;
                const sty = transform.flipY ? -edgeInfo.tanY : edgeInfo.tanY;

                const halfW = doorWidth / 2;
                // Leaf endpoints. "leafStart" and "leafEnd" are just the two
                // wall-aligned corners of the leaf; which one acts as the
                // arc's visual hinge is a style choice (see below).
                const leafStartX = sx - stx * halfW;
                const leafStartY = sy - sty * halfW;
                const leafEndX = sx + stx * halfW;
                const leafEndY = sy + sty * halfW;
                // Arc hinge sits at the FAR end of the leaf (leafEnd). For
                // a standard-width door this just corresponds to the usual
                // "hinge corner" convention; for wide openings it visually
                // anchors the swing arc at the far end instead of the near
                // end, which reads more naturally because the arc then
                // follows the outer edge of the opening instead of
                // bisecting the middle of a wide leaf.
                const hingeX = leafEndX;
                const hingeY = leafEndY;
                // From the hinge, the leaf extends back toward leafStart
                // (negative tangent direction). The arc starts `arcRadius`
                // along that direction.
                const inwardTanX = -stx;
                const inwardTanY = -sty;
                const arcStartX = hingeX + inwardTanX * arcRadius;
                const arcStartY = hingeY + inwardTanY * arcRadius;
                // Open tip: hinge offset outward into the connected room by
                // arcRadius. Matches the arc radius so the quarter-circle
                // closes cleanly.
                const openTipX = hingeX + snx * arcRadius;
                const openTipY = hingeY + sny * arcRadius;

                // Sweep: cross of (arcStart−hinge) × (openTip−hinge) in SVG
                // space. Positive → clockwise in screen coords → sweep=1.
                // Using inwardTan instead of stx/sty flips the sign vs. the
                // original hinge-at-leafStart formulation.
                const sweep = (inwardTanY * snx - inwardTanX * sny) >= 0 ? 0 : 1;

                const f = (v: number) => v.toFixed(4);
                return (
                  <g key={`conn-${connId}`} style={{ pointerEvents: "none" }}>
                    {/* Door leaf line — spans the full opening width */}
                    <line
                      x1={leafStartX} y1={leafStartY}
                      x2={leafEndX} y2={leafEndY}
                      stroke={ARROW_COLOR}
                      strokeWidth={DOOR_STROKE_W}
                      strokeLinecap="round"
                    />
                    {/* Door swing arc — door-scale radius regardless of opening width */}
                    <path
                      d={`M ${f(arcStartX)} ${f(arcStartY)} A ${arcRadius} ${arcRadius} 0 0 ${sweep} ${f(openTipX)} ${f(openTipY)}`}
                      fill="none"
                      stroke={ARROW_COLOR}
                      strokeWidth={DOOR_STROKE_W * 0.65}
                      strokeLinecap="round"
                      strokeDasharray={`${(arcRadius * 0.14).toFixed(3)} ${(arcRadius * 0.09).toFixed(3)}`}
                    />
                  </g>
                );
              }
            }

            // Fallback: centroid-to-centroid arrow
            return (
              <line
                key={`conn-${connId}`}
                x1={selectedEntry.sx}
                y1={selectedEntry.sy}
                x2={connEntry.sx}
                y2={connEntry.sy}
                stroke={ARROW_COLOR}
                strokeWidth={ARROW_STROKE}
                strokeLinecap="round"
                markerEnd={`url(#${MARKER_ID})`}
                style={{ pointerEvents: "none" }}
              />
            );
          })}

        {/* ── Door placement edge picker — wall-pick lines on the editing room,
             rendered last so they sit on top and capture hover/click. */}
        {isRelationsMode && relations.doorPlacingForRoom && selectedEntry?.room.points &&
          (() => {
            const pts = selectedEntry.room.points!;
            const n = pts.length;
            return pts.map((_, i) => {
              const a = pts[i];
              const b = pts[(i + 1) % n];
              const sx1 = tx(transform, a[0]), sy1 = ty(transform, a[1]);
              const sx2 = tx(transform, b[0]), sy2 = ty(transform, b[1]);
              return (
                <line
                  key={`door-pick-${i}`}
                  x1={sx1} y1={sy1} x2={sx2} y2={sy2}
                  className="wall-pick"
                  onClick={(e) => handleEdgeClick(e, a[0], a[1], b[0], b[1])}
                  onMouseMove={(e) => handleEdgeMouseMove(e, sx1, sy1, sx2, sy2)}
                  onMouseLeave={handleEdgeMouseLeave}
                />
              );
            });
          })()
        }

        {/* Snap preview dot — follows cursor along the hovered wall edge */}
        {isRelationsMode && hoverSnap && (
          <circle
            cx={hoverSnap.svgX}
            cy={hoverSnap.svgY}
            r={0.12}
            className="corner-pick"
            style={{ pointerEvents: "none" }}
          />
        )}
      </g>
    </>
  );
}
