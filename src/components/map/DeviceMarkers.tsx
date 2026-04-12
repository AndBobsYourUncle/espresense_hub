"use client";

import { useEffect, useState } from "react";
import type { FloorTransform } from "@/lib/map/geometry";
import { tx, ty } from "@/lib/map/geometry";
import type {
  DevicePositionDTO,
  DevicePositionsResponse,
} from "@/app/api/devices/positions/route";
import { useDeviceSelection } from "./DeviceSelectionProvider";
import { colorForLocator } from "./locatorColors";
import { useMapTool } from "./MapToolProvider";

interface Props {
  transform: FloorTransform;
  /** Stale-after in milliseconds — devices older than this are hidden. */
  staleAfterMs: number;
  /** Polling interval in milliseconds. */
  pollMs?: number;
}

function useDevicePositions(pollMs: number): DevicePositionDTO[] {
  const [devices, setDevices] = useState<DevicePositionDTO[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/devices/positions", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as DevicePositionsResponse;
        if (!cancelled) setDevices(data.devices);
      } catch {
        // swallow — next tick will retry
      }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  return devices;
}

export default function DeviceMarkers({
  transform,
  staleAfterMs,
  pollMs = 1000,
}: Props) {
  const devices = useDevicePositions(pollMs);
  const { selectedId, select } = useDeviceSelection();
  const { compareMode } = useMapTool();
  const now = Date.now();

  const visible = devices.filter((d) => now - d.lastSeen <= staleAfterMs);

  return (
    <g>
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

      {visible.map((d) => {
        const sx = tx(transform, d.x);
        const sy = ty(transform, d.y);
        const label = d.name ?? d.id;
        const isSelected = d.id === selectedId;
        return (
          <g
            key={d.id}
            className={`fp-device${isSelected ? " fp-device-selected" : ""}`}
            transform={`translate(${sx} ${sy})`}
            onClick={(e) => {
              e.stopPropagation();
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
