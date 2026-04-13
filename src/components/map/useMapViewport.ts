"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Pan/zoom viewport for the floor-plan SVG.
 *
 * Manages a state-driven `viewBox` that the SVG renders with. Provides
 * handlers for the input modes:
 *
 *   - **Mouse wheel**: zoom in/out, anchored on the cursor.
 *   - **Trackpad pinch (macOS)**: arrives as `wheel + ctrlKey`. Same
 *     code path; we just turn up the gain so the gesture feels right.
 *   - **Touch pinch**: two-finger gesture, anchored on the centroid.
 *   - **Pointer drag**: pan when the user drags on empty/room space
 *     (markers stopPropagation in their own handlers, so a drag on a
 *     node/device/pin never reaches us).
 *
 * Coordinates are kept in SVG userspace so the transformation is
 * resolution-independent and matches what the marker code uses.
 *
 * The hook exposes a `didPanRef` for the parent to consult before
 * acting on the resulting click — we don't `stopPropagation` on the
 * up event, so the existing background click handler still fires; it
 * should ignore those when `didPanRef.current` is true.
 */

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Args {
  /** The "natural" viewBox at scale 1.0 — the floor's bounds + padding. */
  baseViewBox: ViewBox;
  minScale?: number;
  maxScale?: number;
}

interface ViewState {
  scale: number;
  /** Pan offset in viewBox userspace units. */
  panX: number;
  panY: number;
}

interface PanState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
  /** True once we've actually started panning (capture taken). Until
   *  then, the pointer events flow normally so a quick click reaches
   *  whatever marker is under the cursor. */
  captured: boolean;
}

interface PinchState {
  pointers: Map<number, { x: number; y: number }>;
  lastDist: number;
}

const DRAG_THRESHOLD_PX = 5;
const INITIAL_VIEW: ViewState = { scale: 1, panX: 0, panY: 0 };

