"use client";

import { useMemo } from "react";
import type { Floor } from "@/lib/config";
import { useMapTool } from "./MapToolProvider";
import { GROUP_COLORS } from "./RoomOverlay";

interface Props {
  floor: Floor;
}

export default function GroupLegend({ floor }: Props) {
  const { activeTool } = useMapTool();

  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    let n = 0;
    for (const room of floor.rooms) {
      if (room.floor_area && !seen.has(room.floor_area))
        seen.set(room.floor_area, GROUP_COLORS[n++ % GROUP_COLORS.length]);
    }
    return [...seen.entries()].map(([tag, color]) => ({ tag, color }));
  }, [floor.rooms]);

  if (activeTool !== "room-relations" || groups.length === 0) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-4 z-10 rounded-lg bg-white/95 dark:bg-zinc-950/95 backdrop-blur border border-zinc-200 dark:border-zinc-800 shadow-sm p-2.5 max-w-[calc(100%-2rem)] sm:max-w-none"
      aria-label="Floor area group legend"
    >
      <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500 dark:text-zinc-400 mb-1.5">
        Floor area groups
      </div>
      <ul className="space-y-0.5">
        {groups.map(({ tag, color }) => (
          <li key={tag}>
            <div className="flex items-center gap-2 text-xs px-1.5 py-1">
              <span
                className="inline-block w-3 h-3 rounded-full border border-white/50 dark:border-zinc-800 shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-zinc-700 dark:text-zinc-300 truncate font-mono">
                {tag}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
