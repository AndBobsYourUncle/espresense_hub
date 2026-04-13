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

/**
 * Returns the latest device positions plus a `snapping` flag that's
 * true for one render whenever the tab just regained visibility.
 *
 * The flag is consumed by the marker's `data-snapping` attribute, which
 * pairs with a CSS rule that suppresses the normal transform transition
 * for that one frame. Without it, refocusing the tab after it's been
 * hidden for a while produces a long visible slide across the map as
 * the marker animates from its stale position to the freshly-fetched
 * one — distracting because the device didn't actually move smoothly,
 * we just missed seeing it move.
 */
function useDevicePositions(pollMs: number): {
  devices: DevicePositionDTO[];
  snapping: boolean;
} {
  const [devices, setDevices] = useState<DevicePositionDTO[]>([]);
  const [snapping, setSnapping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
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

    fetchOnce();
    const id = setInterval(fetchOnce, pollMs);

    // Tab refocus: refetch immediately AND set the snapping flag so the
    // catch-up render doesn't animate. A double rAF re-enables the
    // transition after the new transform has been committed to the DOM,
    // so subsequent updates get the normal smooth slide.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      setSnapping(true);
      fetchOnce();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSnapping(false));
      });
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pollMs]);

  return { devices, snapping };
}

export default function DeviceMarkers({
  transform,
  staleAfterMs,
  pollMs = 1000,
}: Props) {
  const { devices, snapping } = useDevicePositions(pollMs);
  const { selectedId, select } = useDeviceSelection();
  const { compareMode, setInspectedNodeId } = useMapTool();
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
