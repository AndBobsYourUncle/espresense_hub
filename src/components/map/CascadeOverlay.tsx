"use client";

import { useEffect, useMemo, useState } from "react";
import type { Floor, Room } from "@/lib/config";
import {
  type FloorTransform,
  polygonCentroid,
  tx,
  ty,
} from "@/lib/map/geometry";
import { findRoom } from "@/lib/locators/room_aware";
import { buildWallSegments, countCrossingsDetailed } from "@/lib/map/rf_geometry";
import { predictRssi, type RfParams } from "@/lib/map/rf_propagation";
import type { CascadeResponse } from "@/app/api/calibration/cascade/route";
import { useMapTool } from "./MapToolProvider";

interface Props {
  floor: Floor;
  transform: FloorTransform;
  nodes: Array<{
    id: string;
    point: readonly [number, number, number];
    room?: string;
  }>;
}

/**
 * Cascade-calibration map overlay — Phase 1 of the state-tracker
 * rebuild's visualization layer.
 *
 * Renders two things when the `cascade` tool is active:
 *
 *   1. **Pair residual graph** (always-on when tool active):
 *      A colored line between every (TX, RX) node pair, color-coded
 *      by the magnitude of the residual at the latest cascade fit.
 *      Width scales with sample count.
 *
 *      Color: green (model fits well) → yellow (typical noise) → red
 *      (model significantly misses this path).
 *
 *      Reveals at a glance which physical paths the model can/can't
 *      explain. If a specific wall has all-red residuals on every
 *      path crossing it, that's a hint the model needs per-wall (not
 *      per-category) attenuation.
 *
 *   2. **Fitted-params RSSI heatmap** (when a node is selected):
 *      Same heatmap rendering as the existing RF tool, but using the
 *      cascade's *fitted* parameters and the selected node's
 *      *learned* tx_offset instead of the configured RF parameters.
 *      Direct visual comparison: switch between the RF tool
 *      (configured) and Cascade tool (fitted) and see how the model
 *      changes.
 *
 * Independent of any locator — pure diagnostic.
 */

const MAX_RSSI = -40;
const MIN_RSSI = -120;
const GRID_CELL_M = 0.2;
const CELL_ALPHA = 255;

/** Polling interval for the cascade endpoint, ms. */
const POLL_MS = 10_000;