export function useMapViewport({
  baseViewBox,
  minScale = 1,
  maxScale = 16,
}: Args) {
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<PanState | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  /** True if the most recent gesture moved the viewport. The map's
   *  background-click handler should ignore the resulting click when
   *  this is set, then clear it. */
  const didPanRef = useRef(false);

  const viewBox = useMemo(() => {
    const w = baseViewBox.w / view.scale;
    const h = baseViewBox.h / view.scale;
    const x = baseViewBox.x + view.panX;
    const y = baseViewBox.y + view.panY;
    return `${x} ${y} ${w} ${h}`;
  }, [baseViewBox, view]);

  const reset = useCallback(() => {
    setView(INITIAL_VIEW);
  }, []);

  const isZoomed =
    view.scale !== 1 || view.panX !== 0 || view.panY !== 0;

  /** Convert a screen-space (clientX, clientY) point to userspace using
   *  the SVG's current transform. */
  const screenToUser = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const sp = pt.matrixTransform(ctm.inverse());
      return { x: sp.x, y: sp.y };
    },
    [],
  );

  /** Apply a zoom factor anchored on a screen-space point. The
   *  userspace point under the cursor stays put — that's what makes
   *  the zoom feel "natural" rather than centered. */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const before = screenToUser(clientX, clientY);
      if (!before) return;
      setView((prev) => {
        const nextScale = Math.max(
          minScale,
          Math.min(maxScale, prev.scale * factor),
        );
        if (nextScale === prev.scale) return prev;
        const oldW = baseViewBox.w / prev.scale;
        const oldH = baseViewBox.h / prev.scale;
        const newW = baseViewBox.w / nextScale;
        const newH = baseViewBox.h / nextScale;
        const ratio = newW / oldW;
        // Old viewBox top-left:
        const oldVbX = baseViewBox.x + prev.panX;
        const oldVbY = baseViewBox.y + prev.panY;
        // Need new viewBox where `before` lands at the same client px,
        // i.e. same fraction of the box. Since we kept aspect ratio:
        //   newVbX = before.x * (1 - ratio) + oldVbX * ratio
        const newVbX = before.x * (1 - ratio) + oldVbX * ratio;
        const newVbY = before.y * (1 - ratio) + oldVbY * ratio;
        didPanRef.current = true;
        return {
          scale: nextScale,
          panX: newVbX - baseViewBox.x,
          panY: newVbY - baseViewBox.y,
        };
        // Suppress unused-var note for newH; it's defined for clarity:
        void newH;
        void oldH;
      });
    },
    [baseViewBox, minScale, maxScale, screenToUser],
  );

  // --- Wheel: zoom. -----------------------------------------------------
  // Use a non-passive native listener so preventDefault() actually
  // blocks page scroll. React's synthetic onWheel is passive by default.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // macOS trackpad pinch arrives as wheel+ctrlKey with smaller deltas
      // per increment; turn up the gain so the gesture feels natural.
      const k = e.ctrlKey ? 0.985 : 0.998;
      const factor = Math.pow(k, e.deltaY);
      zoomAt(e.clientX, e.clientY, factor);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // --- Pointer: pan + pinch -------------------------------------------
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Markers stopPropagation in their own pointerdown, so this only
      // fires when the user starts on background/room polygons.
      const svg = svgRef.current;
      if (!svg) return;

      // First pointer: prepare for either a pan (1 finger) or a pinch
      // (a second finger that arrives later). DON'T capture the pointer
      // yet — capture would prevent click events from reaching marker
      // elements (NodeMarkers / DeviceMarkers use onClick which fires on
      // pointerup). We only capture once movement exceeds the drag
      // threshold, by which point we know it's a pan, not a click.
      if (!pinchRef.current) {
        pinchRef.current = {
          pointers: new Map([
            [e.pointerId, { x: e.clientX, y: e.clientY }],
          ]),
          lastDist: 0,
        };
        panRef.current = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startPanX: view.panX,
          startPanY: view.panY,
          captured: false,
        };
        didPanRef.current = false;
        return;
      }

      // Second pointer arriving: promote to pinch state.
      pinchRef.current.pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });
      if (pinchRef.current.pointers.size === 2) {
        const pts = [...pinchRef.current.pointers.values()];
        pinchRef.current.lastDist = Math.hypot(
          pts[0].x - pts[1].x,
          pts[0].y - pts[1].y,
        );
        // Cancel the single-pointer pan that was in progress.
        panRef.current = null;
      }
    },
    [view.panX, view.panY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Pinch in progress?
      if (pinchRef.current && pinchRef.current.pointers.size === 2) {
        if (!pinchRef.current.pointers.has(e.pointerId)) return;
        pinchRef.current.pointers.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
        });
        const pts = [...pinchRef.current.pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        if (pinchRef.current.lastDist > 0) {
          zoomAt(cx, cy, dist / pinchRef.current.lastDist);
        }
        pinchRef.current.lastDist = dist;
        didPanRef.current = true;
        return;
      }

      // Single-pointer pan?
      const pan = panRef.current;
      if (!pan || pan.pointerId !== e.pointerId) return;
      const dxPx = e.clientX - pan.startClientX;
      const dyPx = e.clientY - pan.startClientY;
      if (!pan.captured && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) {
        // Below threshold — don't capture, don't pan. This lets a quick
        // click reach marker elements normally.
        return;
      }
      // Threshold exceeded → take pointer capture so subsequent moves
      // and the up event reliably reach us even if the cursor leaves
      // the SVG bounds. Marker click is no longer a concern by this
      // point — the user is dragging, not clicking.
      if (!pan.captured) {
        pan.captured = true;
        try {
          svgRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      didPanRef.current = true;
      const svg = svgRef.current;
      if (!svg) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      // ctm.a = svgWidthPx / viewBoxWidthUserUnits (and ctm.d for y).
      // So userspace delta = client delta / ctm.a (negated because moving
      // the cursor right should slide the world right == shift viewBox left).
      const userDx = -dxPx / ctm.a;
      const userDy = -dyPx / ctm.d;
      setView((prev) => ({
        ...prev,
        panX: pan.startPanX + userDx,
        panY: pan.startPanY + userDy,
      }));
    },
    [zoomAt],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (pinchRef.current) {
        pinchRef.current.pointers.delete(e.pointerId);
        if (pinchRef.current.pointers.size === 0) {
          pinchRef.current = null;
        }
      }
      if (panRef.current && panRef.current.pointerId === e.pointerId) {
        const wasCaptured = panRef.current.captured;
        panRef.current = null;
        if (wasCaptured) {
          try {
            svgRef.current?.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
      }
    },
    [],
  );

  return {
    viewBox,
    svgRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    didPanRef,
    reset,
    isZoomed,
  };
}
