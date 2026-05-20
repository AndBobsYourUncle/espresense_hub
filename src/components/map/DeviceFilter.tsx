"use client";

import { useMemo } from "react";
import { Filter, X } from "lucide-react";
import { useMapTool } from "./MapToolProvider";
import { useDevicePositionsStream } from "./useDevicePositionsStream";

/**
 * Device filter dropdown. When set, the map hides every device
 * except the selected one — makes per-device diagnostics (cascade
 * rings, locator comparisons, etc.) readable without clutter.
 *
 * Renders in the top-right of the map, self-contained. Stops click
 * propagation so clicking the dropdown doesn't trigger the map
 * background's deselect handler.
 */
export default function DeviceFilter() {
  const { filteredDeviceId, setFilteredDeviceId } = useMapTool();
  const { devices } = useDevicePositionsStream();

  // Sort alphabetically by display name so the dropdown is stable
  // and easy to scan. Stale devices (not seen recently) are still
  // included so the user can un-filter from a stale selection.
  const sorted = useMemo(
    () =>
      [...devices].sort((a, b) => {
        const an = (a.name ?? a.id).toLowerCase();
        const bn = (b.name ?? b.id).toLowerCase();
        return an.localeCompare(bn);
      }),
    [devices],
  );

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute top-4 right-4 z-10 flex items-center gap-2"
    >
      <div className="relative flex items-center gap-1.5 rounded-lg bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-sm pl-2 pr-1 py-1">
        <Filter className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
        <select
          value={filteredDeviceId ?? ""}
          onChange={(e) => setFilteredDeviceId(e.target.value || null)}
          className="bg-transparent text-xs text-zinc-700 dark:text-zinc-200 focus:outline-none pr-6 appearance-none cursor-pointer max-w-[200px]"
          aria-label="Filter devices shown on map"
        >
          <option value="">All devices</option>
          {sorted.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name ?? d.id}
            </option>
          ))}
        </select>
        {filteredDeviceId && (
          <button
            type="button"
            onClick={() => setFilteredDeviceId(null)}
            title="Clear filter"
            className="h-5 w-5 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
