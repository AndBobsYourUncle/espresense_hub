"use client";

import { useMemo } from "react";
import type { Floor } from "@/lib/config";
import { polygonCentroid, tx, ty, type FloorTransform } from "@/lib/map/geometry";
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

const GROUP_COLORS = [
  "#f59e0b", // amber-500
  "#ec4899", // pink-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
  "#a78bfa", // violet-400
  "#fb7185", // rose-400
];

// ─── Geometry helpers ────────────────────────────────────────────────────────

function cross(
  O: readonly [number, number],
  A: readonly [number, number],
  B: readonly [number, number],
): number {
  return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
}

function ptDist(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
}

function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts.slice();
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Concave hull via iterative vertex insertion.
 *
 * Starts from the convex hull, then for every edge longer than `maxEdge`
 * finds the nearest pool vertex that (a) is on the interior side of that
 * edge and (b) produces two sub-edges both shorter than the original edge,
 * inserts it, and repeats until the shape settles.
 *
 * "Interior side" is determined by comparing sign against the hull centroid,
 * making the algorithm winding-order agnostic.
 */
function concaveHull(points: [number, number][], maxEdge: number): [number, number][] {
  if (points.length < 3) return points.slice();

  // Deduplicate input to avoid inserting the same coordinate twice.
  const seen = new Set<string>();
  const unique: [number, number][] = [];
  for (const p of points) {
    const k = `${p[0]}_${p[1]}`;
    if (!seen.has(k)) { seen.add(k); unique.push(p); }
  }
  if (unique.length < 3) return unique;

  const hull = convexHull(unique);
  const inHull = new Set(hull.map(p => `${p[0]}_${p[1]}`));
  const pool = unique.filter(p => !inHull.has(`${p[0]}_${p[1]}`));

  let changed = true;
  while (changed && pool.length > 0) {
    changed = false;

    // Centroid of the current hull used to determine which side is interior.
    const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
    const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
    const cen: [number, number] = [cx, cy];

    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const ab = ptDist(a, b);
      if (ab <= maxEdge) continue;

      const interiorSign = Math.sign(cross(a, b, cen));

      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const p of pool) {
        // Skip points already absorbed into the hull (shouldn't happen, but safe).
        if (inHull.has(`${p[0]}_${p[1]}`)) continue;
        // Must be on the interior side of edge a→b.
        if (interiorSign !== 0 && Math.sign(cross(a, b, p)) !== interiorSign) continue;
        // Both sub-edges must be shorter than the original (prevents outward bowing).
        if (ptDist(a, p) >= ab || ptDist(p, b) >= ab) continue;
        // Prefer the point nearest the midpoint of the edge.
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const d = Math.sqrt((p[0] - mx) ** 2 + (p[1] - my) ** 2);
        if (d < bestD) { bestD = d; best = p; }
      }

      if (best) {
        hull.splice(i + 1, 0, best);
        pool.splice(pool.indexOf(best), 1);
        inHull.add(`${best[0]}_${best[1]}`);
        changed = true;
        break; // restart so centroid is recomputed
      }
    }
  }

  return hull;
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

  // Concave hull per floor_area group, in SVG coordinates.
  // Collects all room polygon vertices for the group, deduplicates them, then
  // shrink-wraps them to a tight boundary that follows the actual room shapes.
  const groupHulls = useMemo(() => {
    const groupRooms = new Map<string, typeof floor.rooms>();
    for (const room of floor.rooms) {
      if (!room.floor_area || !room.points || room.points.length < 3) continue;
      const arr = groupRooms.get(room.floor_area) ?? [];
      arr.push(room);
      groupRooms.set(room.floor_area, arr);
    }

    return [...groupRooms.entries()].map(([tag, rooms]) => {
      const all: [number, number][] = [];
      for (const room of rooms) {
        for (const p of room.points!) all.push([p[0], p[1]]);
      }

      // maxEdge 1.5 m — edges shorter than this won't be subdivided, so the
      // hull bridges small gaps while still capturing room-scale concavities.
      const hull = concaveHull(all, 1.5);
      const svgPts = hull
        .map(([x, y]) => `${tx(transform, x)},${ty(transform, y)}`)
        .join(" ");
      return { tag, svgPts, color: groupColorMap.get(tag) ?? GROUP_COLORS[0] };
    });
  }, [floor.rooms, groupColorMap, transform]);

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

        {/* ── Floor-area group hulls (relations mode only) ─────────────────── */}
        {isRelationsMode && (
          <g style={{ pointerEvents: "none" }}>
            {groupHulls.map(({ tag, svgPts, color }) => {
              const isActiveGroup = activeDraftGroup !== "" && tag === activeDraftGroup;
              return (
                <polygon
                  key={`hull-${tag}`}
                  points={svgPts}
                  fill={isActiveGroup ? color : "none"}
                  fillOpacity={isActiveGroup ? 0.12 : 0}
                  stroke={color}
                  strokeWidth={0.07}
                  strokeDasharray="0.18 0.1"
                  strokeLinejoin="round"
                />
              );
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
      </g>
    </>
  );
}
