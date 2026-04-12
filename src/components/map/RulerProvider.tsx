"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { WallRef } from "@/lib/map/geometry";

export interface SavedMeasurement {
  id: string;
  /** Display label (e.g. "master_bedroom → master_bathroom" or "Wall: Master Bathroom"). */
  label: string;
  configDistance: number;
  actualDistance: number;
  timestamp: number;
}

interface RulerContextValue {
  // ---------- Pair measurement (node-to-node) ----------
  /** 0–2 node ids in click order — the in-progress pair measurement. */
  rulerNodes: readonly string[];
  toggleNode: (id: string) => void;
  /** Clear all in-progress state (pair selection AND wall pick). */
  clear: () => void;

  // ---------- Wall measurement ----------
  /** True while the user is picking a wall on the map. */
  wallPickerActive: boolean;
  /** The wall the user has picked, or null. */
  selectedWall: WallRef | null;
  /** Enter wall-picker mode (cancels any pair measurement). */
  startWallPicker: () => void;
  /** Leave wall-picker mode without selecting anything. */
  cancelWallPicker: () => void;
  /** Called by the picker overlay when a wall is clicked. */
  selectWall: (wall: WallRef) => void;

  // ---------- History ----------
  history: readonly SavedMeasurement[];
  addToHistory: (m: Omit<SavedMeasurement, "id" | "timestamp">) => void;
  removeFromHistory: (id: string) => void;
  clearHistory: () => void;
}

const STORAGE_KEY = "espresense-hub:ruler-history";

const RulerContext = createContext<RulerContextValue | null>(null);

export function useRuler(): RulerContextValue {
  const ctx = useContext(RulerContext);
  if (!ctx) {
    throw new Error("useRuler must be used inside <RulerProvider>");
  }
  return ctx;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Migrate older history entries (which had aName/bName) to the new label form. */
type LegacyMeasurement = SavedMeasurement & {
  aName?: string;
  bName?: string;
};
function migrateMeasurement(raw: LegacyMeasurement): SavedMeasurement {
  if (raw.label) return raw;
  if (raw.aName && raw.bName) {
    return { ...raw, label: `${raw.aName} → ${raw.bName}` };
  }
  return { ...raw, label: "Unknown" };
}

export default function RulerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [rulerNodes, setRulerNodes] = useState<readonly string[]>([]);
  const [wallPickerActive, setWallPickerActive] = useState(false);
  const [selectedWall, setSelectedWall] = useState<WallRef | null>(null);
  const [history, setHistory] = useState<readonly SavedMeasurement[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate history from localStorage on first mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setHistory(
            (parsed as LegacyMeasurement[]).map(migrateMeasurement),
          );
        }
      }
    } catch {
      // ignore corrupt storage
    }
    setHydrated(true);
  }, []);

  // Persist on changes (skip the initial load).
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      // ignore quota errors
    }
  }, [history, hydrated]);

  const toggleNode = useCallback((id: string) => {
    // Clicking a node cancels any wall pick in progress.
    setWallPickerActive(false);
    setSelectedWall(null);
    setRulerNodes((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [id];
      return [...prev, id];
    });
  }, []);

  const clear = useCallback(() => {
    setRulerNodes([]);
    setWallPickerActive(false);
    setSelectedWall(null);
  }, []);

  const startWallPicker = useCallback(() => {
    setRulerNodes([]);
    setSelectedWall(null);
    setWallPickerActive(true);
  }, []);

  const cancelWallPicker = useCallback(() => {
    setWallPickerActive(false);
    setSelectedWall(null);
  }, []);

  const selectWall = useCallback((wall: WallRef) => {
    setSelectedWall(wall);
  }, []);

  const addToHistory = useCallback(
    (m: Omit<SavedMeasurement, "id" | "timestamp">) => {
      setHistory((prev) => [
        { ...m, id: makeId(), timestamp: Date.now() },
        ...prev,
      ]);
    },
    [],
  );

  const removeFromHistory = useCallback((id: string) => {
    setHistory((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  return (
    <RulerContext.Provider
      value={{
        rulerNodes,
        toggleNode,
        clear,
        wallPickerActive,
        selectedWall,
        startWallPicker,
        cancelWallPicker,
        selectWall,
        history,
        addToHistory,
        removeFromHistory,
        clearHistory,
      }}
    >
      {children}
    </RulerContext.Provider>
  );
}
