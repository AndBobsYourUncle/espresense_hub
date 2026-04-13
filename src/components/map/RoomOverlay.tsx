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

// ─── Point-in-polygon (ray casting) ─────────────────────────────────────────

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

  // Outer boundary edges per floor_area group — edges whose midpoint does not
  // lie inside any sibling room (i.e. they face outward).
  const groupOuterEdges = useMemo(() => {
    const groupRooms = new Map<string, typeof floor.rooms>();
    for (const room of floor.rooms) {
      if (!room.floor_area || !room.points || room.points.length < 3) continue;
      const arr = groupRooms.get(room.floor_area) ?? [];
      arr.push(room);
      groupRooms.set(room.floor_area, arr);
    }

    return [...groupRooms.entries()].map(([tag, rooms]) => {
      const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
      for (const room of rooms) {
        const pts = room.points!;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2;
          // If the midpoint falls inside any sibling room, this is an interior edge.
          const interior = rooms.some(
            (other) => other !== room && other.points != null && pointInPolygon(mx, my, other.points),
          );
          if (!interior) {
            edges.push({
              x1: tx(transform, a[0]),
              y1: ty(transform, a[1]),
              x2: tx(transform, b[0]),
              y2: ty(transform, b[1]),
            });
          }
        }
      }
      return { tag, color: groupColorMap.get(tag) ?? GROUP_COLORS[0], edges };
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

        {/* ── Floor-area group outer edges (relations mode only) ───────────── */}
        {isRelationsMode && (
          <g style={{ pointerEvents: "none" }}>
            {groupOuterEdges.map(({ tag, color, edges }) => {
              const isActiveGroup = activeDraftGroup !== "" && tag === activeDraftGroup;
              return edges.map(({ x1, y1, x2, y2 }, i) => (
                <line
                  key={`outer-${tag}-${i}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={color}
                  strokeWidth={0.07}
                  strokeDasharray="0.18 0.1"
                  strokeLinecap="round"
                  opacity={isActiveGroup ? 1 : 0.6}
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
      </g>
    </>
  );
}
