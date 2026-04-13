"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FloorTransform } from "@/lib/map/geometry";
import { tx, ty, txInv, tyInv } from "@/lib/map/geometry";
import { useDeviceSelection } from "./DeviceSelectionProvider";
import { useMapTool } from "./MapToolProvider";
import { usePinHighlight } from "./PinHighlightProvider";

interface Pin {
  x: number;
  y: number;
  timestamp: number;
  active: boolean;
}

interface Props {
  transform: FloorTransform;
}

// Visual sizing constants — units are map-meters (the SVG viewBox is
// in meters), so these scale with zoom.
const CROSSHAIR_LEN = 0.32;
const CENTER_DOT_R = 0.12;
const STROKE_W = 0.06;
const ACTIVE_RING_R = 0.45;

/** How far (in map-meters) the user has to drag before we treat the
 *  interaction as a drag instead of a click. */
const DRAG_THRESHOLD = 0.15;

export default function PinOverlay({ transform }: Props) {
  const { activeTool } = useMapTool();
  const { selectedId } = useDeviceSelection();
  const { hoveredTimestamp } = usePinHighlight();
  const [pins, setPins] = useState<Pin[]>([]);

  /** While dragging: timestamp of the pin being dragged + its current
   *  optimistic position (so the marker follows the cursor in real time). */
  const [dragState, setDragState] = useState<{
    timestamp: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const active = activeTool === "pin" && selectedId != null;

  const reload = useCallback(async (deviceId: string) => {
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/pin`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const list: Pin[] = (data.pins ?? []).map(
        (p: {
          position: [number, number, number];
          timestamp: number;
          active: boolean;
        }) => ({
          x: p.position[0],
          y: p.position[1],
          timestamp: p.timestamp,
          active: p.active ?? false,
        }),
      );
      setPins(list);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setPins([]);
      return;
    }
    reload(selectedId);
    const id = setInterval(() => reload(selectedId), 3000);
    return () => clearInterval(id);
  }, [selectedId, reload]);

  const togglePinActive = useCallback(
    async (timestamp: number, makeActive: boolean) => {
      if (!selectedId) return;
      try {
        await fetch(`/api/devices/${encodeURIComponent(selectedId)}/pin`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timestamp, active: makeActive }),
        });
        reload(selectedId);
      } catch {
        // best-effort
      }
    },
    [selectedId, reload],
  );

  const movePin = useCallback(
    async (timestamp: number, x: number, y: number) => {
      if (!selectedId) return;
      try {
        await fetch(`/api/devices/${encodeURIComponent(selectedId)}/pin`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timestamp, position: [x, y, 0] }),
        });
        reload(selectedId);
      } catch {
        // best-effort
      }
    },
    [selectedId, reload],
  );

  /** Place a new pin at a given client (screen) coordinate. Shared by
   *  the desktop shift+click shortcut and the touch-friendly long-press. */
  const placePinAt = useCallback(
    async (clientX: number, clientY: number, svgEl: SVGSVGElement | null) => {
      if (!selectedId || !svgEl) return;
      const pt = svgEl.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = svgEl.getScreenCTM();
      if (!ctm) return;
      const svgPt = pt.matrixTransform(ctm.inverse());
      const configX = txInv(transform, svgPt.x);
      const configY = tyInv(transform, svgPt.y);
      try {
        const res = await fetch(
          `/api/devices/${encodeURIComponent(selectedId)}/pin`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: configX, y: configY, z: 0 }),
          },
        );
        if (!res.ok) return;
        reload(selectedId);
      } catch {
        // best-effort
      }
    },
    [selectedId, transform, reload],
  );

  // ----- Long-press handling on the background rect ------------------
  // Touch users can't shift+click. Holding finger ~500 ms triggers
  // pin placement at the original press coordinates. Light haptic on
  // trigger if the platform supports it.
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  /** True after a successful long-press, until the resulting click is
   *  consumed. Prevents both "place pin" AND "deselect device" firing. */
  const didLongPressRef = useRef(false);
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_TOLERANCE = 8;

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  const startLongPress = useCallback(
    (clientX: number, clientY: number, svgEl: SVGSVGElement | null) => {
      if (!active || !selectedId) return;
      cancelLongPress();
      longPressStartRef.current = { x: clientX, y: clientY };
      longPressTimerRef.current = window.setTimeout(() => {
        didLongPressRef.current = true;
        longPressTimerRef.current = null;
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(40);
        }
        placePinAt(clientX, clientY, svgEl);
      }, LONG_PRESS_MS);
    },
    [active, selectedId, placePinAt, cancelLongPress],
  );

  const handleBackgroundClick = useCallback(
    async (e: React.MouseEvent<SVGRectElement>) => {
      if (!active || !selectedId) return;
      // If a long-press just triggered, swallow the resulting click —
      // we already placed the pin, no need to also deselect.
      if (didLongPressRef.current) {
        e.stopPropagation();
        didLongPressRef.current = false;
        return;
      }
      // Plain click → let it bubble up to MapStage and deselect (matches
      // the user's muscle memory from inspect/ruler modes).
      // Shift+click → place a new pin at this position (desktop shortcut).
      if (!e.shiftKey) return;
      e.stopPropagation();
      placePinAt(
        e.clientX,
        e.clientY,
        (e.target as SVGElement).ownerSVGElement,
      );
    },
    [active, selectedId, placePinAt],
  );

  /** Convert pointer event clientX/Y to map-space coordinates. */
  const eventToMap = useCallback(
    (e: React.PointerEvent<SVGElement>): { x: number; y: number } | null => {
      const svg = (e.currentTarget as SVGElement).ownerSVGElement;
      if (!svg) return null;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const svgPt = pt.matrixTransform(ctm.inverse());
      return { x: txInv(transform, svgPt.x), y: tyInv(transform, svgPt.y) };
    },
    [transform],
  );

  const onPinPointerDown = useCallback(
    (timestamp: number, x: number, y: number) =>
      (e: React.PointerEvent<SVGElement>) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const mp = eventToMap(e);
        if (!mp) return;
        dragStartRef.current = { x: mp.x, y: mp.y };
        setDragState({ timestamp, x, y, moved: false });
      },
    [eventToMap],
  );

  const onPinPointerMove = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (!dragState || !dragStartRef.current) return;
      const mp = eventToMap(e);
      if (!mp) return;
      const dx = mp.x - dragStartRef.current.x;
      const dy = mp.y - dragStartRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= DRAG_THRESHOLD) {
        // Snap pin under the cursor.
        setDragState({
          timestamp: dragState.timestamp,
          x: mp.x,
          y: mp.y,
          moved: true,
        });
      }
    },
    [dragState, eventToMap],
  );

  const onPinPointerUp = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (!dragState) return;
      e.stopPropagation();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      const wasDrag = dragState.moved;
      const ts = dragState.timestamp;
      const dropX = dragState.x;
      const dropY = dragState.y;
      const wasActive = pins.find((p) => p.timestamp === ts)?.active ?? false;
      setDragState(null);
      dragStartRef.current = null;
      if (wasDrag) {
        movePin(ts, dropX, dropY);
      } else {
        // Plain click → toggle active.
        togglePinActive(ts, !wasActive);
      }
    },
    [dragState, pins, movePin, togglePinActive],
  );

  const b = transform.bounds;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;

  return (
    <g>
      {/* Background click target — only in pin-mode-with-selection. */}
      {active && (
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onClick={handleBackgroundClick}
          onPointerDown={(e) =>
            startLongPress(
              e.clientX,
              e.clientY,
              (e.target as SVGElement).ownerSVGElement,
            )
          }
          onPointerMove={(e) => {
            const start = longPressStartRef.current;
            if (!start) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) {
              cancelLongPress();
            }
          }}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onPointerLeave={cancelLongPress}
        />
      )}

      {/* Pins are visible while the Pin tool is active OR while a pin
          row in the device panel is being hovered (preview mode).
          When previewed (not in pin mode), only the hovered pin is
          shown and it's not interactive — just a visual cue. */}
      {selectedId &&
        pins.map((pin) => {
          const isHovered = pin.timestamp === hoveredTimestamp;
          // Only render this pin if pin tool is active (all pins) OR
          // this is the hovered pin (preview from panel).
          if (!active && !isHovered) return null;

          const isDragging = dragState?.timestamp === pin.timestamp;
          const px = isDragging ? dragState!.x : pin.x;
          const py = isDragging ? dragState!.y : pin.y;
          const sx = tx(transform, px);
          const sy = ty(transform, py);
          const color = pin.active ? "#0ea5e9" : "#10b981";

          return (
            <g key={pin.timestamp}>
              {/* Hover glow when previewed from the panel */}
              {isHovered && (
                <circle
                  cx={sx}
                  cy={sy}
                  r={ACTIVE_RING_R + 0.15}
                  fill={color}
                  fillOpacity={0.18}
                  stroke={color}
                  strokeWidth={STROKE_W * 0.8}
                  strokeOpacity={0.7}
                  className="pointer-events-none"
                />
              )}
              {/* Pulsing ring while accumulating */}
              {pin.active && !isDragging && (
                <circle
                  cx={sx}
                  cy={sy}
                  r={ACTIVE_RING_R}
                  fill="none"
                  stroke={color}
                  strokeWidth={STROKE_W}
                  className="pointer-events-none animate-ping"
                  style={{ transformOrigin: `${sx}px ${sy}px` }}
                />
              )}

              {/* Crosshair (purely visual) */}
              <g className="pointer-events-none">
                <line
                  x1={sx - CROSSHAIR_LEN}
                  y1={sy}
                  x2={sx + CROSSHAIR_LEN}
                  y2={sy}
                  stroke={color}
                  strokeWidth={STROKE_W}
                />
                <line
                  x1={sx}
                  y1={sy - CROSSHAIR_LEN}
                  x2={sx}
                  y2={sy + CROSSHAIR_LEN}
                  stroke={color}
                  strokeWidth={STROKE_W}
                />
              </g>

              {/* Drag/click target on the marker center. Pointer events
                  power both drag-to-reposition AND click-to-toggle. */}
              <circle
                cx={sx}
                cy={sy}
                r={CENTER_DOT_R + 0.06}
                fill={color}
                style={{
                  cursor: isDragging ? "grabbing" : "grab",
                  touchAction: "none",
                }}
                onPointerDown={onPinPointerDown(pin.timestamp, pin.x, pin.y)}
                onPointerMove={onPinPointerMove}
                onPointerUp={onPinPointerUp}
                onPointerCancel={onPinPointerUp}
                // Swallow the synthesized click — without this, the
                // pointer sequence triggers a click that bubbles up to
                // MapStage and deselects the device.
                onClick={(e) => e.stopPropagation()}
              />
              <title>
                {pin.active
                  ? "Drag to move · click to stop accumulating"
                  : "Drag to move · click to resume accumulating"}
              </title>
            </g>
          );
        })}
    </g>
  );
}
