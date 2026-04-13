"use client";

import { useEffect, useState } from "react";
import type { DevicePositionsResponse } from "@/app/api/devices/positions/route";
import { useUnits } from "@/components/UnitsProvider";
import { formatDistanceDisplay } from "@/lib/units";
import { LOCATOR_COLORS, LOCATOR_LABELS } from "./locatorColors";
import { useMapTool } from "./MapToolProvider";

/**
 * Floating legend shown in the bottom-right of the map when compare mode
 * is active. Each entry is a clickable toggle: click to hide that
 * locator's ghost markers; click again to show. Also displays the
 * running mean distance from each comparison locator's output to ours,
 * so the user gets a numeric "this locator is N meters off from us, on
 * average" reading without having to open another panel.
 *
 * Entries are filtered to what's actually live: the active locator
 * always shows; alternatives + upstream-companion only show when their
 * data is currently flowing.
 */
export default function CompareLegend() {
  const { compareMode, hiddenLocators, toggleLocator } = useMapTool();
  const { units } = useUnits();
  const live = useLiveLocatorData(compareMode);

  if (!compareMode) return null;

  const ACTIVE = "room_aware";
  // Active first; remaining order matches LOCATOR_LABELS declaration.
  const entries: Array<{
    key: string;
    label: string;
    color: string;
    delta: number | null;
    sampleCount: number;
  }> = [
    {
      key: ACTIVE,
      label: `${LOCATOR_LABELS[ACTIVE]} (active)`,
      color: LOCATOR_COLORS[ACTIVE],
      delta: null,
      sampleCount: 0,
    },
    ...Object.keys(LOCATOR_LABELS)
      .filter((k) => k !== ACTIVE && live.liveKeys.has(k))
      .map((k) => ({
        key: k,
        label: LOCATOR_LABELS[k],
        color: LOCATOR_COLORS[k],
        delta: live.deltas.get(k) ?? null,
        sampleCount: live.sampleCounts.get(k) ?? 0,
      })),
  ];

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 right-4 z-10 rounded-lg bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-sm p-2.5 min-w-[180px]"
      aria-label="Locator legend"
    >
      <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500 dark:text-zinc-400 mb-1.5">
        Locators
        <span className="ml-2 normal-case tracking-normal text-zinc-400 dark:text-zinc-500 font-normal">
          click to toggle
        </span>
      </div>
      <ul className="space-y-0.5">
        {entries.map((e) => {
          const hidden = hiddenLocators.has(e.key);
          const isActive = e.key === ACTIVE;
          return (
            <li key={e.key}>
              <button
                type="button"
                onClick={() => !isActive && toggleLocator(e.key)}
                disabled={isActive}
                title={
                  isActive
                    ? "The active locator — always shown"
                    : hidden
                      ? "Click to show"
                      : "Click to hide"
                }
                className={`w-full flex items-center gap-2 text-xs px-1.5 py-1 rounded transition-colors ${
                  isActive
                    ? "cursor-default"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                } ${hidden ? "opacity-40" : ""}`}
              >
                <span
                  className="inline-block w-3 h-3 rounded-full border border-white/50 dark:border-zinc-800 shrink-0"
                  style={{ backgroundColor: e.color }}
                />
                <span className="text-zinc-700 dark:text-zinc-300 truncate text-left flex-1">
                  {e.label}
                </span>
                {e.delta != null && e.sampleCount >= 5 && (
                  <span
                    className="font-mono tabular-nums text-zinc-500 dark:text-zinc-400 shrink-0"
                    title={`${e.sampleCount.toLocaleString()} samples averaged`}
                  >
                    {formatDistanceDisplay(e.delta, units)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface LiveData {
  liveKeys: Set<string>;
  /** algorithm → mean distance (meters) from us, averaged over all devices weighted by sample count. */
  deltas: Map<string, number>;
  /** algorithm → total samples across all devices. */
  sampleCounts: Map<string, number>;
}

/**
 * Poll positions, return the set of locators with live data plus
 * cross-device aggregated mean deltas (sample-weighted) and total
 * sample counts. Polls only while compare mode is on.
 */
function useLiveLocatorData(enabled: boolean): LiveData {
  const [data, setData] = useState<LiveData>({
    liveKeys: new Set(),
    deltas: new Map(),
    sampleCounts: new Map(),
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/devices/positions", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as DevicePositionsResponse;
        const liveKeys = new Set<string>();
        // Sum up sample×mean and total samples per algorithm so the
        // displayed value is sample-weighted across all devices.
        const sums = new Map<string, number>();
        const counts = new Map<string, number>();
        for (const d of j.devices) {
          if (d.alternatives) {
            for (const alt of d.alternatives) liveKeys.add(alt.algorithm);
          }
          if (d.upstreamPosition) liveKeys.add("upstream_companion");
          if (d.locatorDeltas) {
            for (const [algo, s] of Object.entries(d.locatorDeltas)) {
              sums.set(algo, (sums.get(algo) ?? 0) + s.mean * s.count);
              counts.set(algo, (counts.get(algo) ?? 0) + s.count);
            }
          }
        }
        const deltas = new Map<string, number>();
        for (const [algo, total] of counts) {
          if (total > 0) deltas.set(algo, (sums.get(algo) ?? 0) / total);
        }
        if (!cancelled) setData({ liveKeys, deltas, sampleCounts: counts });
      } catch {
        // best-effort
      }
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return data;
}
