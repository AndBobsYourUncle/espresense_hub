"use client";

import { Maximize2 } from "lucide-react";

/**
 * Floating "reset zoom" button for the floor-plan viewport. Only
 * renders when the user has actually panned or zoomed away from the
 * default view — out of the way otherwise.
 */
export default function ViewportControls({
  isZoomed,
  onReset,
}: {
  isZoomed: boolean;
  onReset: () => void;
}) {
  if (!isZoomed) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      title="Reset zoom"
      className="absolute bottom-4 left-4 z-10 inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
    >
      <Maximize2 className="h-3.5 w-3.5" />
      Reset
    </button>
  );
}
