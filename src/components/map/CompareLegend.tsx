"use client";

import { useEffect, useState } from "react";
import type { DevicePositionsResponse } from "@/app/api/devices/positions/route";
import { useUnits } from "@/components/UnitsProvider";
import { formatDistanceDisplay } from "@/lib/units";
import { LOCATOR_COLORS, LOCATOR_LABELS } from "./locatorColors";
import { useMapTool } from "./MapToolProvider";

/**
 * Locators promoted to "primary" in the compare view — always shown by
 * default. Everything else is considered a debug alternative and hidden
 * until the user clicks "show all" or toggles individually.
 */
const PRIMARY_LOCATORS = new Set(["room_aware", "bayesian"]);

const DEBUG_LOCATORS = [
  "nadaraya_watson",
  "nelder_mead",
  "bfgs",
  "mle",
  "nearest_node",
  "upstream_companion",
];

/**
 * Floating legend shown in the bottom-right of the map when compare mode
 * is active. Shows primary locators (Room-Aware + Bayesian) up top with
 * their distance deltas and room-disagreement rates; debug alternatives
 * are collapsed behind a "show all" toggle to keep the typical view
 * uncluttered. Each entry is clickable to individually hide/show.
 */
export default function CompareLegend() {
  const { compareMode, hiddenLocators, toggleLocator, setHiddenLocators } =
    useMapTool();
  const { units } = useUnits();
  const live = useLiveLocatorData(compareMode);
  const [showDebug, setShowDebug] = useState(false);

  if (!compareMode) return null;

  const ACTIVE = "room_aware";

  type Entry = {
    key: string;
    label: string;
    color: string;
    delta: number | null;
    disagreeRate: number | null;
    insideOutsideRate: number | null;
    sampleCount: number;
  };

  const buildEntry = (k: string, label?: string): Entry => ({
    key: k,
    label: label ?? LOCATOR_LABELS[k] ?? k,
    color: LOCATOR_COLORS[k] ?? "#94a3b8",
    delta: live.deltas.get(k) ?? null,
    disagreeRate: live.disagreeRates.get(k) ?? null,
    insideOutsideRate: live.insideOutsideRates.get(k) ?? null,
    sampleCount: live.sampleCounts.get(k) ?? 0,
  });

  const primaryEntries: Entry[] = [
    buildEntry(ACTIVE, `${LOCATOR_LABELS[ACTIVE]} (active)`),
  ];
  if (live.liveKeys.has("bayesian")) {
    primaryEntries.push(buildEntry("bayesian"));
  }

  const debugEntries: Entry[] = DEBUG_LOCATORS
    .filter((k) => live.liveKeys.has(k))
    .map((k) => buildEntry(k));

  // Any debug locator currently visible? Used to auto-expand the section
  // if the user individually enabled one.
  const anyDebugVisible = debugEntries.some((e) => !hiddenLocators.has(e.key));
  const sectionOpen = showDebug || anyDebugVisible;

  const toggleShowAllDebug = () => {
    // Bulk toggle: if any debug locator is hidden, show them all; if all
    // are already visible, hide them all.
    const anyHidden = debugEntries.some((e) => hiddenLocators.has(e.key));
    setHiddenLocators((prev) => {
      const next = new Set(prev);
      if (anyHidden) {
        for (const e of debugEntries) next.delete(e.key);
      } else {
        for (const e of debugEntries) next.add(e.key);
      }
      return next;
    });
    setShowDebug(anyHidden);
  };

  const renderEntry = (e: Entry) => {
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
            isActive ? "cursor-default" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
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
          {e.disagreeRate != null && e.sampleCount >= 20 && (
            <span
              className={`font-mono tabular-nums shrink-0 text-[10px] ${
                e.disagreeRate < 0.05
                  ? "text-emerald-600 dark:text-emerald-400"
                  : e.disagreeRate < 0.2
                    ? "text-zinc-500 dark:text-zinc-400"
                    : "text-amber-600 dark:text-amber-400"
              }`}
              title="Room disagreement rate — fraction of samples where this locator picked a different room"
            >
              {(e.disagreeRate * 100).toFixed(0)}%
            </span>
          )}
          {e.insideOutsideRate != null && e.sampleCount >= 20 && (
            <span
              className={`font-mono tabular-nums shrink-0 text-[10px] ${
                e.insideOutsideRate < 0.01
                  ? "text-emerald-600 dark:text-emerald-400"
                  : e.insideOutsideRate < 0.05
                    ? "text-zinc-500 dark:text-zinc-400"
                    : "text-red-600 dark:text-red-400"
              }`}
              title="Inside/outside disagreement rate — fraction of samples where one locator said 'inside a room' and the other said 'outside all rooms'. The presence-automation breaker."
            >
              ⇄{(e.insideOutsideRate * 100).toFixed(1)}%
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 right-4 z-10 rounded-lg bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-sm p-2.5 max-w-[calc(100%-2rem)] sm:max-w-none w-auto sm:min-w-[220px]"
      aria-label="Locator legend"
    >
      <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500 dark:text-zinc-400 mb-1.5">
        Locators
        <span className="ml-2 normal-case tracking-normal text-zinc-400 dark:text-zinc-500 font-normal">
          room Δ · ⇄ in/out Δ
        </span>
      </div>
      <ul className="space-y-0.5">{primaryEntries.map(renderEntry)}</ul>

      {debugEntries.length > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/60">
          <button
            type="button"
            onClick={toggleShowAllDebug}
            className="w-full text-left text-[11px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 px-1.5 py-0.5"
          >
            Debug alternatives{" "}
            <span className="normal-case tracking-normal">
              ({debugEntries.length}) · {sectionOpen ? "hide all" : "show all"}
            </span>
          </button>
          {sectionOpen && (
            <ul className="space-y-0.5 mt-1">{debugEntries.map(renderEntry)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

interface LiveData {
  liveKeys: Set<string>;
  /** algorithm → mean distance (meters) from us, averaged over all devices weighted by sample count. */
  deltas: Map<string, number>;
  /** algorithm → fraction (0..1) of samples where this locator picked a different room than the active one. */
  disagreeRates: Map<string, number>;
  /** algorithm → fraction (0..1) of samples where one was inside a room and the other outside all rooms. */
  insideOutsideRates: Map<string, number>;
  /** algorithm → total samples across all devices. */
  sampleCounts: Map<string, number>;
}

/**
 * Poll positions, return the set of locators with live data plus
 * cross-device aggregated mean deltas and room-disagreement rates
 * (sample-weighted) and total sample counts. Polls only while compare
 * mode is on.
 */
function useLiveLocatorData(enabled: boolean): LiveData {
  const [data, setData] = useState<LiveData>({
    liveKeys: new Set(),
    deltas: new Map(),
    disagreeRates: new Map(),
    insideOutsideRates: new Map(),
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
        // Sum up sample×(mean|disagreeRate) and total samples per
        // algorithm so the displayed values are sample-weighted across
        // all devices.
        const deltaSums = new Map<string, number>();
        const disagreeSums = new Map<string, number>();
        const inOutSums = new Map<string, number>();
        const counts = new Map<string, number>();
        for (const d of j.devices) {
          if (d.alternatives) {
            for (const alt of d.alternatives) liveKeys.add(alt.algorithm);
          }
          if (d.upstreamPosition) liveKeys.add("upstream_companion");
          if (d.locatorDeltas) {
            for (const [algo, s] of Object.entries(d.locatorDeltas)) {
              deltaSums.set(algo, (deltaSums.get(algo) ?? 0) + s.mean * s.count);
              disagreeSums.set(
                algo,
                (disagreeSums.get(algo) ?? 0) + (s.disagreeRate ?? 0) * s.count,
              );
              inOutSums.set(
                algo,
                (inOutSums.get(algo) ?? 0) + (s.insideOutsideRate ?? 0) * s.count,
              );
              counts.set(algo, (counts.get(algo) ?? 0) + s.count);
            }
          }
        }
        const deltas = new Map<string, number>();
        const disagreeRates = new Map<string, number>();
        const insideOutsideRates = new Map<string, number>();
        for (const [algo, total] of counts) {
          if (total <= 0) continue;
          deltas.set(algo, (deltaSums.get(algo) ?? 0) / total);
          disagreeRates.set(algo, (disagreeSums.get(algo) ?? 0) / total);
          insideOutsideRates.set(algo, (inOutSums.get(algo) ?? 0) / total);
        }
        if (!cancelled) {
          setData({
            liveKeys,
            deltas,
            disagreeRates,
            insideOutsideRates,
            sampleCounts: counts,
          });
        }
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
