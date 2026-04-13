"use client";

import type { LucideIcon } from "lucide-react";
import { GitCompareArrows, MapPin, MousePointer2, Ruler } from "lucide-react";
import { useMapTool, type MapTool } from "./MapToolProvider";

interface ToolDef {
  tool: MapTool;
  label: string;
  icon: LucideIcon;
  hint: string;
}

const TOOLS: ToolDef[] = [
  {
    tool: "inspect",
    label: "Inspect",
    icon: MousePointer2,
    hint: "Click any node or device for details",
  },
  {
    tool: "ruler",
    label: "Ruler",
    icon: Ruler,
    hint: "Click two nodes or a wall to measure",
  },
  {
    tool: "pin",
    label: "Pin",
    icon: MapPin,
    hint: "Select a device, then SHIFT+click where you actually are to calibrate. Click pins to toggle accumulation, drag to move.",
  },
];

/**
 * Toolbar shown above (or alongside) the map. Renders outside MapStage
 * so it stays anchored — the rest of the map UI (panels, legends) is
 * draggable, but tool selection lives in a fixed spot.
 *
 * Two orientations:
 *   - `horizontal` (default): single row, lives in the page header.
 *   - `vertical`: stacked column, used when floated alongside the map
 *     (mobile landscape, where header height is precious).
 *
 * Tool buttons (Inspect / Ruler / Pin) are mutually exclusive; the
 * Compare toggle on the right (or bottom) is independent — overlays
 * raw-locator ghost markers on top of the active locator's results.
 */
export default function MapToolbar({
  orientation = "horizontal",
  className = "",
}: {
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  const { activeTool, setActiveTool, compareMode, setCompareMode } =
    useMapTool();
  const isVertical = orientation === "vertical";

  return (
    <div
      className={`${
        isVertical
          ? "inline-flex flex-col items-stretch"
          : "inline-flex items-center"
      } gap-0.5 p-1 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 shadow-sm self-start shrink-0 ${className}`}
      role="toolbar"
      aria-label="Map tools"
    >
      {TOOLS.map(({ tool, label, icon: Icon, hint }) => {
        const active = activeTool === tool;
        return (
          <button
            key={tool}
            type="button"
            onClick={() => setActiveTool(tool)}
            title={hint}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 h-7 px-2 sm:px-2.5 rounded text-xs font-medium transition-colors ${
              active
                ? "bg-blue-500 text-white"
                : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
      <div
        className={
          isVertical
            ? "h-px w-full bg-zinc-200 dark:bg-zinc-800 my-0.5"
            : "w-px h-5 bg-zinc-200 dark:bg-zinc-800 mx-0.5"
        }
      />
      <button
        type="button"
        onClick={() => setCompareMode(!compareMode)}
        title="Show baseline (raw IDW) ghost markers alongside path-aware results"
        aria-pressed={compareMode}
        className={`inline-flex items-center gap-1.5 h-7 px-2 sm:px-2.5 rounded text-xs font-medium transition-colors ${
          compareMode
            ? "bg-purple-500 text-white"
            : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900"
        }`}
      >
        <GitCompareArrows className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Compare</span>
      </button>
    </div>
  );
}
