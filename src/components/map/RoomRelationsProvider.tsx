"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { Room } from "@/lib/config";
import { useMapTool } from "./MapToolProvider";

/** Resolve a label (id or name) to the canonical room id. */
function resolveRoomId(label: string, allRooms: Room[]): string {
  for (const r of allRooms) {
    if (!r.id) continue;
    if (r.id === label || r.name === label) return r.id;
  }
  return label; // pass through if no match
}

interface RoomRelationsContextValue {
  /** Floor id of the room being edited, or null if not editing. */
  editingFloorId: string | null;
  /** Room id being edited, or null if not editing. */
  editingRoomId: string | null;
  /** Room name for display purposes. */
  editingRoomName: string | null;
  /**
   * Draft effective connection set — room ids that are connected to the
   * editing room, whether stored in this room's `open_to` or as a reverse
   * reference in the other room's `open_to`.
   */
  draftOpenTo: string[];
  /** Draft value for `floor_area` tag. */
  draftFloorArea: string;
  /** True while a save is in flight. */
  saving: boolean;
  /** Last save error, or null. */
  error: string | null;
  /** Open the editor for a room, seeded from its current values. */
  startEditing: (floorId: string, room: Room, allRooms: Room[]) => void;
  /** Toggle a room id in/out of draftOpenTo. */
  toggleOpenTo: (roomId: string) => void;
  /** Update the floor_area tag. */
  setFloorArea: (val: string) => void;
  /** Persist the draft to config.yaml. */
  save: () => Promise<void>;
  /** Discard the draft and close the editor. */
  cancel: () => void;
}

const RoomRelationsContext = createContext<RoomRelationsContextValue | null>(null);

export function useRoomRelations(): RoomRelationsContextValue {
  const ctx = useContext(RoomRelationsContext);
  if (!ctx) {
    throw new Error("useRoomRelations must be used inside <RoomRelationsProvider>");
  }
  return ctx;
}

export default function RoomRelationsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { activeTool } = useMapTool();

  const [editingFloorId, setEditingFloorId] = useState<string | null>(null);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingRoomName, setEditingRoomName] = useState<string | null>(null);
  const [draftOpenTo, setDraftOpenTo] = useState<string[]>([]);
  const [draftFloorArea, setDraftFloorArea] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Room ids that had the editing room in THEIR `open_to` at load time
   * (reverse references). Tracked so that on save we can remove the
   * editing room from their `open_to` when the user unchecks them.
   */
  const [initialReverseRefs, setInitialReverseRefs] = useState<string[]>([]);

  const cancel = useCallback(() => {
    setEditingFloorId(null);
    setEditingRoomId(null);
    setEditingRoomName(null);
    setDraftOpenTo([]);
    setDraftFloorArea("");
    setInitialReverseRefs([]);
    setError(null);
  }, []);

  // Reset when the tool is deactivated.
  useEffect(() => {
    if (activeTool !== "room-relations") cancel();
  }, [activeTool, cancel]);

  const startEditing = useCallback((floorId: string, room: Room, allRooms: Room[]) => {
    const id = room.id ?? null;
    if (!id) return;

    // Normalize own open_to labels to room IDs.
    const ownOpenTo = new Set(
      (room.open_to ?? []).map((label) => resolveRoomId(label, allRooms)),
    );

    // Find rooms that list this room in THEIR open_to (reverse references).
    const reverseRefs: string[] = [];
    for (const r of allRooms) {
      if (!r.id || r.id === id) continue;
      const hasRef = (r.open_to ?? []).some(
        (label) => resolveRoomId(label, allRooms) === id,
      );
      if (hasRef) reverseRefs.push(r.id);
    }

    // Effective connection set = own + reverse (deduplicated).
    const effective = [...ownOpenTo];
    for (const rid of reverseRefs) {
      if (!ownOpenTo.has(rid)) effective.push(rid);
    }

    setEditingFloorId(floorId);
    setEditingRoomId(id);
    setEditingRoomName(room.name ?? id);
    setDraftOpenTo(effective);
    setInitialReverseRefs(reverseRefs);
    setDraftFloorArea(room.floor_area ?? "");
    setError(null);
  }, []);

  const toggleOpenTo = useCallback((roomId: string) => {
    setDraftOpenTo((prev) =>
      prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId],
    );
  }, []);

  const setFloorArea = useCallback((val: string) => {
    setDraftFloorArea(val);
  }, []);

  const save = useCallback(async () => {
    if (!editingFloorId || !editingRoomId) return;
    setSaving(true);
    setError(null);

    // Which reverse-ref rooms did the user uncheck? Those rooms currently
    // have `editingRoomId` in their own `open_to` and need it removed so
    // the connection is fully gone rather than persisting from the other side.
    const removeFromRooms = initialReverseRefs.filter(
      (rid) => !draftOpenTo.includes(rid),
    );

    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(editingFloorId)}/${encodeURIComponent(editingRoomId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            open_to: draftOpenTo,
            floor_area: draftFloorArea.trim() || null,
            remove_from_rooms: removeFromRooms,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `request failed (${res.status})`);
        return;
      }
      cancel();
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? "request failed");
    } finally {
      setSaving(false);
    }
  }, [editingFloorId, editingRoomId, draftOpenTo, draftFloorArea, initialReverseRefs, cancel, router]);

  // ESC to cancel.
  useEffect(() => {
    if (!editingRoomId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editingRoomId, cancel]);

  return (
    <RoomRelationsContext.Provider
      value={{
        editingFloorId,
        editingRoomId,
        editingRoomName,
        draftOpenTo,
        draftFloorArea,
        saving,
        error,
        startEditing,
        toggleOpenTo,
        setFloorArea,
        save,
        cancel,
      }}
    >
      {children}
    </RoomRelationsContext.Provider>
  );
}