export default function CascadeOverlay({ floor, transform, nodes }: Props) {
  const {
    activeTool,
    inspectedNodeId,
    focusedCascadePairKey: focusedPairKey,
    setFocusedCascadePairKey: setFocusedPairKey,
  } = useMapTool();
  const [cascade, setCascade] = useState<CascadeResponse | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  const walls = useMemo(() => buildWallSegments([floor]), [floor]);

  // Poll the cascade endpoint while the tool is active. No-op when
  // it's off so we don't waste cycles on the inactive tool.
  useEffect(() => {
    if (activeTool !== "cascade") return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch("/api/calibration/cascade", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as CascadeResponse;
        if (!cancelled) setCascade(j);
      } catch {
        // best-effort
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeTool]);

  const selected = useMemo(() => {
    if (!inspectedNodeId) return null;
    return nodes.find((n) => n.id === inspectedNodeId) ?? null;
  }, [inspectedNodeId, nodes]);

  // Source-room centroid for the wall-at-source side test (mirrors RfPropagationOverlay).
  const sourceRoomCentroid = useMemo((): readonly [number, number] | null => {
    if (!selected) return null;
    const resolveRoomId = (label: string | undefined): Room | null =>
      label
        ? floor.rooms.find((r) => r.id === label || r.name === label) ?? null
        : null;
    let room: Room | null = resolveRoomId(selected.room);
    if (!room) {
      const id = findRoom(floor.rooms, [selected.point[0], selected.point[1]]);
      room = id ? resolveRoomId(id) : null;
    }
    if (!room?.points) return null;
    return polygonCentroid(room.points);
  }, [selected, floor]);

  // Build the RfParams used for the fitted-heatmap. Falls back to
  // configured params if no fit yet.
  const fittedParams = useMemo<RfParams | null>(() => {
    if (!cascade?.fit) return null;
    return {
      referenceRssi1m: cascade.fit.referenceRssi1m,
      pathLossExponent: cascade.fit.pathLossExponent,
      wallAttenuationDb: cascade.fit.wallAttenuationDb,
      exteriorWallAttenuationDb: cascade.fit.exteriorWallAttenuationDb,
      doorAttenuationDb: cascade.fit.doorAttenuationDb,
      reflectionLossDb: cascade.fit.reflectionLossDb,
    };
  }, [cascade]);

  // Per-node TX offset for the selected node (Layer 2 — applies to
  // *this node's transmitted signal*, so it shifts the predicted
  // heatmap from the selected node by `txOffsetDb`).
  const selectedTxOffset = useMemo<number>(() => {
    if (!selected || !cascade?.fit) return 0;
    return cascade.fit.nodeOffsets[selected.id]?.txOffsetDb ?? 0;
  }, [selected, cascade]);

  // Render the fitted-params heatmap for the selected node.
  useEffect(() => {
    if (
      activeTool !== "cascade" ||
      !selected ||
      !fittedParams
    ) {
      setDataUrl(null);
      return;
    }

    const widthM = transform.bounds.maxX - transform.bounds.minX;
    const heightM = transform.bounds.maxY - transform.bounds.minY;
    const nx = Math.max(1, Math.ceil(widthM / GRID_CELL_M));
    const ny = Math.max(1, Math.ceil(heightM / GRID_CELL_M));

    const canvas = document.createElement("canvas");
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(nx, ny);

    const [sx, sy] = [selected.point[0], selected.point[1]];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = transform.bounds.minX + (i + 0.5) * GRID_CELL_M;
        const y = transform.bounds.minY + (j + 0.5) * GRID_CELL_M;
        // predictRssi gives ref + path_loss + wall_loss. Add the
        // selected node's tx_offset on top — its signal is shifted
        // by that amount per Layer 2.
        const rssi =
          predictRssi(sx, sy, x, y, walls, fittedParams, sourceRoomCentroid ?? undefined) +
          selectedTxOffset;
        const [r, g, b, a] = rssiToRgba(rssi);
        const idx = (j * nx + i) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    setDataUrl(canvas.toDataURL("image/png"));
  }, [
    activeTool,
    selected,
    transform,
    walls,
    fittedParams,
    sourceRoomCentroid,
    selectedTxOffset,
  ]);

  // Build node-id → point lookup for residual lines.
  const nodeById = useMemo(() => {
    const m = new Map<string, Props["nodes"][number]>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Pair residual paths — uses the routed waypoints from the cascade
  // when available (so we draw the path the cascade thinks the
  // signal actually takes), falling back to straight TX→RX line when
  // routing isn't computed for this pair.
  //
  // When a node is selected, filter to just that node's pairs so the
  // map isn't blanketed with 200 crossing polylines. Debug inspector
  // use case: "show me what the model sees between THIS node and
  // every other node."
  const pairPaths = useMemo(() => {
    if (!cascade) return [];
    const selectedId = selected?.id;
    return cascade.pairs
      .filter((p) => p.residualDb != null)
      .filter((p) =>
        selectedId ? p.txId === selectedId || p.rxId === selectedId : true,
      )
      .map((p) => {
        const txNode = nodeById.get(p.txId);
        const rxNode = nodeById.get(p.rxId);
        if (!txNode || !rxNode) return null;
        // Use routed waypoints if present; else just TX→RX.
        const points: Array<readonly [number, number]> = p.routedPath
          ? p.routedPath.points
          : [
              [txNode.point[0], txNode.point[1]],
              [rxNode.point[0], rxNode.point[1]],
            ];
        return {
          key: `${p.txId}|${p.rxId}`,
          tx: txNode,
          rx: rxNode,
          residualDb: p.residualDb as number,
          weight: p.weight,
          points,
          pairEntry: p,
          /** True if cascade's routing chose a multi-hop path. */
          isRouted:
            p.routedPath != null &&
            p.routedPath.points.length > 2,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l != null);
  }, [cascade, nodeById, selected?.id]);

  // Wall-crossing inspector — only active when a node is selected.
  // For each of the selected node's pairs, compute which walls the
  // *direct* ray-cast sees (what obstructionCountsForPair counted at
  // sample time; the same counts stored in stats.walls). Highlight
  // those walls colored by type so it's visible at a glance which
  // walls the model thinks are between these nodes.
  //
  // We compute direct-line crossings from the selected node outward
  // (selected as source) using its room centroid for the wall-at-
  // source side test — matching how the stats were accumulated. This
  // lets us spot cases like master_bedroom_3 → office where the
  // straight line passes through walls that the real signal doesn't.
  const crossedWalls = useMemo(() => {
    if (!selected || !cascade) return [] as Array<{
      key: string;
      type: "interior" | "exterior" | "door";
      a: readonly [number, number];
      b: readonly [number, number];
    }>;
    // Approximate selected's room centroid from floor rooms.
    // (We don't have access to rf_cache on the client — recompute.)
    const resolveRoomId = (label: string | undefined): Room | null =>
      label
        ? floor.rooms.find((r) => r.id === label || r.name === label) ?? null
        : null;
    let room: Room | null = resolveRoomId(selected.room);
    if (!room) {
      const id = findRoom(floor.rooms, [selected.point[0], selected.point[1]]);
      room = id ? resolveRoomId(id) : null;
    }
    const centroid = room?.points ? polygonCentroid(room.points) : undefined;

    // Dedup by wall index — a given wall only needs one highlight even
    // if many of the selected node's pairs cross it.
    const hitMap = new Map<number, "interior" | "exterior" | "door">();
    const upgrade = (existing: typeof hitMap extends Map<number, infer T> ? T : never, incoming: typeof existing): typeof existing => {
      // door > exterior > interior
      const rank = { interior: 0, exterior: 1, door: 2 } as const;
      return rank[incoming] > rank[existing] ? incoming : existing;
    };
    // Focus mode: if a pair is pinned, only compute that pair's
    // crossings — makes the walls-for-one-edge story readable
    // when a node has 20+ pairs worth of crossings overlapping.
    const visible = focusedPairKey
      ? pairPaths.filter((p) => p.key === focusedPairKey)
      : pairPaths;
    for (const p of visible) {
      // Determine the "other" endpoint relative to selected.
      const other =
        p.tx.id === selected.id ? p.rx : p.tx;
      const { crossings } = countCrossingsDetailed(
        selected.point[0],
        selected.point[1],
        other.point[0],
        other.point[1],
        walls,
        centroid,
      );
      for (const c of crossings) {
        for (const idx of c.segmentIndices) {
          const existing = hitMap.get(idx);
          hitMap.set(idx, existing ? upgrade(existing, c.type) : c.type);
        }
      }
    }
    return Array.from(hitMap.entries()).map(([idx, type]) => {
      const seg = walls[idx];
      return {
        key: `w${idx}`,
        type,
        a: seg.a,
        b: seg.b,
      };
    });
  }, [selected, cascade, pairPaths, walls, floor, focusedPairKey]);

  if (activeTool !== "cascade") return null;

  // Heatmap projection (mirrors RfPropagationOverlay).
  const x1 = tx(transform, transform.bounds.minX);
  const x2 = tx(transform, transform.bounds.maxX);
  const y1 = ty(transform, transform.bounds.minY);
  const y2 = ty(transform, transform.bounds.maxY);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const scaleY = transform.flipY ? -1 : 1;
  const translateY = transform.flipY ? y * 2 + height : 0;

  return (
    <g className="cascade-overlay">
      {/* Fitted-params heatmap, when a node is selected */}
      {dataUrl && (
        <image
          href={dataUrl}
          x={x}
          y={y}
          width={width}
          height={height}
          preserveAspectRatio="none"
          transform={`translate(0 ${translateY}) scale(1 ${scaleY})`}
          style={{ opacity: 0.7, imageRendering: "auto", pointerEvents: "none" }}
        />
      )}

      {/* Pair residual graph — drawn on top of the heatmap so the
          colored polylines remain readable. Each polyline is one
          (TX, RX) pair traced through the cascade's routed path
          (D6); color = residual magnitude, width = sample count.
          Routed paths visibly bend through doors / open areas
          instead of going straight through walls. */}
      <g className="cascade-pair-graph">
        {pairPaths.map((l) => {
          const stroke = residualToColor(l.residualDb);
          const widthM = 0.05 + 0.13 * Math.min(1, Math.log10(l.weight) / 3);
          const isFocused = focusedPairKey === l.key;
          const isDimmed = focusedPairKey != null && !isFocused;
          // Build SVG points string from path waypoints.
          const pts = l.points
            .map(
              (p) =>
                `${tx(transform, p[0]).toFixed(2)},${ty(transform, p[1]).toFixed(2)}`,
            )
            .join(" ");
          return (
            <polyline
              key={l.key}
              points={pts}
              fill="none"
              stroke={stroke}
              strokeWidth={isFocused ? widthM * 1.8 : widthM}
              strokeOpacity={isDimmed ? 0.12 : isFocused ? 0.95 : 0.65}
              strokeLinecap="round"
              strokeLinejoin="round"
              // Routed (multi-hop) paths get a slightly different
              // visual cue so you can tell at a glance which pairs
              // the routing graph "fixed" by finding a better path.
              strokeDasharray={l.isRouted ? "0.3 0.15" : undefined}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                setFocusedPairKey(isFocused ? null : l.key);
              }}
            >
              <title>
                {`${l.tx.id} → ${l.rx.id}  resid ${l.residualDb.toFixed(1)} dB  w=${l.weight.toFixed(0)}  direct walls: ${l.pairEntry.walls.interior}i/${l.pairEntry.walls.exterior}e/${l.pairEntry.walls.doors}d${l.pairEntry.routedPath ? `  routed: ${l.pairEntry.routedPath.interior}i/${l.pairEntry.routedPath.exterior}e/${l.pairEntry.routedPath.doors}d` : ""}${l.isRouted ? "  [multi-hop]" : ""}`}
              </title>
            </polyline>
          );
        })}
      </g>

      {/* Wall-crossing debug overlay — when a node is selected, draw
          every wall that any of that node's direct pair-rays crosses,
          colored by type (interior blue / exterior red / door green).
          Instantly answers "what walls does the model think are
          between these nodes?" — useful for spotting geometry errors
          where a drawn wall should actually be an archway or missing
          door. */}
      {selected && crossedWalls.map((w) => (
        <line
          key={w.key}
          x1={tx(transform, w.a[0])}
          y1={ty(transform, w.a[1])}
          x2={tx(transform, w.b[0])}
          y2={ty(transform, w.b[1])}
          style={{ pointerEvents: "none" }}
          stroke={
            w.type === "door"
              ? "#22c55e"
              : w.type === "exterior"
                ? "#ef4444"
                : "#3b82f6"
          }
          strokeWidth={0.18}
          strokeOpacity={0.85}
          strokeLinecap="round"
        >
          <title>
            {w.type} wall — crossed by pair ray from {selected.id}
          </title>
        </line>
      ))}

      {/* Highlight the selected node */}
      {selected && (
        <circle
          cx={tx(transform, selected.point[0])}
          cy={ty(transform, selected.point[1])}
          r={0.25}
          fill="none"
          stroke="#84cc16"
          strokeWidth={0.08}
          strokeOpacity={0.95}
        />
      )}
    </g>
  );
}

/**
 * Map a signed RSSI residual (dB) to a color stop.
 *
 *   |residual| < 3      green        (model fits well)
 *   3 ≤ |residual| < 6  light green  (small drift)
 *   6 ≤ |residual| < 9  amber        (typical noise / mild miss)
 *   9 ≤ |residual| < 14 orange       (notable miss)
 *   |residual| ≥ 14     red          (model significantly wrong)
 */
function residualToColor(residualDb: number): string {
  const a = Math.abs(residualDb);
  if (a < 3) return "#22c55e"; // green-500
  if (a < 6) return "#84cc16"; // lime-500
  if (a < 9) return "#eab308"; // yellow-500
  if (a < 14) return "#f97316"; // orange-500
  return "#ef4444"; // red-500
}

/** Same RSSI → color mapping as RfPropagationOverlay (viridis-ish). */
function rssiToRgba(rssi: number): [number, number, number, number] {
  const t = Math.max(0, Math.min(1, (rssi - MIN_RSSI) / (MAX_RSSI - MIN_RSSI)));
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 144, 140]],
    [0.75, [94, 201, 97]],
    [1.0, [253, 231, 37]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      const r = Math.round(c0[0] + f * (c1[0] - c0[0]));
      const g = Math.round(c0[1] + f * (c1[1] - c0[1]));
      const b = Math.round(c0[2] + f * (c1[2] - c0[2]));
      return [r, g, b, CELL_ALPHA];
    }
  }
  return [253, 231, 37, CELL_ALPHA];
}
