"use client";

import { useCallback, useRef, useState } from "react";

export interface DraggablePosition {
  x: number;
  y: number;
}

export interface DraggableHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
}

/**
 * Tiny pointer-event-based drag hook. Attach the returned `handlers` to the
 * element you want to use as the drag handle (typically a panel header).
 * The returned `pos` is the absolute (x, y) offset of the panel from its
 * starting position.
 *
 * Uses pointer capture so the drag continues even if the cursor leaves the
 * handle, and stops cleanly on pointer-up regardless of where the cursor is.
 */
export function useDraggable(initial: DraggablePosition = { x: 0, y: 0 }): {
  pos: DraggablePosition;
  dragging: boolean;
  handlers: DraggableHandlers;
} {
  const [pos, setPos] = useState<DraggablePosition>(initial);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Don't drag from interactive elements (buttons, inputs).
      const target = e.target as HTMLElement;
      if (target.closest("button, input, a, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        startX: pos.x,
        startY: pos.y,
      };
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      setPos({
        x: drag.current.startX + (e.clientX - drag.current.pointerX),
        y: drag.current.startY + (e.clientY - drag.current.pointerY),
      });
    },
    [],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore — capture might have been released already
      }
    },
    [],
  );

  return {
    pos,
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp },
  };
}
