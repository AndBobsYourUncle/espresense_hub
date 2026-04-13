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
    /** Bounding rect of the drag handle at drag-start, in viewport
     *  coords. Used to clamp the drag so the handle can't be dragged
     *  fully off-screen — at least MIN_VISIBLE px of it stays within
     *  the viewport so the user can always grab it back. */
    handleLeft: number;
    handleTop: number;
    handleWidth: number;
    handleHeight: number;
  } | null>(null);

  /** Minimum number of pixels of the drag handle that must remain
   *  inside the viewport at all times. 60 px is enough to comfortably
   *  re-grab on touch. */
  const MIN_VISIBLE = 60;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Don't drag from interactive elements (buttons, inputs).
      const target = e.target as HTMLElement;
      if (target.closest("button, input, a, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      drag.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        startX: pos.x,
        startY: pos.y,
        handleLeft: rect.left,
        handleTop: rect.top,
        handleWidth: rect.width,
        handleHeight: rect.height,
      };
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      let dx = e.clientX - d.pointerX;
      let dy = e.clientY - d.pointerY;

      // Clamp: at least MIN_VISIBLE px of the handle must remain
      // inside the viewport. That means the handle's left edge can't
      // go below `-handleWidth + MIN_VISIBLE` (then only MIN_VISIBLE
      // is visible at the left edge of viewport), and can't exceed
      // `vw - MIN_VISIBLE`. Same for y.
      const vw = typeof window !== "undefined" ? window.innerWidth : Infinity;
      const vh = typeof window !== "undefined" ? window.innerHeight : Infinity;
      const minDx = MIN_VISIBLE - d.handleLeft - d.handleWidth;
      const maxDx = vw - MIN_VISIBLE - d.handleLeft;
      const minDy = MIN_VISIBLE - d.handleTop - d.handleHeight;
      const maxDy = vh - MIN_VISIBLE - d.handleTop;
      dx = Math.max(minDx, Math.min(maxDx, dx));
      dy = Math.max(minDy, Math.min(maxDy, dy));

      setPos({
        x: d.startX + dx,
        y: d.startY + dy,
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
