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

const ARROW_COLOR = "#14b8a6"; // teal-500
const ARROW_STROKE = 0.05;
const MARKER_ID = "room-conn-arrow";

/**
 * SVG overlay rendered inside FloorPlan that activates in two modes:
 *
 *  - `room-relations` tool: highlights the selected room (blue) and draws
 *    arrows from its centroid to each connected room's centroid. Other rooms
 *    get a faint tint so they read as clickable.
 *
 *  - `presence-zones` tool: colors rooms by zone membership and makes rooms
 *    clickable to toggle their membership in the selected zone.
 *
 * Hidden when neither tool is active.
 */
export default function RoomOverlay({ floor, transform }: Props) {
  const { activeTool } = useMapTool();
  const relations = useRoomRelations();
  const zones = usePresenceZones();

  const isRelationsMode = activeTool === "room-relations";
  const isZonesMode = activeTool === "presence-zones";

  // Pre-compute polygon geometry — must be before any conditional return.
  const roomPolygons = useMemo(() => {
    return floor.rooms.map((room, i) => {
      if (!room.points || room.points.length < 3) return null;
      const pts = room.points
        .map(([x, y]) => `${tx(transform, x)},${ty(transform, y)}`)
        .join(" ");
      const [cx, cy] = polygonCentroid(room.points);
      return {
        room,
        idx: i,
        pts,
        sx: tx(transform, cx),
        sy: ty(transform, cy),
      };
    });
  }, [floor.rooms, transform]);

  // Zone membership lookup — computed unconditionally for stable hook order.
  const roomZoneMap = useMemo(() => {
    const m = new Map<string, number>();
    zones.draftZones.forEach((z, i) => {
      for (const r of z.rooms) {
        if (!m.has(r)) m.set(r, i);
      }
    });
    return m;
  }, [zones.draftZones]);

  if (!isRelationsMode && !isZonesMode) return null;

  const selectedZoneIdx = isZonesMode
    ? zones.draftZones.findIndex((z) => z.id === zones.selectedZoneId)
    : -1;
  const selectedZone = selectedZoneIdx >= 0 ? zones.draftZones[selectedZoneIdx] : null;

  // Find the selected room's centroid for arrow origins.
  const selectedEntry = isRelationsMode && relations.editingRoomId
    ? roomPolygons.find((e) => e?.room.id === relations.editingRoomId) ?? null
    : null;

  return (
    <>
      {/* Arrowhead marker for room-relations mode */}
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

      <g className="room-overlay" style={{ cursor: "pointer" }}>
        {/* Room hit-area / fill overlays */}
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
              fill = "#3b82f6"; // blue-500
              fillOpacity = 0.4;
              stroke = "#1d4ed8";
              strokeWidth = 0.06;
            } else {
              // Subtle tint so the user can see every room is clickable.
              fill = "#6b7280";
              fillOpacity = relations.editingRoomId ? 0.08 : 0;
            }
          } else if (isZonesMode) {
            const isInSelectedZone = selectedZone?.rooms.includes(rid) ?? false;
            const zoneIdx = roomZoneMap.get(rid);

            if (isInSelectedZone) {
              const color = ZONE_COLORS[selectedZoneIdx % ZONE_COLORS.length];
              fill = color;
              fillOpacity = 0.5;
              stroke = color;
              strokeWidth = 0.06;
            } else if (zoneIdx !== undefined) {
              fill = ZONE_COLORS[zoneIdx % ZONE_COLORS.length];
              fillOpacity = 0.15;
            } else {
              fill = "#6b7280";
              fillOpacity = 0.08;
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
              <title>{room.name ?? room.id}</title>
            </polygon>
          );
        })}

        {/* Connection arrows — room-relations mode only */}
        {isRelationsMode && selectedEntry && relations.draftOpenTo.map((connId) => {
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
