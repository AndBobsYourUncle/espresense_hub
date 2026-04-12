"use client";

import { useMemo } from "react";
import type { Floor } from "@/lib/config";
import {
  buildCornerIndex,
  buildWallRef,
  polygonCentroid,
  tx,
  ty,
  type CornerRef,
  type FloorTransform,
  type Point2D,
  type WallRef,
} from "@/lib/map/geometry";
import { useMapTool } from "./MapToolProvider";
import { useNodeEdit } from "./NodeEditProvider";
import { useRuler } from "./RulerProvider";

interface Props {
  floor: Floor;
  transform: FloorTransform;
}

interface WallEdge {
  key: string;
  ref: WallRef;
  sx1: number;
  sy1: number;
  sx2: number;
  sy2: number;
}

interface CornerDot {
  key: string;
  ref: CornerRef;
  sx: number;
  sy: number;
}

/**
 * Picker overlay shared by two consumers:
 *   - Node editor in snap mode → walls AND corners are clickable; click
 *     dispatches to nodeEdit's selectWall / selectCorner.
 *   - Ruler wall picker → walls only (you can't measure to a corner with
 *     a tape); click dispatches to ruler.selectWall.
 *
 * Hidden when neither consumer is asking for a pick.
 */
export default function WallSelectionOverlay({ floor, transform }: Props) {
  const nodeEdit = useNodeEdit();
  const ruler = useRuler();
  const { activeTool } = useMapTool();

  const nodeEditActive =
    nodeEdit.placementMode === "snap" &&
    !nodeEdit.selectedWall &&
    !nodeEdit.selectedCorner;
  // Walls are clickable while the ruler tool is active and either no
  // measurement is in progress or the user explicitly entered the wall
  // picker. Picking a single node first doesn't block wall picking.
  const rulerActive =
    !ruler.selectedWall &&
    (ruler.wallPickerActive ||
      (activeTool === "ruler" && ruler.rulerNodes.length === 0));
  const showCorners = nodeEditActive; // ruler doesn't use corners

  const dispatchWall = (w: WallRef) => {
    // Ruler takes precedence — if both consumers happen to be active at the
    // same time the user just opened the ruler so they probably want that.
    if (rulerActive) {
      ruler.selectWall(w);
    } else if (nodeEditActive) {
      nodeEdit.selectWall(w);
    }
  };
  const dispatchCorner = (c: CornerRef) => {
    if (nodeEditActive) {
      nodeEdit.selectCorner(c);
    }
  };

  const edges = useMemo<WallEdge[]>(() => {
    const out: WallEdge[] = [];
    for (const room of floor.rooms) {
      if (!room.points || room.points.length < 2) continue;
      const centroid = polygonCentroid(room.points);
      const n = room.points.length;
      for (let i = 0; i < n; i++) {
        const a = room.points[i] as Point2D;
        const b = room.points[(i + 1) % n] as Point2D;
        const ref = buildWallRef(
          room.id ?? "",
          room.name ?? room.id ?? "",
          a,
          b,
          centroid,
        );
        if (!ref) continue;
        out.push({
          key: `${room.id ?? room.name ?? "room"}-${i}`,
          ref,
          sx1: tx(transform, a[0]),
          sy1: ty(transform, a[1]),
          sx2: tx(transform, b[0]),
          sy2: ty(transform, b[1]),
        });
      }
    }
    return out;
  }, [floor, transform]);

  const corners = useMemo<CornerDot[]>(() => {
    const refs = buildCornerIndex(floor.rooms);
    return refs.map((ref) => ({
      key: `${ref.point[0].toFixed(3)},${ref.point[1].toFixed(3)}`,
      ref,
      sx: tx(transform, ref.point[0]),
      sy: ty(transform, ref.point[1]),
    }));
  }, [floor, transform]);

  if (!nodeEditActive && !rulerActive) return null;

  return (
    <g className="snap-pick-overlay">
      {/* Walls render first so corner dots sit on top of intersections */}
      {edges.map((e) => (
        <line
          key={`wall-${e.key}`}
          x1={e.sx1}
          y1={e.sy1}
          x2={e.sx2}
          y2={e.sy2}
          className="wall-pick"
          onClick={(ev) => {
            ev.stopPropagation();
            dispatchWall(e.ref);
          }}
        >
          <title>{`${e.ref.roomName} · ${e.ref.length.toFixed(2)} m`}</title>
        </line>
      ))}
      {showCorners &&
        corners.map((c) => (
          <circle
            key={`corner-${c.key}`}
            cx={c.sx}
            cy={c.sy}
            r={0.16}
            className="corner-pick"
            onClick={(ev) => {
              ev.stopPropagation();
              dispatchCorner(c.ref);
            }}
          >
            <title>{`Corner · ${c.ref.roomNames.join(", ") || "room"}`}</title>
          </circle>
        ))}
    </g>
  );
}
