"use client";

import { useMemo } from "react";
import type { FloorTransform } from "@/lib/map/geometry";
import { tx, ty } from "@/lib/map/geometry";
import { useDeviceSelection } from "./DeviceSelectionProvider";
import { colorForLocator } from "./locatorColors";
import { useMapTool } from "./MapToolProvider";
import { useDevicePositionsStream } from "./useDevicePositionsStream";

interface Props {
  transform: FloorTransform;
  /** Stale-after in milliseconds — devices older than this are hidden. */
  staleAfterMs: number;
}

/**
 * Deterministic color per node id — used to color cascade iso-RSSI
 * contours so each node's ring is visually distinct. Hashes the
 * id to a hue in the HSL space; 70% saturation + 55% lightness
 * give legible colors that read on both light and dark backgrounds.
 */
function hueForNodeId(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (h * 33) ^ id.charCodeAt(i);
  const hue = ((h >>> 0) % 360);
  return `hsl(${hue}, 72%, 55%)`;
}

export default function DeviceMarkers({
  transform,
  staleAfterMs,
}: Props) {
  const { devices, snapping } = useDevicePositionsStream();
  const { selectedId, select } = useDeviceSelection();
  const {
    compareMode,
    setInspectedNodeId,
    hiddenLocators,
    filteredDeviceId,
  } = useMapTool();
  const now = Date.now();

  const visible = devices.filter((d) => {
    if (now - d.lastSeen > staleAfterMs) return false;
    if (filteredDeviceId != null && d.id !== filteredDeviceId) return false;
    return true;
  });

  return (
    <g>
      {/* Upstream-companion ghost — only when compare mode is on AND
          upstream-companion is publishing positions on the same broker.
          Slate gray to read as "external reference". The dashed line
          to our active marker is the headline visual: the magnitude of
          the offset IS the per-frame benefit our pipeline buys you. */}
      {compareMode &&
        !hiddenLocators.has("upstream_companion") &&
        visible.map((d) => {
          if (!d.upstreamPosition) return null;
          const sx = tx(transform, d.x);
          const sy = ty(transform, d.y);
          const ux = tx(transform, d.upstreamPosition.x);
          const uy = ty(transform, d.upstreamPosition.y);
          const color = colorForLocator("upstream_companion");
          return (
            <g
              key={`upstream-${d.id}`}
              className="fp-device-ghost pointer-events-none"
            >
              <line
                x1={sx}
                y1={sy}
                x2={ux}
                y2={uy}
                stroke={color}
                strokeWidth={0.04}
                strokeOpacity={0.7}
                strokeDasharray="0.1 0.08"
              />
              <circle
                cx={ux}
                cy={uy}
                r={0.13}
                fill="none"
                stroke={color}
                strokeWidth={0.05}
                strokeOpacity={0.95}
              />
            </g>
          );
        })}

      {/* Per-locator ghost markers + connecting lines, drawn under the
          primary markers so they don't intercept clicks. One ghost per
          alternative locator, color-coded by algorithm. */}
      {compareMode &&
        visible.map((d) => {
          if (!d.alternatives || d.alternatives.length === 0) return null;
          const sx = tx(transform, d.x);
          const sy = ty(transform, d.y);
          return (
            <g
              key={`ghosts-${d.id}`}
              className="fp-device-ghost pointer-events-none"
            >
              {d.alternatives.map((alt, i) => {
                if (hiddenLocators.has(alt.algorithm)) return null;
                const ax = tx(transform, alt.x);
                const ay = ty(transform, alt.y);
                const color = colorForLocator(alt.algorithm);
                // Compute max heatmap density for normalization.
                const maxHeat = alt.heatmap?.reduce(
                  (m, h) => (h[2] > m ? h[2] : m),
                  0,
                ) ?? 0;
                return (
                  <g key={`${d.id}-${alt.algorithm}-${i}`}>
                    {/* Density heatmap as a single canvas-backed
                        SVG image. Painting hundreds of <rect>
                        elements per frame lags behind the dots
                        (visible "heatmap delay" relative to ring
                        updates). One <image> = one paint call —
                        synchronizes with the dots exactly. */}
                    {alt.heatmap && maxHeat > 0 && (
                      <HeatmapImage
                        heatmap={alt.heatmap}
                        maxHeat={maxHeat}
                        transform={transform}
                      />
                    )}
                    {/* Iso-RSSI contours — one per observing node.
                        Each contour gets a distinct hue derived from
                        its nodeId hash. Ring opacity scales with
                        the per-node residual at the chosen position
                        — well-fitting nodes are bright, outliers
                        (body shadow / per-node bias) fade out. */}
                    {alt.contours?.map((contour) => {
                      const ringColor = hueForNodeId(contour.nodeId);
                      const r = Math.abs(contour.residualDb ?? 0);
                      // 0 dB → opacity 0.85, 6 dB → ~0.45, 12+ → ~0.15
                      const fitOpacity = Math.max(
                        0.15,
                        Math.min(0.85, 0.85 - r / 18),
                      );
                      return (
                        <g key={`contour-${contour.nodeId}`}>
                          {contour.points.map((p, pi) => (
                            <circle
                              key={pi}
                              cx={tx(transform, p[0])}
                              cy={ty(transform, p[1])}
                              r={0.07}
                              fill={ringColor}
                              fillOpacity={fitOpacity}
                            />
                          ))}
                        </g>
                      );
                    })}
                    {/* Iso-distance rings — (legacy free-space form). */}
                    {alt.rings?.map((r, ri) => (
                      <circle
                        key={`ring-${ri}`}
                        cx={tx(transform, r[0])}
                        cy={ty(transform, r[1])}
                        r={r[2]}
                        fill="none"
                        stroke={color}
                        strokeWidth={0.04}
                        strokeOpacity={0.6}
                      />
                    ))}
                    {/* Candidate points — particle-cloud style. */}
                    {alt.candidates?.map((c, ci) => (
                      <circle
                        key={ci}
                        cx={tx(transform, c[0])}
                        cy={ty(transform, c[1])}
                        r={0.04}
                        fill={color}
                        fillOpacity={0.5}
                      />
                    ))}
                    <line
                      x1={sx}
                      y1={sy}
                      x2={ax}
                      y2={ay}
                      stroke={color}
                      strokeWidth={0.04}
                      strokeOpacity={0.65}
                      strokeDasharray="0.1 0.08"
                    />
                    <circle
                      cx={ax}
                      cy={ay}
                      r={0.12}
                      fill="none"
                      stroke={color}
                      strokeWidth={0.05}
                      strokeOpacity={0.9}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}

      {/* Pin-convergence marker: when a pin is locking the displayed
          position, also render the raw locator's interpretation as a
          small ghost dot with a dashed line back to the pin. Watching
          the dashed line shrink over time confirms bias-learning is
          converging. Always visible (not gated by compareMode) because
          this is direct user feedback on an action they just took. */}
      {visible.map((d) => {
        if (!d.rawPosition) return null;
        const sx = tx(transform, d.x);
        const sy = ty(transform, d.y);
        const rx = tx(transform, d.rawPosition.x);
        const ry = ty(transform, d.rawPosition.y);
        const dxm = d.rawPosition.x - d.x;
        const dym = d.rawPosition.y - d.y;
        const distM = Math.sqrt(dxm * dxm + dym * dym);
        return (
          <g
            key={`raw-${d.id}`}
            className="fp-device-raw pointer-events-none"
          >
            <line
              x1={sx}
              y1={sy}
              x2={rx}
              y2={ry}
              stroke="#a78bfa"
              strokeWidth={0.04}
              strokeOpacity={0.7}
              strokeDasharray="0.1 0.08"
            />
            <circle
              cx={rx}
              cy={ry}
              r={0.13}
              fill="none"
              stroke="#a78bfa"
              strokeWidth={0.05}
              strokeOpacity={0.95}
            />
            <text
              x={rx}
              y={ry - 0.25}
              textAnchor="middle"
              fontSize={0.18}
              fontWeight={500}
              fill="#7c3aed"
              stroke="#ffffff"
              strokeWidth={0.04}
              paintOrder="stroke"
            >
              raw · {distM.toFixed(1)}m off
            </text>
          </g>
        );
      })}

      {visible.map((d) => {
        const sx = tx(transform, d.x);
        const sy = ty(transform, d.y);
        const label = d.name ?? d.id;
        const isSelected = d.id === selectedId;
        return (
          <g
            key={d.id}
            className={`fp-device${isSelected ? " fp-device-selected" : ""}`}
            data-snapping={snapping ? "" : undefined}
            transform={`translate(${sx} ${sy})`}
            onClick={(e) => {
              e.stopPropagation();
              // Selecting a device dismisses any open node inspector —
              // the two side-panels would otherwise pile up on the same
              // map, and the user almost never wants to study both at once.
              if (!isSelected) setInspectedNodeId(null);
              select(isSelected ? null : d.id);
            }}
            style={{ cursor: "pointer" }}
          >
            <circle
              r={0.18}
              fill="#f97316"
              stroke="#ffffff"
              strokeWidth={0.05}
              className="fp-device-dot"
            >
              <title>{`${label} · ${d.fixes} fixes · ${(d.confidence * 100).toFixed(0)}%`}</title>
            </circle>
            <text
              y={-0.3}
              textAnchor="middle"
              fontSize={0.24}
              fontWeight={600}
              fill="#9a3412"
              stroke="#ffffff"
              strokeWidth={0.07}
              strokeLinejoin="round"
              paintOrder="stroke"
              className="fp-device-label pointer-events-none select-none"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Render a sparse heatmap as a single SVG <image> backed by a
 * canvas. Painting many <rect> elements per frame falls behind
 * other DOM updates (visible "lag" between heatmap and ring dots).
 * Compositing to a canvas means one paint call regardless of cell
 * count, so the heatmap updates in lockstep with the rest of the
 * markers on every SSE tick.
 *
 * The image is positioned in floor coordinates via an SVG transform,
 * matching the data layer the dots render in.
 */
function HeatmapImage({
  heatmap,
  maxHeat,
  transform,
}: {
  heatmap: ReadonlyArray<readonly [number, number, number]>;
  maxHeat: number;
  transform: FloorTransform;
}) {
  const result = useMemo(() => {
    if (heatmap.length === 0) return null;

    // Find bounds of the heatmap cells.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of heatmap) {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] > maxY) maxY = c[1];
    }
    // Pad slightly so cells at the edge render fully.
    const pad = 0.1;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    // 10 px per meter — fine enough for 0.1m grid cells.
    const PX_PER_M = 20;
    const wM = maxX - minX;
    const hM = maxY - minY;
    const w = Math.max(1, Math.ceil(wM * PX_PER_M));
    const h = Math.max(1, Math.ceil(hM * PX_PER_M));

    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Each heatmap cell rendered as a small filled square. Cell size
    // matches the locator's 0.1m grid resolution.
    const cellPx = Math.max(1, Math.round(0.18 * PX_PER_M));
    for (const cell of heatmap) {
      const t = cell[2] / maxHeat;
      const hue = 55 - 55 * t;
      const lightness = 60 - 25 * t;
      const opacity = 0.35 + 0.55 * t;
      ctx.fillStyle = `hsla(${hue}, 100%, ${lightness}%, ${opacity})`;
      const px = (cell[0] - minX) * PX_PER_M - cellPx / 2;
      const py = (cell[1] - minY) * PX_PER_M - cellPx / 2;
      ctx.fillRect(px, py, cellPx, cellPx);
    }
    return { url: canvas.toDataURL(), minX, minY, maxX, maxY };
  }, [heatmap, maxHeat]);

  if (!result) return null;

  // Map heatmap world bounds into the SVG floor coordinate system,
  // accounting for transform flips.
  const x1 = tx(transform, result.minX);
  const x2 = tx(transform, result.maxX);
  const y1 = ty(transform, result.minY);
  const y2 = ty(transform, result.maxY);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const scaleY = transform.flipY ? -1 : 1;
  const translateY = transform.flipY ? y * 2 + height : 0;

  return (
    <image
      href={result.url}
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio="none"
      transform={`translate(0 ${translateY}) scale(1 ${scaleY})`}
      style={{ pointerEvents: "none", imageRendering: "auto" }}
    />
  );
}
