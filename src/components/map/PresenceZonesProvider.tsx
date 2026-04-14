"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { PresenceZone } from "@/lib/config/schema";
import { slugify } from "@/lib/config/schema";
import { useMapTool } from "./MapToolProvider";

/** Hex fill colors cycled by zone index. */
export const ZONE_COLORS = [
  "#3b82f6", // blue-500
  "#22c55e", // green-500
  "#f59e0b", // amber-500
  "#a855f7", // purple-500
  "#ef4444", // red-500
  "#06b6d4", // cyan-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
];

interface PresenceZonesContextValue {
  /** The zone currently being edited, or null if none selected. */
  selectedZoneId: string | null;
  /** Full draft zones array (all zones, edited in memory). */
  draftZones: PresenceZone[];
  /** True while a save is in flight. */
  saving: boolean;
  /** Last save error, or null. */
  error: string | null;
  /** Select a zone to edit. */
  selectZone: (id: string | null) => void;
  /** Toggle a room id in/out of the selected zone's rooms list. */
  toggleRoom: (roomId: string) => void;
  /** Add a new zone with the given label, auto-generate id from label. */
  addZone: (label: string) => void;
  /** Remove a zone by id. */
  removeZone: (id: string) => void;
  /** Persist all draft zones to config.yaml. */
  save: () => Promise<void>;
  /** Discard changes and reset to last-saved state. */
  cancel: () => void;
}

const PresenceZonesContext = createContext<PresenceZonesContextValue | null>(null);

export function usePresenceZones(): PresenceZonesContextValue {
  const ctx = useContext(PresenceZonesContext);
  if (!ctx) {
    throw new Error("usePresenceZones must be used inside <PresenceZonesProvider>");
  }
  return ctx;
}

export default function PresenceZonesProvider({
  children,
  initialZones,
}: {
  children: React.ReactNode;
  initialZones: PresenceZone[];
}) {
  const router = useRouter();
  const { activeTool } = useMapTool();

  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(
    initialZones[0]?.id ?? null,
  );
  const [draftZones, setDraftZones] = useState<PresenceZone[]>(initialZones);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync when the server re-renders with new initialZones after router.refresh().
  const initialZonesKey = JSON.stringify(initialZones);
  useEffect(() => {
    setDraftZones(initialZones);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialZonesKey]);

  const cancel = useCallback(() => {
    setDraftZones(initialZones);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialZonesKey]);

  // Clear error when the tool is deactivated.
  useEffect(() => {
    if (activeTool !== "presence-zones") setError(null);
  }, [activeTool]);

  const selectZone = useCallback((id: string | null) => {
    setSelectedZoneId(id);
    setError(null);
  }, []);

  const toggleRoom = useCallback((roomId: string) => {
    setDraftZones((prev) =>
      prev.map((z) => {
        if (z.id !== selectedZoneId) return z;
        const inZone = z.rooms.includes(roomId);
        return {
          ...z,
          rooms: inZone ? z.rooms.filter((r) => r !== roomId) : [...z.rooms, roomId],
        };
      }),
    );
  }, [selectedZoneId]);

  const addZone = useCallback((label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setDraftZones((prev) => {
      const baseId = slugify(trimmed) || "zone";
      // Ensure unique id within the current draft.
      let id = baseId;
      let n = 2;
      while (prev.some((z) => z.id === id)) id = `${baseId}_${n++}`;
      const newZone: PresenceZone = {
        id,
        label: trimmed,
        rooms: [],
      };
      // Auto-select the new zone so the user can immediately assign rooms.
      setSelectedZoneId(id);
      return [...prev, newZone];
    });
  }, []);

  const removeZone = useCallback((idToRemove: string) => {
    setDraftZones((prev) => {
      const next = prev.filter((z) => z.id !== idToRemove);
      setSelectedZoneId((sel) => {
        if (sel !== idToRemove) return sel;
        return next[0]?.id ?? null;
      });
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/presence/zones", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zones: draftZones }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? "request failed");
    } finally {
      setSaving(false);
    }
  }, [draftZones, router]);

  return (
    <PresenceZonesContext.Provider
      value={{
        selectedZoneId,
        draftZones,
        saving,
        error,
        selectZone,
        toggleRoom,
        addZone,
        removeZone,
        save,
        cancel,
      }}
    >
      {children}
    </PresenceZonesContext.Provider>
  );
}
