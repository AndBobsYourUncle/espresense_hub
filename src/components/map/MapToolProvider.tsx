"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * The current "tool" the user has selected on the map. Tools determine how
 * clicks on the map are interpreted.
 *
 * - `inspect` (default): clicking a node opens the node inspection panel,
 *   clicking a device opens the device detail panel. The map is in pure
 *   exploration mode — no clicks change measurement state.
 * - `ruler`: clicking nodes builds a measurement pair, clicking a wall
 *   measures the wall. The ruler panel becomes the active surface.
 *
 * (Editing nodes is still triggered by shift+click, regardless of tool.)
 */
export type MapTool = "inspect" | "ruler" | "pin";

interface MapToolContextValue {
  activeTool: MapTool;
  setActiveTool: (t: MapTool) => void;
  /** Node id currently shown in the inspection panel (inspect tool only). */
  inspectedNodeId: string | null;
  setInspectedNodeId: (id: string | null) => void;
  /**
   * When true, the map renders ghost markers for the baseline (raw)
   * locator alongside the active (path-aware) markers, so the user can
   * visually see how much PathAware moved each device.
   */
  compareMode: boolean;
  setCompareMode: (b: boolean) => void;
  /**
   * Algorithm keys whose ghost markers are currently hidden. Toggled
   * from the compare legend so the user can isolate one (or a few)
   * locators visually without losing the rest of the data.
   */
  hiddenLocators: ReadonlySet<string>;
  toggleLocator: (key: string) => void;
}

const MapToolContext = createContext<MapToolContextValue | null>(null);

export function useMapTool(): MapToolContextValue {
  const ctx = useContext(MapToolContext);
  if (!ctx) {
    throw new Error("useMapTool must be used inside <MapToolProvider>");
  }
  return ctx;
}

export default function MapToolProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [activeTool, setActiveToolState] = useState<MapTool>("inspect");
  const [inspectedNodeId, setInspectedNodeIdState] = useState<string | null>(
    null,
  );
  const [compareMode, setCompareMode] = useState(false);
  const [hiddenLocators, setHiddenLocators] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const toggleLocator = useCallback((key: string) => {
    setHiddenLocators((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setActiveTool = useCallback((next: MapTool) => {
    setActiveToolState(next);
    // Switching tools clears the inspection state — the new tool's
    // interaction model takes over.
    if (next !== "inspect") {
      setInspectedNodeIdState(null);
    }
  }, []);

  const setInspectedNodeId = useCallback((id: string | null) => {
    setInspectedNodeIdState(id);
  }, []);

  // ESC closes the inspection panel.
  useEffect(() => {
    if (!inspectedNodeId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInspectedNodeIdState(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [inspectedNodeId]);

  return (
    <MapToolContext.Provider
      value={{
        activeTool,
        setActiveTool,
        inspectedNodeId,
        setInspectedNodeId,
        compareMode,
        setCompareMode,
        hiddenLocators,
        toggleLocator,
      }}
    >
      {children}
    </MapToolContext.Provider>
  );
}
