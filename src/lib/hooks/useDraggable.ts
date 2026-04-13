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
     *  fully out of view — at least MIN_VISIBLE px of it stays within
     *  the bounding ancestor's visible area so the user can always
     *  grab it back. */
    handleLeft: number;
    handleTop: number;
    handleWidth: number;
    handleHeight: number;
    /** Bounds (in viewport coords) within which the handle must stay
     *  partially visible. Defaults to the viewport, but if the panel
     *  has a clipping ancestor (e.g. a parent with overflow: hidden),
     *  that ancestor's rect is used instead — otherwise the panel
     *  could be dragged "in the viewport" but visually clipped. */
    boundsLeft: number;
    boundsTop: number;
    boundsRight: number;
    boundsBottom: number;
  } | null>(null);

  /** Minimum number of pixels of the drag handle that must remain
   *  inside the bounds at all times. 60 px is enough to comfortably
   *  re-grab on touch. */
  const MIN_VISIBLE = 60;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Don't drag from interactive elements (buttons, inputs).
      const target = e.target as HTMLElement;
      if (target.closest("button, input, a, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      const handle = e.currentTarget as HTMLElement;
      const rect = handle.getBoundingClientRect();

      // Find the nearest clipping ancestor (overflow != visible) and
      // use its rect as the drag bounds. Without this, a panel inside
      // an `overflow: hidden` parent could be dragged "into the
      // viewport" but visually clipped by the parent — invisible AND
      // ungrabbable. Fall back to the viewport rect if no clipping
      // ancestor exists.
      const bounds = findClippingBounds(handle);

      drag.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        startX: pos.x,
        startY: pos.y,
        handleLeft: rect.left,
        handleTop: rect.top,
        handleWidth: rect.width,
        handleHeight: rect.height,
        boundsLeft: bounds.left,
        boundsTop: bounds.top,
        boundsRight: bounds.right,
        boundsBottom: bounds.bottom,
      };
      setDragging(true);
      handle.setPointerCapture(e.pointerId);
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
      // inside the bounds. Handle's new left edge after dragging:
      //   handleLeft + dx
      // Constrain so it lies within
      //   [boundsLeft - handleWidth + MIN_VISIBLE, boundsRight - MIN_VISIBLE]
      const minDx = d.boundsLeft + MIN_VISIBLE - d.handleLeft - d.handleWidth;
      const maxDx = d.boundsRight - MIN_VISIBLE - d.handleLeft;
      const minDy = d.boundsTop + MIN_VISIBLE - d.handleTop - d.handleHeight;
      const maxDy = d.boundsBottom - MIN_VISIBLE - d.handleTop;
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

/**
 * Walk up from `el` to find the nearest ancestor that clips overflow
 * (overflow-x/y other than `visible`). Return its bounding rect; if
 * none found, return the viewport rect.
 *
 * This is the actual visual area within which a draggable element can
 * be moved without disappearing — anything past these bounds gets
 * clipped by the ancestor and becomes invisible AND ungrabbable.
 */
function findClippingBounds(el: HTMLElement): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const style = getComputedStyle(cur);
    if (
      style.overflowX !== "visible" ||
      style.overflowY !== "visible"
    ) {
      const r = cur.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      };
    }
    cur = cur.parentElement;
  }
  return {
    left: 0,
    top: 0,
    right: typeof window !== "undefined" ? window.innerWidth : 0,
    bottom: typeof window !== "undefined" ? window.innerHeight : 0,
  };
}
