"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { CornerRef, WallRef } from "@/lib/map/geometry";

export type Point3 = readonly [number, number, number];
export type PlacementMode = "manual" | "snap";

interface NodeEditContextValue {
  /** Currently editing node id, or null if not editing. */
  editingId: string | null;
  /** Live draft position — may differ from the saved value while typing. */
  draft: Point3 | null;
  /** Open the editor for `nodeId`, seeded with `initial`. */
  startEditing: (nodeId: string, initial: Point3) => void;
  /** Update the draft (e.g. as the user types). */
  setDraft: (p: Point3) => void;
  /** Persist the draft to config.yaml + the live store. */
  save: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Discard the draft and close the editor. */
  cancel: () => void;
  /** True while a save is in flight. */
  saving: boolean;

  // ---------- Snap (wall + corner) placement ----------
  /** "manual" = X/Y/Z inputs. "snap" = pick a wall or corner + offsets. */
  placementMode: PlacementMode;
  /** Switch into pick mode (clears any previously picked wall/corner). */
  startSnapPlacement: () => void;
  /** Leave snap mode and return to manual editing. */
  cancelSnapPlacement: () => void;
  /** Selected wall (mutually exclusive with selectedCorner). */
  selectedWall: WallRef | null;
  /** Selected corner (mutually exclusive with selectedWall). */
  selectedCorner: CornerRef | null;
  /** Called by the picker overlay on wall click. Clears any selected corner. */
  selectWall: (wall: WallRef) => void;
  /** Called by the picker overlay on corner click. Clears any selected wall. */
  selectCorner: (corner: CornerRef) => void;
}

const NodeEditContext = createContext<NodeEditContextValue | null>(null);

export function useNodeEdit(): NodeEditContextValue {
  const ctx = useContext(NodeEditContext);
  if (!ctx) {
    throw new Error("useNodeEdit must be used inside <NodeEditProvider>");
  }
  return ctx;
}

export default function NodeEditProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<Point3 | null>(null);
  const [saving, setSaving] = useState(false);
  const [placementMode, setPlacementMode] = useState<PlacementMode>("manual");
  const [selectedWall, setSelectedWall] = useState<WallRef | null>(null);
  const [selectedCorner, setSelectedCorner] = useState<CornerRef | null>(null);

  const startEditing = useCallback((nodeId: string, initial: Point3) => {
    setEditingId(nodeId);
    setDraftState(initial);
    setPlacementMode("manual");
    setSelectedWall(null);
    setSelectedCorner(null);
  }, []);

  const setDraft = useCallback((p: Point3) => {
    setDraftState(p);
  }, []);

  const cancel = useCallback(() => {
    setEditingId(null);
    setDraftState(null);
    setPlacementMode("manual");
    setSelectedWall(null);
    setSelectedCorner(null);
  }, []);

  const startSnapPlacement = useCallback(() => {
    setPlacementMode("snap");
    setSelectedWall(null);
    setSelectedCorner(null);
  }, []);

  const cancelSnapPlacement = useCallback(() => {
    setPlacementMode("manual");
    setSelectedWall(null);
    setSelectedCorner(null);
  }, []);

  const selectWall = useCallback((wall: WallRef) => {
    setSelectedWall(wall);
    setSelectedCorner(null);
  }, []);

  const selectCorner = useCallback((corner: CornerRef) => {
    setSelectedCorner(corner);
    setSelectedWall(null);
  }, []);

  const save = useCallback(async (): Promise<
    { ok: true } | { ok: false; error: string }
  > => {
    if (!editingId || !draft) return { ok: false, error: "nothing to save" };
    setSaving(true);
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ point: [draft[0], draft[1], draft[2]] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          error: body.error ?? `request failed (${res.status})`,
        };
      }
      setEditingId(null);
      setDraftState(null);
      setPlacementMode("manual");
      setSelectedWall(null);
      setSelectedCorner(null);
      // Re-run the page's server component so it re-reads config.yaml and
      // the marker re-renders at the saved position. Without this the page
      // keeps showing the old nodes prop until a manual refresh.
      router.refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      setSaving(false);
    }
  }, [editingId, draft, router]);

  // ESC to cancel.
  useEffect(() => {
    if (!editingId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editingId, cancel]);

  return (
    <NodeEditContext.Provider
      value={{
        editingId,
        draft,
        startEditing,
        setDraft,
        save,
        cancel,
        saving,
        placementMode,
        startSnapPlacement,
        cancelSnapPlacement,
        selectedWall,
        selectedCorner,
        selectWall,
        selectCorner,
      }}
    >
      {children}
    </NodeEditContext.Provider>
  );
}
