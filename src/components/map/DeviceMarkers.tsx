"use client";

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

export default function DeviceMarkers({
  transform,
  staleAfterMs,
}: Props) {
  const { devices, snapping } = useDevicePositionsStream();
  const { selectedId, select } = useDeviceSelection();
  const { compareMode, setInspectedNodeId, hiddenLocators } = useMapTool();
  const now = Date.now();

  const visible = devices.filter((d) => now - d.lastSeen <= staleAfterMs);

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
              {d.alternatives.map((alt) => {
                if (hiddenLocators.has(alt.algorithm)) return null;
                const ax = tx(transform, alt.x);
                const ay = ty(transform, alt.y);
                const color = colorForLocator(alt.algorithm);
                return (
                  <g key={`${d.id}-${alt.algorithm}`}>
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
