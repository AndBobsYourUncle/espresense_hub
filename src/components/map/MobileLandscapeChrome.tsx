"use client";

import { Menu } from "lucide-react";
import { useMobileNav } from "@/components/MobileNavProvider";
import MapToolbar from "./MapToolbar";

/**
 * Combined floating chrome shown in mobile landscape: hamburger to
 * open the sidebar drawer, a tiny title/summary block, and the
 * vertical map toolbar — all stacked into a single panel on the left
 * edge of the map. This lets the map take the full vertical height
 * (page header is hidden in this mode) while keeping nav, identity,
 * and tool selection one finger away.
 *
 * Visibility is gated to mobile landscape (below `lg` width AND
 * landscape orientation) by the parent caller wrapping this in a
 * `hidden max-lg:landscape:block` container.
 */
export default function MobileLandscapeChrome({
  summary,
}: {
  /** Short summary text shown under the title (e.g. "1 floor · 17 nodes"). */
  summary: string;
}) {
  const { toggle } = useMobileNav();
  return (
    <div className="absolute top-2 left-2 z-10 flex flex-col gap-2 items-start">
      <div className="inline-flex flex-col items-stretch gap-1 p-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 shadow-sm w-[72px]">
        <button
          type="button"
          onClick={toggle}
          aria-label="Open navigation menu"
          className="h-8 w-full inline-flex items-center justify-center rounded-md text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 text-center leading-tight">
          <div className="font-semibold text-zinc-900 dark:text-zinc-100">
            Map
          </div>
          <div className="text-[10px] break-words">{summary}</div>
        </div>
      </div>
      <MapToolbar orientation="vertical" />
    </div>
  );
}
