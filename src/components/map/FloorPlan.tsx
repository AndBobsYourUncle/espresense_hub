"use client";

import { useMemo } from "react";
import type { Config, Floor } from "@/lib/config";
import {
  computeFloorBounds,
  fitLabelSize,
  nodesForFloor,
  polygonCentroid,
  tx as txFn,
  ty as tyFn,
  type FloorTransform,
} from "@/lib/map/geometry";
import DeviceDebugOverlay from "./DeviceDebugOverlay";
import DeviceMarkers from "./DeviceMarkers";
import NodeDebugOverlay from "./NodeDebugOverlay";
import NodeMarkers, { type NodeMarkerData } from "./NodeMarkers";
import PinOverlay from "./PinOverlay";
import RfPropagationOverlay from "./RfPropagationOverlay";
import RoomOverlay from "./RoomOverlay";
import WallSelectionOverlay from "./WallSelectionOverlay";
import { useMapViewport } from "./useMapViewport";
import ViewportControls from "./ViewportControls";

// Soft Tailwind-200 style palette. Cycled by room index so colors stay stable
// across renders. Upstream uses an adjacency-aware algorithm; if two adjacent
// rooms clash, users can override by setting `color` explicitly in config.
const PALETTE = [
  "#bfdbfe", // blue-200
  "#bbf7d0", // green-200
  "#fde68a", // amber-200
  "#fbcfe8", // pink-200
  "#ddd6fe", // violet-200
  "#a5f3fc", // cyan-200
  "#fed7aa", // orange-200
  "#d9f99d", // lime-200
  "#e9d5ff", // purple-200
  "#fecaca", // red-200
  "#99f6e4", // teal-200
  "#f5d0fe", // fuchsia-200
];

interface Props {
  config: Config;
  floor: Floor;
}

export default function FloorPlan({ config, floor }: Props) {
  const bounds = computeFloorBounds(floor, config.nodes);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  const transform: FloorTransform = {
    bounds,
    flipX: config.map.flip_x,
    flipY: config.map.flip_y,
  };
  const tx = (x: number): number => txFn(transform, x);
  const ty = (y: number): number => tyFn(transform, y);

  const pad = Math.max(width, height) * 0.04;
  const baseViewBox = useMemo(
    () => ({
      x: -pad,
      y: -pad,
      w: width + 2 * pad,
      h: height + 2 * pad,
    }),
    [pad, width, height],
  );
  const viewport = useMapViewport({ baseViewBox });

  // Filter to nodes on this floor and narrow to NodeMarkerData (point required).
  const floorNodes: NodeMarkerData[] = nodesForFloor(
    config.nodes,
    floor.id,
  ).map((n) => ({ id: n.id, name: n.name, point: n.point! }));

  const wallColor = config.map.wall_color ?? "#6b7280";
  const wallOpacity = config.map.wall_opacity ?? 0.35;
  const wallStroke = Math.max(config.map.wall_thickness, 0.04);

  return (
    <>
    <svg
      ref={viewport.svgRef}
      viewBox={viewport.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-full touch-none select-none"
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={viewport.handlePointerDown}
      onPointerMove={viewport.handlePointerMove}
      onPointerUp={viewport.handlePointerUp}
      onPointerCancel={viewport.handlePointerUp}
      onClick={(e) => {
        // Suppress the click that immediately follows a pan/zoom — the
        // gesture would otherwise also trigger the parent MapStage's
        // background-deselect handler. Reset the flag for next time.
        if (viewport.didPanRef.current) {
          e.stopPropagation();
          viewport.didPanRef.current = false;
        }
      }}
    >
      {/* Rooms */}
      <g>
        {floor.rooms.map((room, i) => {
          if (!room.points || room.points.length < 3) return null;
          const color = room.color ?? PALETTE[i % PALETTE.length];
          const pts = room.points
            .map(([x, y]) => `${tx(x)},${ty(y)}`)
            .join(" ");
          return (
            <polygon
              key={`room-${room.id ?? i}`}
              points={pts}
              fill={color}
              stroke={wallColor}
              strokeOpacity={wallOpacity}
              strokeWidth={wallStroke}
              strokeLinejoin="round"
              strokeLinecap="round"
              className="fp-room"
            >
              <title>{room.name ?? room.id}</title>
            </polygon>
          );
        })}
      </g>

      {/* Room labels — auto-sized; skip rooms that can't fit even a minimum
          label. Hover tooltip on the polygon still surfaces the name. */}
      <g className="pointer-events-none select-none">
        {floor.rooms.map((room, i) => {
          if (!room.points || room.points.length < 3) return null;
          const name = room.name ?? room.id;
          if (!name) return null;
          const fontSize = fitLabelSize(name, room.points);
          if (fontSize == null) return null;
          const [cx, cy] = polygonCentroid(room.points);
          return (
            <text
              key={`label-${room.id ?? i}`}
              x={tx(cx)}
              y={ty(cy)}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={fontSize}
              fontWeight={500}
              fill="#1f2937"
              className="fp-room-label"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {name}
            </text>
          );
        })}
      </g>

      {/* RF propagation heatmap — sits under the room overlay so room
          outlines + labels render on top of the heatmap. Only visible
          when the rf-propagation tool is active and a node is selected. */}
      <RfPropagationOverlay
        floor={floor}
        transform={transform}
        nodes={config.nodes
          .filter(
            (n): n is typeof n & { id: string; point: readonly [number, number, number] } =>
              Boolean(n.id && n.point),
          )
          .map((n) => ({ id: n.id, point: n.point, room: n.room }))}
        rfParams={{
          referenceRssi1m: config.rf.reference_rssi_1m,
          pathLossExponent: config.rf.path_loss_exponent,
          wallAttenuationDb: config.rf.wall_attenuation_db,
          exteriorWallAttenuationDb: config.rf.exterior_wall_attenuation_db,
          doorAttenuationDb: config.rf.door_attenuation_db,
        }}
      />

      {/* Room overlay — activates in room-relations and presence-zones modes */}
      <RoomOverlay floor={floor} transform={transform} />

      {/* Wall picker — only renders during node-editor wall placement */}
      <WallSelectionOverlay floor={floor} transform={transform} />

      {/* Configured nodes — clickable for ruler measurements */}
      <NodeMarkers nodes={floorNodes} transform={transform} />

      {/* Live device markers — client component, polls /api/devices/positions
          and re-renders as positions update. */}
      <DeviceMarkers
        transform={transform}
        staleAfterMs={config.timeout * 1000}
      />

      {/* Pin overlay — renders placed pins + intercepts clicks in pin mode. */}
      <PinOverlay transform={transform} />

      {/* Debug overlay — visible only when a device is selected. Draws each
          reporting node's measured-distance circle so geometric inconsistencies
          are visually obvious. */}
      <DeviceDebugOverlay transform={transform} />

      {/* Same idea but for nodes: when a single node is selected in the
          ruler, draws each *other* node's measured-distance circle. Per-pair
          calibration error becomes visually obvious — bad pairs are circles
          that don't pass through the selected node. */}
      <NodeDebugOverlay transform={transform} nodes={floorNodes} />
    </svg>
    <ViewportControls isZoomed={viewport.isZoomed} onReset={viewport.reset} />
    </>
  );
}
