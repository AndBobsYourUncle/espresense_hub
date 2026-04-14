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
import { openToId, openToDoor, openToWidth } from "@/lib/config/schema";
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
  /** Draft door positions keyed by connected room id. */
  draftDoors: Record<string, [number, number]>;
  /**
   * Draft door widths keyed by connected room id, in metres. Missing key =
   * use the default (~0.8 m standard interior door). Override for wider
   * openings (sliding glass, archways, etc.).
   */
  draftWidths: Record<string, number>;
  /** Draft value for `floor_area` tag. */
  draftFloorArea: string;
  /**
   * When non-null, the user is in door-placement mode: the next map click
   * will record the door position for this room id.
   */
  doorPlacingForRoom: string | null;
  /** True while a save is in flight. */
  saving: boolean;
  /** Last save error, or null. */
  error: string | null;
  /** Open the editor for a room, seeded from its current values. */
  startEditing: (floorId: string, room: Room, allRooms: Room[]) => void;
  /** Toggle a room id in/out of draftOpenTo. Clearing a connection also removes its door. */
  toggleOpenTo: (roomId: string) => void;
  /** Update the floor_area tag. */
  setFloorArea: (val: string) => void;
  /** Record or clear a door position for a connected room. Pass null to remove. */
  setDoor: (roomId: string, pos: [number, number] | null) => void;
  /** Record or clear a door width override for a connected room. Pass null to clear. */
  setWidth: (roomId: string, width: number | null) => void;
  /** Enter door-placement mode for a connected room. */
  startDoorPlacing: (roomId: string) => void;
  /** Exit door-placement mode without placing. */
  stopDoorPlacing: () => void;
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
  const [draftDoors, setDraftDoors] = useState<Record<string, [number, number]>>({});
  const [draftWidths, setDraftWidths] = useState<Record<string, number>>({});
  const [draftFloorArea, setDraftFloorArea] = useState<string>("");
  const [doorPlacingForRoom, setDoorPlacingForRoom] = useState<string | null>(null);
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
    setDraftDoors({});
    setDraftWidths({});
    setDraftFloorArea("");
    setDoorPlacingForRoom(null);
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

    // Normalize own open_to labels to room IDs, and collect any stored door
    // positions and width overrides.
    const ownOpenTo = new Set<string>();
    const doors: Record<string, [number, number]> = {};
    const widths: Record<string, number> = {};
    for (const entry of room.open_to ?? []) {
      const resolvedId = resolveRoomId(openToId(entry), allRooms);
      ownOpenTo.add(resolvedId);
      const door = openToDoor(entry);
      if (door) doors[resolvedId] = door;
      const width = openToWidth(entry);
      if (width != null) widths[resolvedId] = width;
    }

    // Find rooms that list this room in THEIR open_to (reverse references).
    // Also pull in any door position or width stored on their side.
    const reverseRefs: string[] = [];
    for (const r of allRooms) {
      if (!r.id || r.id === id) continue;
      for (const entry of r.open_to ?? []) {
        if (resolveRoomId(openToId(entry), allRooms) !== id) continue;
        reverseRefs.push(r.id);
        // Mirror the door position/width if the other room stored them and
        // we don't already have our own from our side of the edge.
        const door = openToDoor(entry);
        if (door && !doors[r.id]) doors[r.id] = door;
        const width = openToWidth(entry);
        if (width != null && widths[r.id] == null) widths[r.id] = width;
        break;
      }
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
    setDraftDoors(doors);
    setDraftWidths(widths);
    setInitialReverseRefs(reverseRefs);
    setDraftFloorArea(room.floor_area ?? "");
    setDoorPlacingForRoom(null);
    setError(null);
  }, []);

  const toggleOpenTo = useCallback((roomId: string) => {
    setDraftOpenTo((prev) => {
      if (prev.includes(roomId)) {
        // Removing connection — clear its door position and width too.
        setDraftDoors((d) => {
          if (!d[roomId]) return d;
          const next = { ...d };
          delete next[roomId];
          return next;
        });
        setDraftWidths((w) => {
          if (w[roomId] == null) return w;
          const next = { ...w };
          delete next[roomId];
          return next;
        });
        if (doorPlacingForRoom === roomId) setDoorPlacingForRoom(null);
        return prev.filter((id) => id !== roomId);
      }
      return [...prev, roomId];
    });
  }, [doorPlacingForRoom]);

  const setFloorArea = useCallback((val: string) => {
    setDraftFloorArea(val);
  }, []);

  const setDoor = useCallback((roomId: string, pos: [number, number] | null) => {
    setDraftDoors((prev) => {
      if (pos === null) {
        if (!prev[roomId]) return prev;
        const next = { ...prev };
        delete next[roomId];
        return next;
      }
      return { ...prev, [roomId]: pos };
    });
    // Clearing the door also drops any width override — width has no
    // meaning without a placement.
    if (pos === null) {
      setDraftWidths((prev) => {
        if (prev[roomId] == null) return prev;
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
    }
    setDoorPlacingForRoom(null); // exit door-placement mode after a placement
  }, []);

  const setWidth = useCallback((roomId: string, width: number | null) => {
    setDraftWidths((prev) => {
      if (width == null || !Number.isFinite(width)) {
        if (prev[roomId] == null) return prev;
        const next = { ...prev };
        delete next[roomId];
        return next;
      }
      return { ...prev, [roomId]: width };
    });
  }, []);

  const startDoorPlacing = useCallback((roomId: string) => {
    setDoorPlacingForRoom(roomId);
  }, []);

  const stopDoorPlacing = useCallback(() => {
    setDoorPlacingForRoom(null);
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

    // Build open_to entries — plain string when no door/width override,
    // object form when either is set. Width is only meaningful alongside a
    // door (it sizes the swing arc placed there), so we only include it
    // when door is also present.
    const openToEntries = draftOpenTo.map((rid) => {
      const door = draftDoors[rid];
      const width = draftWidths[rid];
      if (!door) return rid;
      return width != null ? { id: rid, door, width } : { id: rid, door };
    });

    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(editingFloorId)}/${encodeURIComponent(editingRoomId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            open_to: openToEntries,
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
  }, [editingFloorId, editingRoomId, draftOpenTo, draftDoors, draftWidths, draftFloorArea, initialReverseRefs, cancel, router]);

  // ESC: first exit door-placement mode; second press cancels editing.
  useEffect(() => {
    if (!editingRoomId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (doorPlacingForRoom) {
        setDoorPlacingForRoom(null);
      } else {
        cancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editingRoomId, doorPlacingForRoom, cancel]);

  return (
    <RoomRelationsContext.Provider
      value={{
        editingFloorId,
        editingRoomId,
        editingRoomName,
        draftOpenTo,
        draftDoors,
        draftWidths,
        draftFloorArea,
        doorPlacingForRoom,
        saving,
        error,
        startEditing,
        toggleOpenTo,
        setFloorArea,
        setDoor,
        setWidth,
        startDoorPlacing,
        stopDoorPlacing,
        save,
        cancel,
      }}
    >
      {children}
    </RoomRelationsContext.Provider>
  );
}
