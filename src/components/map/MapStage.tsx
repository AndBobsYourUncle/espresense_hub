"use client";

import { useDeviceSelection } from "./DeviceSelectionProvider";
import { useMapTool } from "./MapToolProvider";
import { useNodeEdit } from "./NodeEditProvider";
import { useRoomRelations } from "./RoomRelationsProvider";
import { useRuler } from "./RulerProvider";

/**
 * Wraps FloorPlan + the side panels in a positioned container so they can
 * absolutely overlay the map. Background clicks (anywhere not on an
 * interactive child like a device or node marker) clear:
 *   - the device selection
 *   - the inspected node (inspect tool state)
 *   - the in-progress ruler measurement
 *
 * Background clicks do NOT cancel an open node editor — that requires an
 * explicit cancel/save so a stray click can't lose your typed coordinates.
 *
 * The marker components stop click propagation themselves so clicking
 * a marker doesn't immediately deselect.
 */
export default function MapStage({
  children,
}: {
  children: React.ReactNode;
}) {
  const { select } = useDeviceSelection();
  const { clear: clearRuler } = useRuler();
  const { editingId } = useNodeEdit();
  const { setInspectedNodeId } = useMapTool();
  const { cancel: cancelRoomEdit, editingRoomId } = useRoomRelations();
  return (
    <div
      className="relative h-full rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-sm"
      style={{ background: "var(--map-surface)" }}
      onClick={() => {
        select(null);
        setInspectedNodeId(null);
        // Deselect the room being edited in room-relations mode.
        if (editingRoomId) cancelRoomEdit();
        // Don't clear the ruler if the editor is open — the user might be
        // measuring a wall to drive an edit.
        if (!editingId) clearRuler();
      }}
    >
      {children}
    </div>
  );
}
