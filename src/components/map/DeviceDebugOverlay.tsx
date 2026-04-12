"use client";

import type { FloorTransform } from "@/lib/map/geometry";
import { tx, ty } from "@/lib/map/geometry";
import { useDeviceSelection } from "./DeviceSelectionProvider";

interface Props {
  transform: FloorTransform;
}

/**
 * Color residual buckets — green for tight fits, red for "this node is lying".
 * Returned as raw hex for inline fallback; CSS classes also flip these in
 * dark mode via globals.css.
 */
function residualClass(residual: number | null): {
  cls: string;
  color: string;
} {
  if (residual == null) return { cls: "fp-residual-unknown", color: "#9ca3af" };
  const a = Math.abs(residual);
  if (a < 1.0) return { cls: "fp-residual-good", color: "#10b981" };
  if (a < 3.0) return { cls: "fp-residual-warn", color: "#f59e0b" };
  return { cls: "fp-residual-bad", color: "#ef4444" };
}

export default function DeviceDebugOverlay({ transform }: Props) {
  const { detail } = useDeviceSelection();
  if (!detail) return null;

  return (
    <g className="fp-debug-overlay">
      {/* Dotted measured-distance circles around each reporting node. The
          radii are in user units (meters), exactly the measurement value. */}
      {detail.measurements.map((m) => {
        if (
          !m.nodePoint ||
          m.measuredDistance == null ||
          m.measuredDistance <= 0
        ) {
          return null;
        }
        const { color } = residualClass(m.residual);
        const cx = tx(transform, m.nodePoint[0]);
        const cy = ty(transform, m.nodePoint[1]);
        return (
          <circle
            key={`debug-${m.nodeId}`}
            cx={cx}
            cy={cy}
            r={m.measuredDistance}
            fill="none"
            stroke={color}
            strokeWidth={0.04}
            strokeDasharray="0.18 0.12"
            strokeOpacity={0.75}
            className="fp-debug-circle"
          />
        );
      })}

      {/* Highlight ring around the selected device's computed position */}
      {detail.position && (
        <g
          className="fp-debug-target"
          transform={`translate(${tx(transform, detail.position.x)} ${ty(transform, detail.position.y)})`}
        >
          <circle
            r={0.32}
            fill="none"
            stroke="#ef4444"
            strokeWidth={0.06}
            strokeOpacity={0.9}
          />
          <circle
            r={0.45}
            fill="none"
            stroke="#ef4444"
            strokeWidth={0.03}
            strokeOpacity={0.4}
          />
        </g>
      )}
    </g>
  );
}
