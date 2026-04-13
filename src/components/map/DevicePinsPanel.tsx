"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useUnits } from "@/components/UnitsProvider";
import { useIsTouch } from "@/lib/hooks/usePointerType";
import { formatDistanceDisplay } from "@/lib/units";
import { usePinHighlight } from "./PinHighlightProvider";

interface PinDTO {
  position: [number, number, number];
  timestamp: number;
  active: boolean;
  nodeBias: Record<
    string,
    { mean: number; stddev: number; sampleCount: number }
  >;
}

interface Props {
  deviceId: string | null;
}

/**
 * Pins panel — listed in the device detail sidebar. Shows every pin
 * for the selected device with sample counts, bias quality, and the
 * actions you can take (apply rssi@1m, delete). Drag/click on the
 * map handle position editing and active-state toggling; the panel
 * is for "what's the data and what can I do with it."
 */
export default function DevicePinsPanel({ deviceId }: Props) {
  const { units } = useUnits();
  const { setHoveredTimestamp } = usePinHighlight();
  const isTouch = useIsTouch();
  const [pins, setPins] = useState<PinDTO[]>([]);
  const [refRssi, setRefRssi] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const reload = useCallback(async () => {
    if (!deviceId) {
      setPins([]);
      setRefRssi(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/pin`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setPins(data.pins ?? []);
      setRefRssi(data.refRssi ?? null);
    } catch {
      // best-effort
    }
  }, [deviceId]);

  useEffect(() => {
    reload();
    if (!deviceId) return;
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [deviceId, reload]);

  const deletePin = useCallback(
    async (timestamp: number) => {
      if (!deviceId) return;
      // Optimistic — drop from list immediately.
      setPins((prev) => prev.filter((p) => p.timestamp !== timestamp));
      try {
        await fetch(
          `/api/devices/${encodeURIComponent(deviceId)}/pin?timestamp=${timestamp}`,
          { method: "DELETE" },
        );
      } finally {
        reload();
      }
    },
    [deviceId, reload],
  );

  const togglePinActive = useCallback(
    async (timestamp: number, makeActive: boolean) => {
      if (!deviceId) return;
      try {
        await fetch(`/api/devices/${encodeURIComponent(deviceId)}/pin`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timestamp, active: makeActive }),
        });
        reload();
      } catch {
        // best-effort
      }
    },
    [deviceId, reload],
  );

  // Clear hover state if the panel unmounts or the device changes.
  useEffect(() => {
    return () => setHoveredTimestamp(null);
  }, [deviceId, setHoveredTimestamp]);

  const applyRssi = useCallback(async () => {
    if (!deviceId) return;
    setApplying(true);
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/pin`,
        { method: "PUT" },
      );
      if (res.ok) {
        const data = await res.json();
        setApplied(data.published);
        setTimeout(() => setApplied(false), 4000);
      }
    } finally {
      setApplying(false);
    }
  }, [deviceId]);

  if (!deviceId || pins.length === 0) {
    return (
      <div className="px-4 pb-3 text-xs text-zinc-500 dark:text-zinc-400">
        No pins placed. Switch to the Pin tool and{" "}
        <strong>{isTouch ? "long-press" : "shift+click"}</strong> on the
        map where the device actually is to start building a learned RF
        map.
      </div>
    );
  }

  // Sort: active first, then most-recent first.
  const sorted = [...pins].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.timestamp - a.timestamp;
  });

  return (
    <div className="px-4 pb-3">
      <div className="flex items-baseline justify-between mb-2">
        {refRssi != null && (
          <button
            type="button"
            onClick={applyRssi}
            disabled={applying}
            className={`text-xs px-2 py-1 rounded font-medium transition-colors ${
              applied
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                : "bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
            }`}
            title="Push the computed rssi@1m to firmware via MQTT"
          >
            {applied
              ? `applied: ${refRssi} dBm`
              : applying
                ? "applying…"
                : `apply rssi@1m (${refRssi} dBm)`}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {sorted.map((pin) => {
          const totalSamples = Object.values(pin.nodeBias).reduce(
            (s, n) => s + n.sampleCount,
            0,
          );
          const ageMin = (Date.now() - pin.timestamp) / 60000;
          return (
            <div
              key={pin.timestamp}
              className={`rounded-md border p-2 text-xs cursor-pointer transition-colors ${
                pin.active
                  ? "border-sky-300 dark:border-sky-700 bg-sky-50/50 dark:bg-sky-950/20 hover:bg-sky-100 dark:hover:bg-sky-950/40"
                  : "border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
              }`}
              onMouseEnter={() => setHoveredTimestamp(pin.timestamp)}
              onMouseLeave={() => setHoveredTimestamp(null)}
              onClick={() => togglePinActive(pin.timestamp, !pin.active)}
              title={
                pin.active
                  ? "Click to stop accumulating"
                  : "Click to make this pin the active accumulator"
              }
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="font-mono text-zinc-700 dark:text-zinc-200">
                  {formatDistanceDisplay(pin.position[0], units)},{" "}
                  {formatDistanceDisplay(pin.position[1], units)}
                </div>
                <div className="flex items-center gap-2">
                  {pin.active ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase text-sky-600 dark:text-sky-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                      accumulating
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-400">
                      {ageMin < 60
                        ? `${Math.round(ageMin)}m ago`
                        : ageMin < 1440
                          ? `${Math.round(ageMin / 60)}h ago`
                          : `${Math.round(ageMin / 1440)}d ago`}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        confirm(
                          `Delete this pin? Its ${totalSamples} accumulated samples will be lost.`,
                        )
                      ) {
                        deletePin(pin.timestamp);
                      }
                    }}
                    className="inline-flex items-center justify-center h-6 w-6 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    title="Delete this pin"
                    aria-label="Delete pin"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
                {totalSamples} samples · {Object.keys(pin.nodeBias).length}{" "}
                nodes
              </div>
              {Object.keys(pin.nodeBias).length > 0 && (
                <details className="text-xs" onClick={(e) => e.stopPropagation()}>
                  <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 select-none">
                    per-node bias
                  </summary>
                  <div className="mt-1 space-y-0.5 font-mono">
                    {Object.entries(pin.nodeBias)
                      .sort((a, b) => b[1].sampleCount - a[1].sampleCount)
                      .map(([nodeId, s]) => {
                        const cls =
                          Math.abs(s.mean - 1) < 0.15
                            ? "text-emerald-600 dark:text-emerald-400"
                            : Math.abs(s.mean - 1) < 0.5
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-red-600 dark:text-red-400";
                        return (
                          <div
                            key={nodeId}
                            className="flex justify-between gap-2"
                          >
                            <span className="text-zinc-500 dark:text-zinc-400 truncate">
                              {nodeId}
                            </span>
                            <span className="flex gap-2 text-zinc-400 shrink-0">
                              <span className={cls}>
                                ×{s.mean.toFixed(2)}
                              </span>
                              <span>±{s.stddev.toFixed(2)}</span>
                              <span className="w-8 text-right">
                                n={s.sampleCount}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 text-xs text-zinc-400 leading-relaxed">
        {isTouch ? "Tap" : "Hover"} a row to highlight on the map.{" "}
        {isTouch ? "Tap" : "Click"} to toggle accumulation. On the map:{" "}
        <strong>{isTouch ? "long-press" : "shift+click"}</strong> empty
        space to add a pin, <strong>drag</strong> a pin to reposition.
      </div>
    </div>
  );
}
