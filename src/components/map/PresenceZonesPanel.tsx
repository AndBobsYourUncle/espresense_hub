"use client";

import { useRef, useState } from "react";
import { Layers, Plus, Save, Trash2 } from "lucide-react";
import { useDraggable } from "@/lib/hooks/useDraggable";
import type { Floor } from "@/lib/config";
import { useMapTool } from "./MapToolProvider";
import { usePresenceZones, ZONE_COLORS } from "./PresenceZonesProvider";

interface Props {
  floor: Floor;
}

export default function PresenceZonesPanel({ floor }: Props) {
  const { activeTool } = useMapTool();
  const {
    selectedZoneId,
    draftZones,
    saving,
    error,
    selectZone,
    addZone,
    removeZone,
    save,
    cancel,
  } = usePresenceZones();

  const { pos, handlers } = useDraggable({ x: 0, y: 0 });
  const [newLabel, setNewLabel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  if (activeTool !== "presence-zones") return null;

  const selectedZone = draftZones.find((z) => z.id === selectedZoneId);

  const roomLabel = (id: string): string => {
    const room = floor.rooms.find((r) => r.id === id || r.name === id);
    return room?.name ?? room?.id ?? id;
  };

  const handleAdd = () => {
    if (!newLabel.trim()) return;
    addZone(newLabel);
    setNewLabel("");
    inputRef.current?.focus();
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
        className="h-10 px-4 flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 cursor-grab active:cursor-grabbing select-none"
      >
        <Layers className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
        <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium">
          Presence Zones
        </span>
      </header>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Zone list */}
        <div className="p-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 space-y-0.5">
          {draftZones.length === 0 && (
            <p className="px-2 py-1 text-xs text-zinc-400">
              No zones yet — add one below.
            </p>
          )}
          {draftZones.map((zone, i) => {
            const color = ZONE_COLORS[i % ZONE_COLORS.length];
            const isSelected = zone.id === selectedZoneId;
            return (
              <div
                key={zone.id}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                  isSelected
                    ? "bg-zinc-100 dark:bg-zinc-800"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectZone(zone.id)}
                  className="flex-1 flex items-center gap-2 text-left min-w-0"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className={`text-sm font-medium truncate ${
                      isSelected
                        ? "text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    {zone.label ?? zone.id}
                  </span>
                  <span className="ml-auto text-xs text-zinc-400 shrink-0">
                    {zone.rooms.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeZone(zone.id)}
                  title={`Delete ${zone.label ?? zone.id}`}
                  className="opacity-0 group-hover:opacity-100 h-5 w-5 inline-flex items-center justify-center rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-opacity shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          {/* Add zone form */}
          <div className="flex items-center gap-1.5 pt-1">
            <input
              ref={inputRef}
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
              }}
              placeholder="New zone name…"
              className="flex-1 h-7 px-2 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newLabel.trim()}
              title="Add zone"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Selected zone room membership */}
        {selectedZone && (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="px-4 pt-3 pb-1">
              <div className="text-xs uppercase tracking-wide text-zinc-400">
                {selectedZone.label ?? selectedZone.id} · tap rooms on map
              </div>
            </div>
            {selectedZone.rooms.length === 0 ? (
              <p className="px-4 py-1 text-xs text-zinc-400">
                No rooms assigned yet.
              </p>
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
              className="flex-1 h-8 inline-flex items-center justify-center rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
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
    </div>
  );
}
