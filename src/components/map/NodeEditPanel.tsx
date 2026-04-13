"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  FlipHorizontal2,
  MapPin,
  Save,
  X,
} from "lucide-react";
import DistanceInput from "@/components/DistanceInput";
import { useUnits } from "@/components/UnitsProvider";
import { useDraggable } from "@/lib/hooks/useDraggable";
import { pointFromCorner, pointFromWall } from "@/lib/map/geometry";
import { formatDistanceDisplay } from "@/lib/units";
import type { NodeMarkerData } from "./NodeMarkers";
import { useNodeEdit } from "./NodeEditProvider";

interface Props {
  nodes: readonly NodeMarkerData[];
}

function CoordRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (m: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-4 text-xs font-mono text-zinc-400">{label}</span>
      <DistanceInput valueMeters={value} onChangeMeters={onChange} />
    </label>
  );
}

function OffsetRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (m: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 text-xs text-zinc-500">{label}</span>
      <DistanceInput valueMeters={value} onChangeMeters={onChange} />
    </label>
  );
}

/** Manual X/Y/Z entry section. */
function ManualEditor() {
  const { draft, setDraft, startSnapPlacement } = useNodeEdit();
  if (!draft) return null;
  return (
    <section className="px-4 py-4 border-b border-zinc-200 dark:border-zinc-800">
      <div className="text-xs uppercase tracking-wide text-zinc-400 mb-3">
        Position
      </div>
      <div className="space-y-2.5">
        <CoordRow
          label="X"
          value={draft[0]}
          onChange={(x) => setDraft([x, draft[1], draft[2]])}
        />
        <CoordRow
          label="Y"
          value={draft[1]}
          onChange={(y) => setDraft([draft[0], y, draft[2]])}
        />
        <CoordRow
          label="Z"
          value={draft[2]}
          onChange={(z) => setDraft([draft[0], draft[1], z])}
        />
      </div>
      <p className="mt-3 text-xs text-zinc-400 leading-relaxed">
        ↑ / ↓ in any field nudges. The map updates as you type.
      </p>

      <button
        type="button"
        onClick={startSnapPlacement}
        className="mt-4 w-full h-9 inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
      >
        <MapPin className="h-3.5 w-3.5" />
        Place from map…
      </button>
    </section>
  );
}

