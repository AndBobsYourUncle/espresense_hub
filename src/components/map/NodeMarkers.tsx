"use client";

import type { FloorTransform } from "@/lib/map/geometry";
import { tx, ty } from "@/lib/map/geometry";
import { useDeviceSelection } from "./DeviceSelectionProvider";
import { useMapTool } from "./MapToolProvider";
import { useNodeEdit } from "./NodeEditProvider";
import { useRuler } from "./RulerProvider";

export interface NodeMarkerData {
  id?: string;
  name?: string;
  point: readonly [number, number, number];
}

interface Props {
  nodes: readonly NodeMarkerData[];
  transform: FloorTransform;
}

const NODE_RADIUS = 0.18;
const NODE_STROKE = 0.05;
const NODE_LABEL_SIZE = 0.24;

/**
 * Renders configured ESPresense nodes as clickable circles inside the map
 * SVG.
 *
 * - Plain click: toggles the node into/out of the ruler measurement.
 * - Shift+click: opens the node editor.
 * - When the editor is active, the edited node is rendered at its draft
 *   position so the user sees the marker move live as they type.
 */
export default function NodeMarkers({ nodes, transform }: Props) {
  const { rulerNodes, toggleNode } = useRuler();
  const { editingId, draft, startEditing } = useNodeEdit();
  const { activeTool, inspectedNodeId, setInspectedNodeId } = useMapTool();
  const { select: selectDevice } = useDeviceSelection();

  // In pin mode, node markers shouldn't intercept pointer events.
  // Clicks/drags need to pass through to the pin overlay underneath
  // — otherwise dragging a pin over a node label or even close to a
  // node circle gets caught by the node marker and the drop position
  // ends up wrong (or the drop fails entirely). Inspect/ruler tools
  // need clicks on nodes to work, so we only disable pointer events
  // for the pin tool.
  const isPinMode = activeTool === "pin";

  return (
    <g style={isPinMode ? { pointerEvents: "none" } : undefined}>
      {nodes.map((n, i) => {
        // While editing, override the position with the live draft so the
        // marker moves as the user types in the panel.
        const effectivePoint =
          editingId && n.id === editingId && draft ? draft : n.point;

        const sx = tx(transform, effectivePoint[0]);
        const sy = ty(transform, effectivePoint[1]);
        const label = n.name ?? n.id ?? "";
        const isRulerSelected = n.id ? rulerNodes.includes(n.id) : false;
        const isInspected = n.id != null && n.id === inspectedNodeId;
        const isEditing = n.id != null && n.id === editingId;
        const isHighlighted = isRulerSelected || isInspected;
        const className = [
          isHighlighted ? "fp-node-selected" : null,
          isEditing ? "fp-node-editing" : null,
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <g
            key={`node-${n.id ?? i}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!n.id) return;
              if (e.shiftKey) {
                // Shift-click always opens the editor regardless of tool.
                startEditing(n.id, n.point);
                return;
              }
              if (activeTool === "ruler") {
                toggleNode(n.id);
              } else {
                // Default (inspect) tool: show node info, and dismiss
                // any open device panel — keep panels mutually exclusive
                // so the map isn't cluttered with two side-by-side cards.
                selectDevice(null);
                setInspectedNodeId(n.id);
              }
            }}
            style={{ cursor: "pointer" }}
            className={className || undefined}
          >
            <circle
              cx={sx}
              cy={sy}
              r={NODE_RADIUS}
              fill="#2563eb"
              stroke="#ffffff"
              strokeWidth={NODE_STROKE}
              className="fp-node"
            >
              <title>{`${label} — shift+click to edit`}</title>
            </circle>
            {label && (
              <text
                x={sx}
                y={sy - NODE_RADIUS - 0.1}
                textAnchor="middle"
                fontSize={NODE_LABEL_SIZE}
                fontWeight={600}
                fill="#1e3a8a"
                stroke="#ffffff"
                strokeWidth={0.07}
                strokeLinejoin="round"
                paintOrder="stroke"
                className="fp-node-label pointer-events-none select-none"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
