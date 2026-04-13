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

/**
 * SVG overlay rendered inside FloorPlan that activates in two modes:
 *
 *  - `room-relations` tool: highlights the selected room (blue), connected
 *    rooms (teal), and makes all rooms clickable to toggle connections.
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

  // Pre-compute SVG polygon points strings — stable references via useMemo.
  // Must be called before any conditional return to satisfy rules-of-hooks.
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

  // Build a zone-membership lookup: roomId → zoneIdx (first zone wins).
  // Computed unconditionally so hook order is stable across renders.
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

  return (
    <g className="room-overlay" style={{ cursor: "pointer" }}>
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
          const isEditingRoom = rid === relations.editingRoomId;
          const isConnected = relations.draftOpenTo.includes(rid);

          if (isEditingRoom) {
            fill = "#3b82f6"; // blue-500
            fillOpacity = 0.45;
            stroke = "#1d4ed8"; // blue-700
            strokeWidth = 0.06;
          } else if (isConnected) {
            fill = "#14b8a6"; // teal-500
            fillOpacity = 0.35;
            stroke = "#0f766e"; // teal-700
            strokeWidth = 0.05;
          } else {
            fill = relations.editingRoomId ? "#6b7280" : "transparent";
            fillOpacity = relations.editingRoomId ? 0.1 : 0;
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
    </g>
  );
}
