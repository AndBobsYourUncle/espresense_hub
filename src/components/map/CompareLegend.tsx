"use client";

import { LOCATOR_COLORS, LOCATOR_LABELS } from "./locatorColors";
import { useMapTool } from "./MapToolProvider";

/**
 * Floating legend shown in the bottom-right of the map when compare mode
 * is active. Lists each locator with its color swatch so the user can
 * tell which ghost marker came from which algorithm. The active locator
 * (room_aware) is highlighted so it's clear which one is the "real"
 * device position.
 */
export default function CompareLegend() {
  const { compareMode } = useMapTool();
  if (!compareMode) return null;

  // Active first; then derive everything else from LOCATOR_LABELS so adding
  // a new locator only requires updating locatorColors.ts.
  const ACTIVE = "room_aware";
  const entries: Array<{ key: string; label: string; color: string }> = [
    {
      key: ACTIVE,
      label: `${LOCATOR_LABELS[ACTIVE]} (active)`,
      color: LOCATOR_COLORS[ACTIVE],
    },
    ...Object.keys(LOCATOR_LABELS)
      .filter((k) => k !== ACTIVE)
      .map((k) => ({
        key: k,
        label: LOCATOR_LABELS[k],
        color: LOCATOR_COLORS[k],
      })),
  ];

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 right-4 z-10 rounded-lg bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-sm p-2.5 min-w-[140px]"
      aria-label="Locator legend"
    >
      <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500 dark:text-zinc-400 mb-1.5">
        Locators
      </div>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li
            key={e.key}
            className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300"
          >
            <span
              className="inline-block w-3 h-3 rounded-full border border-white/50 dark:border-zinc-800 shrink-0"
              style={{ backgroundColor: e.color }}
            />
            <span>{e.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
