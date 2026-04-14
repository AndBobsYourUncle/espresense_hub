"use client";

import { useEffect, useMemo, useState } from "react";
import type { Floor } from "@/lib/config";
import {
  type FloorTransform,
  tx,
  ty,
} from "@/lib/map/geometry";
import { buildWallSegments } from "@/lib/map/rf_geometry";
import { predictRssi, type RfParams } from "@/lib/map/rf_propagation";
import { useMapTool } from "./MapToolProvider";

interface Props {
  floor: Floor;
  transform: FloorTransform;
  nodes: Array<{
    id: string;
    point: readonly [number, number, number];
  }>;
  rfParams: RfParams;
}

/**
 * RSSI range used for color mapping. Anything ≥ `MAX_RSSI` renders as
 * the hottest color at full opacity; ≤ `MIN_RSSI` renders fully
 * transparent (undetectable, the device effectively isn't there).
 * Typical BLE devices start losing packets around −90 dBm.
 */
const MAX_RSSI = -40;
const MIN_RSSI = -95;

/**
 * Grid resolution in metres per cell. 0.2 m ≈ 8-inch cells — more than
 * fine enough to see door openings and wall lines without hammering
 * the CPU. A 22×18 m floor at this resolution is ~10 000 cells.
 */
const GRID_CELL_M = 0.2;

/**
 * RF propagation overlay — renders a predicted-RSSI heatmap for the
 * currently-selected node when the `rf-propagation` tool is active.
 * Selection happens via clicking a node; `selectedNodeId` lives in the
 * `useMapTool` context (reuse of `inspectedNodeId`).
 *
 * The heatmap is rasterized to an offscreen canvas and embedded as an
 * SVG `<image>` sized to the floor bounds, so it inherits the parent
 * SVG's pan/zoom transforms for free.
 */
export default function RfPropagationOverlay({
  floor,
  transform,
  nodes,
  rfParams,
}: Props) {
  const { activeTool, inspectedNodeId } = useMapTool();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  const walls = useMemo(() => buildWallSegments([floor]), [floor]);

  const selected = useMemo(() => {
    if (!inspectedNodeId) return null;
    return nodes.find((n) => n.id === inspectedNodeId) ?? null;
  }, [inspectedNodeId, nodes]);

  useEffect(() => {
    if (activeTool !== "rf-propagation" || !selected) {
      setDataUrl(null);
      return;
    }

    const widthM = transform.bounds.maxX - transform.bounds.minX;
    const heightM = transform.bounds.maxY - transform.bounds.minY;
    const nx = Math.max(1, Math.ceil(widthM / GRID_CELL_M));
    const ny = Math.max(1, Math.ceil(heightM / GRID_CELL_M));

    // Offscreen canvas at the grid resolution. SVG `<image>` handles the
    // scale-up to floor dimensions with browser-native bilinear filtering,
    // which is exactly the visual smoothing we want for a coarse heatmap.
    const canvas = document.createElement("canvas");
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(nx, ny);

    const [sx, sy] = [selected.point[0], selected.point[1]];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        // Cell-center position in config-space.
        const x = transform.bounds.minX + (i + 0.5) * GRID_CELL_M;
        const y = transform.bounds.minY + (j + 0.5) * GRID_CELL_M;
        const rssi = predictRssi(sx, sy, x, y, walls, rfParams);
        const [r, g, b, a] = rssiToRgba(rssi);
        // Rows in imageData go top-to-bottom in pixel-space. Our
        // config-space y increases upward; the parent SVG's flipY
        // handles orientation, so we don't need to invert here — just
        // pack cells as (i, j).
        const idx = (j * nx + i) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    setDataUrl(canvas.toDataURL("image/png"));
  }, [activeTool, selected, transform, walls, rfParams]);

  if (activeTool !== "rf-propagation" || !selected || !dataUrl) return null;

  // Project the floor bounds into SVG space for the image placement.
  // The image is painted in cell-grid space; the SVG transform + flipY
  // take care of orientation.
  const x1 = tx(transform, transform.bounds.minX);
  const x2 = tx(transform, transform.bounds.maxX);
  const y1 = ty(transform, transform.bounds.minY);
  const y2 = ty(transform, transform.bounds.maxY);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  // Mirror the image when flipY is active so that "top of canvas
  // grid" lines up with "top of visual floor." Simpler than rotating
  // the grid indices during raster.
  const scaleY = transform.flipY ? -1 : 1;
  const translateY = transform.flipY ? y * 2 + height : 0;

  return (
    <g className="rf-propagation-overlay" style={{ pointerEvents: "none" }}>
      <image
        href={dataUrl}
        x={x}
        y={y}
        width={width}
        height={height}
        preserveAspectRatio="none"
        transform={`translate(0 ${translateY}) scale(1 ${scaleY})`}
        style={{ opacity: 0.65, imageRendering: "auto" }}
      />
      {/* Highlight the selected node */}
      <circle
        cx={tx(transform, selected.point[0])}
        cy={ty(transform, selected.point[1])}
        r={0.25}
        fill="none"
        stroke="#f97316"
        strokeWidth={0.08}
        strokeOpacity={0.95}
      />
    </g>
  );
}

/**
 * Map predicted RSSI (dBm) to an RGBA tuple. Low RSSI → transparent
 * (signal unusable), high RSSI → bright. Viridis-ish gradient: purple
 * (weak) → teal → yellow → white-ish (strong).
 */
function rssiToRgba(rssi: number): [number, number, number, number] {
  if (rssi <= MIN_RSSI) return [0, 0, 0, 0];
  const t = Math.max(0, Math.min(1, (rssi - MIN_RSSI) / (MAX_RSSI - MIN_RSSI)));
  // Five-stop gradient keyed to t ∈ [0, 1]. Colors picked from a
  // rough viridis palette with the low end shifted toward cool so the
  // "barely detectable" regions read as dim purple.
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [68, 1, 84]], //   dark purple
    [0.25, [59, 82, 139]],
    [0.5, [33, 144, 140]],
    [0.75, [94, 201, 97]],
    [1.0, [253, 231, 37]], // bright yellow
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      const r = Math.round(c0[0] + f * (c1[0] - c0[0]));
      const g = Math.round(c0[1] + f * (c1[1] - c0[1]));
      const b = Math.round(c0[2] + f * (c1[2] - c0[2]));
      // Alpha also ramps with strength — weakest signals nearly
      // invisible, strongest fully opaque.
      const alpha = Math.round(Math.max(0, Math.min(1, t * 1.2)) * 255);
      return [r, g, b, alpha];
    }
  }
  return [253, 231, 37, 255];
}
