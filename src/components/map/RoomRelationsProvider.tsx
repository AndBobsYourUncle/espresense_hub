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

interface RoomRelationsContextValue {
  /** Floor id of the room being edited, or null if not editing. */
  editingFloorId: string | null;
  /** Room id being edited, or null if not editing. */
  editingRoomId: string | null;
  /** Room name for display purposes. */
  editingRoomName: string | null;
  /** Draft value for `open_to` — room ids connected to the editing room. */
  draftOpenTo: string[];
  /** Draft value for `floor_area` tag. */
  draftFloorArea: string;
  /** True while a save is in flight. */
  saving: boolean;
  /** Last save error, or null. */
  error: string | null;
  /** Open the editor for a room, seeded from its current values. */
  startEditing: (floorId: string, room: Room) => void;
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

  const cancel = useCallback(() => {
    setEditingFloorId(null);
    setEditingRoomId(null);
    setEditingRoomName(null);
    setDraftOpenTo([]);
    setDraftFloorArea("");
    setError(null);
  }, []);

  // Reset when the tool is deactivated.
  useEffect(() => {
    if (activeTool !== "room-relations") cancel();
  }, [activeTool, cancel]);

  const startEditing = useCallback((floorId: string, room: Room) => {
    const id = room.id ?? null;
    if (!id) return;
    setEditingFloorId(floorId);
    setEditingRoomId(id);
    setEditingRoomName(room.name ?? id);
    setDraftOpenTo(room.open_to ?? []);
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
    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(editingFloorId)}/${encodeURIComponent(editingRoomId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            open_to: draftOpenTo,
            floor_area: draftFloorArea.trim() || null,
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
  }, [editingFloorId, editingRoomId, draftOpenTo, draftFloorArea, cancel, router]);

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
