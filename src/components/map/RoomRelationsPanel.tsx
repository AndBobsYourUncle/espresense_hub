"use client";

import { useMemo } from "react";
import { Crosshair, Network, Save, X } from "lucide-react";
import { useDraggable } from "@/lib/hooks/useDraggable";
import type { Floor } from "@/lib/config";
import { useMapTool } from "./MapToolProvider";
import { useRoomRelations } from "./RoomRelationsProvider";

interface Props {
  floor: Floor;
}

const DATALIST_ID = "room-floor-area-tags";

export default function RoomRelationsPanel({ floor }: Props) {
  const { activeTool } = useMapTool();
  const {
    editingRoomId,
    editingRoomName,
    draftOpenTo,
    draftDoors,
    draftFloorArea,
    doorPlacingForRoom,
    saving,
    error,
    toggleOpenTo,
    setFloorArea,
    setDoor,
    startDoorPlacing,
    stopDoorPlacing,
    save,
    cancel,
  } = useRoomRelations();

  const { pos, handlers } = useDraggable({ x: 0, y: 0 });

  // Collect unique floor_area tags from all rooms on this floor so the
  // datalist can offer them as suggestions.
  const existingTags = useMemo(() => {
    const tags = new Set<string>();
    for (const room of floor.rooms) {
      if (room.floor_area) tags.add(room.floor_area);
    }
    return [...tags].sort();
  }, [floor.rooms]);


  if (activeTool !== "room-relations" || !editingRoomId) return null;

  const otherRooms = floor.rooms.filter((r) => r.id && r.id !== editingRoomId);

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
          <Network className="h-3.5 w-3.5" />
          Room Relations
        </div>
        {editingRoomId && (
          <button
            type="button"
            onClick={cancel}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
            aria-label="Close editor"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col overflow-auto">
          {/* Room name */}
          <div className="px-4 pt-3 pb-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {editingRoomName}
            </div>
            <div className="text-xs text-zinc-400 mt-0.5">
              Click other rooms on the map to toggle doorway connections
            </div>
          </div>

          {/* floor_area — datalist gives dropdown of existing tags + free-form new entry */}
          <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
            <label
              htmlFor="floor-area-input"
              className="block text-xs uppercase tracking-wide text-zinc-400 mb-1.5"
            >
              Floor area group
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="floor-area-input"
                type="text"
                list={DATALIST_ID}
                value={draftFloorArea}
                onChange={(e) => setFloorArea(e.target.value)}
                placeholder={
                  existingTags.length > 0
                    ? "Pick existing or type new…"
                    : "e.g. main_living (optional)"
                }
                className="flex-1 h-8 px-2.5 text-sm bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {draftFloorArea && (
                <button
                  type="button"
                  onClick={() => setFloorArea("")}
                  title="Clear"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <datalist id={DATALIST_ID}>
              {existingTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">
              Rooms sharing the same group are treated as mutually open —
              great for kitchen/dining/living combos.
            </p>
          </div>

          {/* open_to checklist */}
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="px-4 pt-3 pb-1">
              <div className="text-xs uppercase tracking-wide text-zinc-400">
                Open to (doorways)
              </div>
            </div>

            {/* Door placement hint */}
            {doorPlacingForRoom && (
              <div className="mx-4 mb-2 px-2.5 py-1.5 rounded-md bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 flex items-center gap-2">
                <Crosshair className="h-3 w-3 text-sky-500 shrink-0" />
                <span className="text-xs text-sky-700 dark:text-sky-300">
                  Click the doorway on the map
                </span>
                <button
                  type="button"
                  onClick={stopDoorPlacing}
                  className="ml-auto h-4 w-4 inline-flex items-center justify-center rounded text-sky-400 hover:text-sky-700 dark:hover:text-sky-200"
                  aria-label="Cancel door placement"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {otherRooms.length === 0 ? (
              <div className="px-4 py-2 text-xs text-zinc-400">
                No other rooms on this floor.
              </div>
            ) : (
              otherRooms.map((room) => {
                const rid = room.id!;
                const checked = draftOpenTo.includes(rid);
                const hasDoor = Boolean(draftDoors[rid]);
                const isPlacing = doorPlacingForRoom === rid;
                return (
                  <div
                    key={rid}
                    className="flex items-center gap-2 px-4 py-2 border-t border-zinc-100 dark:border-zinc-800/60 first:border-t-0"
                  >
                    <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOpenTo(rid)}
                        className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 shrink-0"
                      />
                      <span className="text-sm text-zinc-900 dark:text-zinc-100 truncate">
                        {room.name ?? rid}
                      </span>
                    </label>
                    {/* Show same-group badge */}
                    {room.floor_area && room.floor_area === draftFloorArea && !checked && (
                      <span className="text-xs text-zinc-400 font-mono shrink-0">
                        same group
                      </span>
                    )}
                    {/* Door placement button — only for connected rooms */}
                    {checked && (
                      <button
                        type="button"
                        title={hasDoor ? "Reposition door on map" : "Mark door position on map"}
                        onClick={() => isPlacing ? stopDoorPlacing() : startDoorPlacing(rid)}
                        className={`h-6 w-6 inline-flex items-center justify-center rounded-md shrink-0 transition-colors ${
                          isPlacing
                            ? "bg-sky-100 dark:bg-sky-900/50 text-sky-600 dark:text-sky-400"
                            : hasDoor
                            ? "text-sky-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            : "text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        }`}
                        aria-pressed={isPlacing}
                      >
                        <Crosshair className="h-3 w-3" />
                      </button>
                    )}
                    {/* Clear door button — only when a door is set and not placing */}
                    {checked && hasDoor && !isPlacing && (
                      <button
                        type="button"
                        title="Clear door position"
                        onClick={() => setDoor(rid, null)}
                        className="h-6 w-6 inline-flex items-center justify-center rounded-md shrink-0 text-zinc-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0 space-y-2">
            {error && (
              <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
            )}
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3 w-3" />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
    </div>
  );
}
