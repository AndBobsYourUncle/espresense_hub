"use client";

import { useCallback, useMemo } from "react";
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

const DOOR_ARROW_ID = "door-perp-arrow";
const DOOR_HALF_LEN = 0.22; // half-length of the perpendicular arrow shaft, metres
const DOOR_STROKE = 0.04;   // stroke width of the arrow shaft

/**
 * Snap `(clickX, clickY)` (config-space metres) onto the nearest edge of a
 * polygon boundary. Returns the snapped point and the outward unit normal of
 * that edge, oriented toward `(facingX, facingY)`.
 */
function snapToPolygonEdge(
  clickX: number,
  clickY: number,
  points: readonly (readonly number[])[],
  facingX: number,
  facingY: number,
): { snapped: [number, number]; nx: number; ny: number } | null {
  const n = points.length;
  if (n < 2) return null;

  let bestDist = Infinity;
  let bestResult: { snapped: [number, number]; nx: number; ny: number } | null = null;

  for (let i = 0; i < n; i++) {
    const ax = points[i][0], ay = points[i][1];
    const bx = points[(i + 1) % n][0], by = points[(i + 1) % n][1];
    const edgeDx = bx - ax, edgeDy = by - ay;
    const len2 = edgeDx * edgeDx + edgeDy * edgeDy;

    let sx: number, sy: number;
    if (len2 < 1e-12) {
      sx = ax; sy = ay;
    } else {
      const t = Math.max(0, Math.min(1, ((clickX - ax) * edgeDx + (clickY - ay) * edgeDy) / len2));
      sx = ax + t * edgeDx;
      sy = ay + t * edgeDy;
    }

    const dist = Math.hypot(clickX - sx, clickY - sy);
    if (dist < bestDist) {
      bestDist = dist;
      // Unit normal, oriented toward `facing`
      const edgeLen = Math.sqrt(len2) || 1;
      const px = edgeDy / edgeLen, py = -edgeDx / edgeLen;
      const dot = px * (facingX - sx) + py * (facingY - sy);
      bestResult = {
        snapped: [sx, sy],
        nx: dot >= 0 ? px : -px,
        ny: dot >= 0 ? py : -py,
      };
    }
  }

  return bestResult;
}

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

  // Door placement: click on the editing room's boundary polygon → snap to the
  // nearest edge and record the door position in config-space metres.
  const handleWallClick = useCallback(
    (e: React.MouseEvent<SVGPolygonElement>) => {
      e.stopPropagation();
      const rid = relations.doorPlacingForRoom;
      const editingId = relations.editingRoomId;
      if (!rid || !editingId) return;

      const editingRoom = floor.rooms.find((r) => r.id === editingId);
      if (!editingRoom?.points || editingRoom.points.length < 3) return;

      const svg = (e.currentTarget as SVGElement).ownerSVGElement;
      if (!svg) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const svgPt = pt.matrixTransform(ctm.inverse());
      const clickX = txInv(transform, svgPt.x);
      const clickY = tyInv(transform, svgPt.y);

      // Use the connected room's centroid to orient the wall normal.
      const connRoom = floor.rooms.find((r) => r.id === rid);
      const [facingX, facingY] =
        connRoom?.points && connRoom.points.length >= 3
          ? polygonCentroid(connRoom.points)
          : [clickX, clickY];

      const result = snapToPolygonEdge(clickX, clickY, editingRoom.points, facingX, facingY);
      if (!result) return;
      relations.setDoor(rid, result.snapped);
    },
    [relations, transform, floor.rooms],
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
          {/* Connection arrow (room→room lines) */}
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
          {/* Door perpendicular arrow — auto-start-reverse makes it
              point outward at both ends of the shaft. */}
          <marker
            id={DOOR_ARROW_ID}
            markerUnits="strokeWidth"
            markerWidth="5"
            markerHeight="4"
            refX="5"
            refY="2"
            orient="auto-start-reverse"
          >
            <polygon points="0 0, 5 2, 0 4" fill="#0ea5e9" />
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

        {/* ── Connection arrows ─────────────────────────────────────────────── */}
        {isRelationsMode &&
          selectedEntry &&
          relations.draftOpenTo.map((connId) => {
            const connEntry = roomPolygons.find((e) => e?.room.id === connId);
            if (!connEntry) return null;
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

        {/* ── Door markers — perpendicular arrows on the wall ─────────────── */}
        {isRelationsMode &&
          selectedEntry &&
          Object.entries(relations.draftDoors).map(([rid, [doorX, doorY]]) => {
            const connRoom = floor.rooms.find((r) => r.id === rid);
            if (!connRoom?.points || connRoom.points.length < 3) return null;
            const [connCx, connCy] = polygonCentroid(connRoom.points);

            // Find which wall edge the door sits on and its outward normal.
            const edgeResult = selectedEntry.room.points
              ? snapToPolygonEdge(doorX, doorY, selectedEntry.room.points, connCx, connCy)
              : null;
            if (!edgeResult) return null;

            const { nx, ny } = edgeResult;
            const sx = tx(transform, doorX);
            const sy = ty(transform, doorY);

            // Transform the config-space unit normal to SVG space.
            const svgNx = transform.flipX ? -nx : nx;
            const svgNy = transform.flipY ? -ny : ny;
            const L = DOOR_HALF_LEN;

            return (
              <g key={`door-${rid}`} style={{ pointerEvents: "none" }}>
                <line
                  x1={sx - svgNx * L} y1={sy - svgNy * L}
                  x2={sx + svgNx * L} y2={sy + svgNy * L}
                  stroke="#0ea5e9"
                  strokeWidth={DOOR_STROKE}
                  strokeLinecap="round"
                  markerStart={`url(#${DOOR_ARROW_ID})`}
                  markerEnd={`url(#${DOOR_ARROW_ID})`}
                />
              </g>
            );
          })}

        {/* ── Door placement click target — rendered LAST so it sits on top.
             Visible dashed highlight + thick invisible stroke for easy clicking. */}
        {isRelationsMode && relations.doorPlacingForRoom && selectedEntry && (
          <>
            {/* Visible dashed cyan outline on the editing room boundary */}
            <polygon
              points={selectedEntry.pts}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={0.05}
              strokeDasharray="0.15 0.09"
              strokeLinejoin="round"
              style={{ pointerEvents: "none" }}
            />
            {/* Thick invisible click zone — pointer-events on the stroke only */}
            <polygon
              points={selectedEntry.pts}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={0.4}
              strokeOpacity={0}
              strokeLinejoin="round"
              style={{ cursor: "crosshair", pointerEvents: "stroke" }}
              onClick={handleWallClick}
            />
          </>
        )}
      </g>
    </>
  );
}
