"use client";

import { Layers, Save } from "lucide-react";
import { useDraggable } from "@/lib/hooks/useDraggable";
import type { Floor } from "@/lib/config";
import { useMapTool } from "./MapToolProvider";
import { usePresenceZones, ZONE_COLORS } from "./PresenceZonesProvider";

interface Props {
  floor: Floor;
}

/**
 * Floating panel for the Presence Zones tool.
 *
 * Shows all configured zones as a list. Selecting one highlights its rooms
 * on the map and lets the user click rooms to toggle membership. Save
 * commits all changes to config.yaml at once.
 */
export default function PresenceZonesPanel({ floor }: Props) {
  const { activeTool } = useMapTool();
  const {
    selectedZoneId,
    draftZones,
    saving,
    error,
    selectZone,
    save,
    cancel,
  } = usePresenceZones();

  const { pos, handlers } = useDraggable({ x: 0, y: 0 });

  if (activeTool !== "presence-zones") return null;

  const selectedZone = draftZones.find((z) => z.id === selectedZoneId);

  // Build a room display name map from the floor.
  const roomLabel = (id: string): string => {
    const room = floor.rooms.find((r) => r.id === id || r.name === id);
    return room?.name ?? room?.id ?? id;
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      className="absolute z-10 inset-x-2 top-2 max-h-[calc(100%-1rem)] sm:inset-auto sm:top-16 sm:left-4 sm:w-[300px] sm:max-w-[90vw] sm:max-h-[calc(100%-5rem)] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg flex flex-col"
    >
      {/* Header */}
      <header
        {...handlers}
        className="h-10 px-4 flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 shrink-0 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium">
          <Layers className="h-3.5 w-3.5" />
          Presence Zones
        </div>
      </header>

      {/* Body */}
      {draftZones.length === 0 ? (
        <div className="p-4 space-y-1">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">No zones defined.</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Add presence zones in the Settings page, then come back here to assign rooms.
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Zone selector */}
          <div className="p-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 space-y-0.5">
            {draftZones.map((zone, i) => {
              const color = ZONE_COLORS[i % ZONE_COLORS.length];
              const isSelected = zone.id === selectedZoneId;
              return (
                <button
                  key={zone.id}
                  type="button"
                  onClick={() => selectZone(zone.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                    isSelected
                      ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  }`}
                >
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="font-medium truncate">{zone.label ?? zone.id}</span>
                  <span className="ml-auto text-xs text-zinc-400 shrink-0">
                    {zone.rooms.length} room{zone.rooms.length === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Selected zone details */}
          {selectedZone && (
            <div className="flex-1 min-h-0 overflow-auto">
              <div className="px-4 pt-3 pb-1 shrink-0">
                <div className="text-xs uppercase tracking-wide text-zinc-400">
                  Click rooms on the map to toggle
                </div>
              </div>
              {selectedZone.rooms.length === 0 ? (
                <div className="px-4 py-2 text-xs text-zinc-400">
                  No rooms assigned — click any room on the map to add it.
                </div>
              ) : (
                <div className="px-4 pb-2 space-y-1">
                  {selectedZone.rooms.map((rid) => (
                    <div
                      key={rid}
                      className="text-sm text-zinc-700 dark:text-zinc-300 flex items-center gap-2"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 shrink-0" />
                      {roomLabel(rid)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0 space-y-2">
            {error && (
              <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={saving}
                className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
              >
                Revert
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="h-3 w-3" />
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