/** Wall placement section: shown when a wall has been picked. */
function WallEditor() {
  const { draft, setDraft, selectedWall, cancelSnapPlacement } = useNodeEdit();
  const { units } = useUnits();

  const [along, setAlong] = useState(0);
  const [perp, setPerp] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [zValue, setZValue] = useState(draft?.[2] ?? 1.0);

  useEffect(() => {
    if (!selectedWall) return;
    setAlong(selectedWall.length / 2);
    setPerp(0);
    setFlipped(false);
  }, [selectedWall]);

  useEffect(() => {
    if (selectedWall && draft) {
      setZValue(draft[2]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWall]);

  useEffect(() => {
    if (!selectedWall) return;
    setDraft(pointFromWall(selectedWall, along, perp, zValue, flipped));
  }, [selectedWall, along, perp, zValue, flipped, setDraft]);

  if (!selectedWall) return null;

  const startLabel = flipped ? "B" : "A";
  const endLabel = flipped ? "A" : "B";

  return (
    <section className="px-4 py-4 border-b border-zinc-200 dark:border-zinc-800 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Wall
          </div>
          <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {selectedWall.roomName}
          </div>
          <div className="text-xs font-mono text-zinc-500">
            {formatDistanceDisplay(selectedWall.length, units)} long
          </div>
        </div>
        <button
          type="button"
          onClick={() => setFlipped((f) => !f)}
          className="shrink-0 h-7 inline-flex items-center gap-1 px-2 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
          title="Flip which corner is the start"
        >
          <FlipHorizontal2 className="h-3 w-3" />
          {startLabel} → {endLabel}
        </button>
      </div>

      <div className="space-y-2.5">
        <OffsetRow
          label={`from ${startLabel}`}
          value={along}
          onChange={setAlong}
        />
        <OffsetRow label="into room" value={perp} onChange={setPerp} />
        <OffsetRow label="height (Z)" value={zValue} onChange={setZValue} />
      </div>

      {draft && (
        <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 text-xs font-mono text-zinc-500 flex justify-between">
          <span>computed</span>
          <span className="text-zinc-900 dark:text-zinc-100">
            {formatDistanceDisplay(draft[0], units)},{" "}
            {formatDistanceDisplay(draft[1], units)},{" "}
            {formatDistanceDisplay(draft[2], units)}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={cancelSnapPlacement}
        className="w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to manual
      </button>
    </section>
  );
}

/** Corner placement section: shown when a corner has been picked. */
function CornerEditor() {
  const { draft, setDraft, selectedCorner, cancelSnapPlacement } = useNodeEdit();
  const { units } = useUnits();

  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [zValue, setZValue] = useState(draft?.[2] ?? 1.0);

  useEffect(() => {
    if (!selectedCorner) return;
    setDx(0);
    setDy(0);
  }, [selectedCorner]);

  useEffect(() => {
    if (selectedCorner && draft) {
      setZValue(draft[2]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCorner]);

  useEffect(() => {
    if (!selectedCorner) return;
    setDraft(pointFromCorner(selectedCorner, dx, dy, zValue));
  }, [selectedCorner, dx, dy, zValue, setDraft]);

  if (!selectedCorner) return null;

  return (
    <section className="px-4 py-4 border-b border-zinc-200 dark:border-zinc-800 space-y-3">
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-400">
          Corner
        </div>
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {selectedCorner.roomNames.length > 0
            ? selectedCorner.roomNames.join(" · ")
            : "Room corner"}
        </div>
        <div className="text-xs font-mono text-zinc-500">
          ({formatDistanceDisplay(selectedCorner.point[0], units)},{" "}
          {formatDistanceDisplay(selectedCorner.point[1], units)})
        </div>
      </div>

      <div className="space-y-2.5">
        <OffsetRow label="ΔX" value={dx} onChange={setDx} />
        <OffsetRow label="ΔY" value={dy} onChange={setDy} />
        <OffsetRow label="height (Z)" value={zValue} onChange={setZValue} />
      </div>

      <p className="text-xs text-zinc-400 leading-relaxed">
        ΔX and ΔY are offsets from the corner in floor coordinates. Watch the
        marker move on the map and adjust signs as needed.
      </p>

      {draft && (
        <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 text-xs font-mono text-zinc-500 flex justify-between">
          <span>computed</span>
          <span className="text-zinc-900 dark:text-zinc-100">
            {formatDistanceDisplay(draft[0], units)},{" "}
            {formatDistanceDisplay(draft[1], units)},{" "}
            {formatDistanceDisplay(draft[2], units)}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={cancelSnapPlacement}
        className="w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to manual
      </button>
    </section>
  );
}

/** "Pick from map" prompt — shown when in snap mode but nothing picked yet. */
function PickPrompt() {
  const { cancelSnapPlacement } = useNodeEdit();
  return (
    <section className="px-4 py-6 border-b border-zinc-200 dark:border-zinc-800">
      <div className="text-sm text-zinc-700 dark:text-zinc-300 font-medium">
        Pick a wall or corner on the map
      </div>
      <p className="mt-2 text-xs text-zinc-500 leading-relaxed">
        Every wall is highlighted in blue and every corner is a clickable
        dot. Click a wall to enter an offset along it, or a corner to enter
        ΔX / ΔY offsets — whichever is easier to measure with a tape.
      </p>
      <button
        type="button"
        onClick={cancelSnapPlacement}
        className="mt-4 w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to manual
      </button>
    </section>
  );
}

export default function NodeEditPanel({ nodes }: Props) {
  const {
    editingId,
    draft,
    save,
    cancel,
    saving,
    placementMode,
    selectedWall,
    selectedCorner,
    cancelSnapPlacement,
  } = useNodeEdit();
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setError(null);
    setSavedFlash(false);
  }, [editingId]);

  const open = editingId != null && draft != null;
  const node = open ? nodes.find((n) => n.id === editingId) : null;
  // While the user is choosing a wall/corner from the map, the right-side
  // panel hides and we show a tiny bottom hint instead — otherwise the panel
  // would block half the rooms on the right side of the floor plan.
  const inPickMode =
    open && placementMode === "snap" && !selectedWall && !selectedCorner;
  const showAside = open && !inPickMode;

  // Drag-to-reposition the panel — matches the device + node inspection
  // panels so the user can move it out of the way of whatever they're
  // measuring against on the map.
  const { pos, dragging, handlers } = useDraggable({ x: 0, y: 0 });

  const handleSave = async () => {
    setError(null);
    const res = await save();
    if (!res.ok) {
      setError(res.error);
    } else {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    }
  };

  return (
    <>
      {showAside && (
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
        className="absolute top-16 right-4 z-20 w-[340px] max-w-[90vw] max-h-[calc(100%-5rem)] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg flex flex-col"
      >
      <header
        {...handlers}
        className="h-12 px-3 shrink-0 flex items-center justify-between gap-2 border-b border-zinc-100 dark:border-zinc-800 cursor-grab active:cursor-grabbing select-none"
        style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
      >
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Edit node
          </div>
          <div className="font-semibold text-sm truncate">
            {node?.name ?? editingId ?? "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={cancel}
          className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {open && draft && (
        <div className="flex-1 overflow-auto min-h-0">
          {placementMode === "manual" ? (
            <ManualEditor />
          ) : selectedWall ? (
            <WallEditor />
          ) : selectedCorner ? (
            <CornerEditor />
          ) : (
            <PickPrompt />
          )}

          {error && (
            <div className="px-4 py-3 border-b border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {savedFlash && (
            <div className="px-4 py-3 border-b border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-400">
              Saved to config.yaml
            </div>
          )}

          <section className="p-4 space-y-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="w-full h-9 inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save to config.yaml"}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="w-full h-9 inline-flex items-center justify-center rounded-md text-sm font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
            >
              Cancel
            </button>
          </section>
        </div>
      )}
      </div>
      )}

      {/* Pick-mode hint — fixed-positioned just below the page header so it
          floats over the chrome and never overlaps any wall or corner inside
          the map container. */}
      {inPickMode && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 inline-flex items-center gap-3 px-4 py-2 rounded-full bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-lg text-xs"
        >
          <span className="text-zinc-500">
            Editing{" "}
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              {node?.name ?? editingId}
            </span>
            {" — "}click a wall or corner
          </span>
          <button
            type="button"
            onClick={cancelSnapPlacement}
            className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 font-medium"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
