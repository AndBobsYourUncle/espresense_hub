"use client";

import { Network, Save, X } from "lucide-react";
import { useDraggable } from "@/lib/hooks/useDraggable";
import type { Floor } from "@/lib/config";
import { useMapTool } from "./MapToolProvider";
import { useRoomRelations } from "./RoomRelationsProvider";

interface Props {
  floor: Floor;
}

/**
 * Floating panel for the Room Relations tool. Shows when the tool is active.
 *
 * - Before a room is selected: instructs the user to click a room.
 * - After a room is selected: shows a checklist of all other rooms on the
 *   floor (for `open_to`) and a text field for the `floor_area` tag.
 */
export default function RoomRelationsPanel({ floor }: Props) {
  const { activeTool } = useMapTool();
  const {
    editingRoomId,
    editingRoomName,
    draftOpenTo,
    draftFloorArea,
    saving,
    error,
    toggleOpenTo,
    setFloorArea,
    save,
    cancel,
  } = useRoomRelations();

  const { pos, handlers } = useDraggable({ x: 0, y: 0 });

  if (activeTool !== "room-relations") return null;

  // All rooms except the one being edited — candidates for open_to.
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
      {!editingRoomId ? (
        <div className="p-4 text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
          Click a room on the map to edit its connections and floor-area tag.
        </div>
      ) : (
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

          {/* floor_area */}
          <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
            <label className="block text-xs uppercase tracking-wide text-zinc-400 mb-1.5">
              Floor area tag
            </label>
            <input
              type="text"
              value={draftFloorArea}
              onChange={(e) => setFloorArea(e.target.value)}
              placeholder="e.g. main_living (optional)"
              className="w-full h-8 px-2.5 text-sm bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Rooms sharing the same tag are treated as mutually open — great for open-plan kitchen/dining/living.
            </p>
          </div>

          {/* open_to checklist */}
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="px-4 pt-3 pb-1">
              <div className="text-xs uppercase tracking-wide text-zinc-400">
                Open to (doorways)
              </div>
            </div>
            {otherRooms.length === 0 ? (
              <div className="px-4 py-2 text-xs text-zinc-400">
                No other rooms on this floor.
              </div>
            ) : (
              otherRooms.map((room) => {
                const rid = room.id!;
                const checked = draftOpenTo.includes(rid);
                return (
                  <label
                    key={rid}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer border-t border-zinc-100 dark:border-zinc-800/60 first:border-t-0"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOpenTo(rid)}
                      className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <span className="text-sm text-zinc-900 dark:text-zinc-100 truncate">
                      {room.name ?? rid}
                    </span>
                  </label>
                );
              })
            )}
          </div>

          {/* Footer: error + save */}
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
      )}
    </div>
  );
}
