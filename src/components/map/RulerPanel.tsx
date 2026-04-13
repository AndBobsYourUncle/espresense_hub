"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Maximize2,
  Ruler,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useUnits } from "@/components/UnitsProvider";
import { useDraggable } from "@/lib/hooks/useDraggable";
import { formatDistanceDisplay, parseDistance, unitSuffix } from "@/lib/units";
import type { NodeMarkerData } from "./NodeMarkers";
import { useRuler, type SavedMeasurement } from "./RulerProvider";

interface Props {
  nodes: readonly NodeMarkerData[];
}

function distance3D(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function classifyError(errorPct: number): {
  text: string;
  bg: string;
} {
  const a = Math.abs(errorPct);
  if (a < 3)
    return {
      text: "text-emerald-700 dark:text-emerald-400",
      bg: "bg-emerald-100 dark:bg-emerald-900/30",
    };
  if (a < 10)
    return {
      text: "text-amber-700 dark:text-amber-400",
      bg: "bg-amber-100 dark:bg-amber-900/30",
    };
  return {
    text: "text-red-700 dark:text-red-400",
    bg: "bg-red-100 dark:bg-red-900/30",
  };
}

function formatErrorPct(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

interface AggregateStats {
  count: number;
  meanScale: number;
  minScale: number;
  maxScale: number;
  meanErrorPct: number;
  /** Set of measurement ids more than `OUTLIER_THRESHOLD` from the median scale. */
  outlierIds: ReadonlySet<string>;
  /** Mean scale excluding outliers (same as meanScale when outliers is empty). */
  trimmedMeanScale: number;
  /** Range of scales after removing outliers. */
  trimmedMinScale: number;
  trimmedMaxScale: number;
  trimmedCount: number;
  /** True iff every measurement label looks like a wall (vs node-pair). */
  allWalls: boolean;
}

const OUTLIER_THRESHOLD = 0.03; // ±3% from the median scale

function computeStats(history: readonly SavedMeasurement[]): AggregateStats | null {
  if (history.length === 0) return null;
  const scales = history.map((m) => m.actualDistance / m.configDistance);
  const errors = history.map(
    (m) => ((m.configDistance - m.actualDistance) / m.actualDistance) * 100,
  );
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

  // Median-based outlier detection. Anything more than OUTLIER_THRESHOLD
  // from the median is flagged. Median is robust to outliers themselves
  // unlike mean, so a single bad measurement won't shift the threshold.
  const outlierIds = new Set<string>();
  let trimmed = scales;
  let trimmedMin = Math.min(...scales);
  let trimmedMax = Math.max(...scales);
  if (history.length >= 3) {
    const sorted = [...scales].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    history.forEach((m, i) => {
      if (Math.abs(scales[i] - median) > OUTLIER_THRESHOLD) {
        outlierIds.add(m.id);
      }
    });
    if (outlierIds.size > 0) {
      trimmed = scales.filter((_, i) => !outlierIds.has(history[i].id));
      if (trimmed.length > 0) {
        trimmedMin = Math.min(...trimmed);
        trimmedMax = Math.max(...trimmed);
      }
    }
  }
  const trimmedMeanScale =
    trimmed.length > 0 ? sum(trimmed) / trimmed.length : sum(scales) / scales.length;

  return {
    count: history.length,
    meanScale: sum(scales) / scales.length,
    minScale: Math.min(...scales),
    maxScale: Math.max(...scales),
    meanErrorPct: sum(errors) / errors.length,
    outlierIds,
    trimmedMeanScale,
    trimmedMinScale: trimmedMin,
    trimmedMaxScale: trimmedMax,
    trimmedCount: trimmed.length,
    allWalls: history.every((m) => m.label.startsWith("Wall:")),
  };
}

export default function RulerPanel({ nodes }: Props) {
  const {
    rulerNodes,
    clear,
    wallPickerActive,
    selectedWall,
    startWallPicker,
    cancelWallPicker,
    history,
    addToHistory,
    removeFromHistory,
    clearHistory,
  } = useRuler();
  const { units } = useUnits();
  const router = useRouter();
  const [actualInput, setActualInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const lastKey = useRef<string>("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const a = nodes.find((n) => n.id === rulerNodes[0]);
  const b = rulerNodes[1] ? nodes.find((n) => n.id === rulerNodes[1]) : null;
  // Either a node-pair distance or a wall length, depending on what's active.
  const configDistance =
    selectedWall != null ? selectedWall.length : a && b ? distance3D(a.point, b.point) : null;

  // Make the panel draggable from its header — useful when a wall the user
  // wants to click is hidden behind it.
  const { pos, handlers } = useDraggable({ x: 0, y: 0 });
  // Parse imperial-style ("17'6") OR plain numbers depending on units.
  const parsedActual = parseDistance(actualInput, units);
  const actualMeters = parsedActual ?? NaN;
  const actualValid = parsedActual != null && parsedActual > 0;
  const errorPct =
    configDistance != null && actualValid
      ? ((configDistance - actualMeters) / actualMeters) * 100
      : null;
  const scaleFactor =
    configDistance != null && actualValid
      ? actualMeters / configDistance
      : null;

  // Reset the input whenever the active measurement subject changes (a new
  // pair, a new wall, or canceling).
  useEffect(() => {
    const key =
      selectedWall != null
        ? `wall:${selectedWall.roomId}|${selectedWall.a.join(",")}|${selectedWall.b.join(",")}`
        : `pair:${rulerNodes.join("|")}`;
    if (key === lastKey.current) return;
    setActualInput("");
    lastKey.current = key;
  }, [rulerNodes, selectedWall]);

  // Auto-focus the input when both nodes are picked OR a wall is picked.
  useEffect(() => {
    if (rulerNodes.length === 2 || selectedWall != null) {
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [rulerNodes, selectedWall]);

  const canSave = configDistance != null && actualValid;

  const handleSave = () => {
    if (!canSave || configDistance == null) return;
    let label: string;
    const wasWall = selectedWall != null;
    if (selectedWall) {
      label = `Wall: ${selectedWall.roomName}`;
    } else if (a && b) {
      label = `${a.name ?? a.id} → ${b.name ?? b.id}`;
    } else {
      return;
    }
    addToHistory({
      label,
      configDistance,
      actualDistance: actualMeters,
    });
    setActualInput("");
    clear();
    // Streamline multi-wall measurement: after saving a wall, immediately
    // re-enter wall picker so the user can click the next wall without
    // re-pressing "Measure a wall".
    if (wasWall) {
      startWallPicker();
    }
  };

  const stats = computeStats(history);

  // Scale-to-map: pick the most appropriate factor from the data we have.
  // Prefer the trimmed mean (mean excluding outliers) when there are
  // outliers, since one bad measurement can drag a plain mean off the
  // tight cluster of "real" values.
  const useTrimmed =
    stats != null && stats.outlierIds.size > 0 && stats.trimmedCount > 0;
  const applicableScale: number | null = stats
    ? useTrimmed
      ? stats.trimmedMeanScale
      : stats.meanScale
    : scaleFactor != null
      ? scaleFactor
      : null;
  const applicableSource = stats
    ? useTrimmed
      ? `trimmed mean of ${stats.trimmedCount} (excluding ${stats.outlierIds.size} outlier${stats.outlierIds.size === 1 ? "" : "s"})`
      : `mean of ${stats.count} measurement${stats.count === 1 ? "" : "s"}`
    : "current measurement";

  const handleApplyScale = async () => {
    if (applicableScale == null) return;
    const factor = applicableScale;
    const pct = (factor - 1) * 100;
    const direction =
      factor > 1 ? "larger" : factor < 1 ? "smaller" : "unchanged";
    const confirmed = window.confirm(
      `Multiply every coordinate in config.yaml by × ${factor.toFixed(3)} ` +
        `(${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% ${direction})?\n\n` +
        `This rescales all room polygons and node positions. Z heights are ` +
        `left untouched. The room shapes keep their proportions; everything ` +
        `just gets uniformly bigger or smaller. Cannot be undone (other than ` +
        `applying the inverse scale).`,
    );
    if (!confirmed) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch("/api/scale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factor }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setApplyError(body.error ?? `request failed (${res.status})`);
        return;
      }
      // Pre-scale measurements are now stale (their config distances are
      // invalidated). Wipe history and the in-progress input so the user
      // re-measures against the new scale.
      clearHistory();
      clear();
      setActualInput("");
      router.refresh();
    } catch (err) {
      setApplyError((err as Error).message ?? "request failed");
    } finally {
      setApplying(false);
    }
  };

  const visible =
    rulerNodes.length > 0 ||
    wallPickerActive ||
    selectedWall != null ||
    history.length > 0;
  if (!visible) return null;

  // Inner render helpers — closures over the parent state. Used by both the
  // pair view and the wall view so the input + error rows + save button
  // look identical regardless of how the measurement was started.
  const renderConfigMeasuredRow = () => (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <div className="text-xs uppercase text-zinc-400 mb-1">Config</div>
        <div className="font-mono text-sm text-zinc-900 dark:text-zinc-100">
          {formatDistanceDisplay(configDistance!, units)}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase text-zinc-400 mb-1">Measured</div>
        <div className="flex items-baseline gap-1">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={actualInput}
            onChange={(e) => setActualInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder={units === "imperial" ? `17'6  or 210` : "0.00"}
            className="w-24 font-mono text-sm bg-transparent border-b border-zinc-300 dark:border-zinc-700 focus:border-blue-500 outline-none text-zinc-900 dark:text-zinc-100 placeholder-zinc-300 dark:placeholder-zinc-600"
          />
          <span className="text-xs text-zinc-400">{unitSuffix(units)}</span>
        </div>
      </div>
    </div>
  );

  const renderErrorRows = () => {
    if (errorPct == null || scaleFactor == null) return null;
    return (
      <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-zinc-500">Map error</span>
          <span
            className={`font-mono text-sm font-medium ${classifyError(errorPct).text}`}
          >
            {formatErrorPct(errorPct)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-zinc-500">Scale needed</span>
          <span className="font-mono text-sm text-zinc-900 dark:text-zinc-100">
            × {scaleFactor.toFixed(3)}
          </span>
        </div>
      </div>
    );
  };

  const renderSaveButton = () => (
    <button
      type="button"
      onClick={handleSave}
      disabled={!canSave}
      className="w-full mt-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-900 dark:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Save className="h-3 w-3" />
      Save (or press Enter)
    </button>
  );

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      className="absolute top-16 left-4 z-10 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg w-[320px] max-w-[90vw] flex flex-col max-h-[calc(100%-5rem)]"
    >
      <header
        {...handlers}
        className="h-10 px-4 flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 shrink-0 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500 font-medium">
          <Ruler className="h-3.5 w-3.5" />
          Ruler
          {stats && (
            <span className="text-zinc-400 normal-case tracking-normal">
              · {stats.count} {stats.count === 1 ? "measurement" : "measurements"}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={clear}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          aria-label="Clear current selection"
          title="Clear current selection"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* Current measurement section */}
      {(rulerNodes.length > 0 || wallPickerActive || selectedWall) && (
        <div className="p-4 border-b border-zinc-100 dark:border-zinc-800">
          {wallPickerActive && !selectedWall ? (
            <div className="space-y-2">
              <div className="text-sm text-zinc-700 dark:text-zinc-300 font-medium">
                Click a wall on the map
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Every wall is highlighted. Pick the one you can easily measure
                with a tape (typically an exterior wall or a long interior
                wall).
              </p>
              <button
                type="button"
                onClick={cancelWallPicker}
                className="mt-1 w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          ) : selectedWall ? (
            <div className="space-y-3">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                Wall · {selectedWall.roomName}
              </div>
              {renderConfigMeasuredRow()}
              {renderErrorRows()}
              {renderSaveButton()}
            </div>
          ) : !b ? (
            <div className="text-sm text-zinc-500">
              Selected{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {a?.name ?? a?.id}
              </span>
              . Click another node to measure.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {a?.name ?? a?.id} → {b.name ?? b.id}
              </div>
              {renderConfigMeasuredRow()}
              {renderErrorRows()}
              {renderSaveButton()}
            </div>
          )}
        </div>
      )}

      {/* When idle (no in-progress measurement) but we have history, offer
          the wall-picker entry. */}
      {rulerNodes.length === 0 &&
        !wallPickerActive &&
        !selectedWall &&
        history.length > 0 && (
          <div className="p-4 border-b border-zinc-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={startWallPicker}
              className="w-full h-9 inline-flex items-center justify-center gap-2 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
            >
              <Ruler className="h-3.5 w-3.5" />
              Measure a wall
            </button>
            <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
              Or click any node on the map to measure node-to-node.
            </p>
          </div>
        )}

      {/* History */}
      {history.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 pt-3 pb-1 flex items-baseline justify-between">
            <div className="text-xs uppercase tracking-wide text-zinc-400">
              History
            </div>
            <button
              type="button"
              onClick={clearHistory}
              className="text-xs text-zinc-400 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center gap-1"
            >
              <Trash2 className="h-2.5 w-2.5" />
              Clear all
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {history.map((m) => {
              const errPct =
                ((m.configDistance - m.actualDistance) / m.actualDistance) * 100;
              const cls = classifyError(errPct);
              const scale = m.actualDistance / m.configDistance;
              const isOutlier = stats?.outlierIds.has(m.id) ?? false;
              return (
                <div
                  key={m.id}
                  className={`px-4 py-2 border-t border-zinc-100 dark:border-zinc-800/60 group hover:bg-zinc-50 dark:hover:bg-zinc-900/40 ${
                    isOutlier ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1.5">
                      {isOutlier && (
                        <AlertTriangle
                          className="h-3 w-3 text-amber-500 shrink-0"
                          aria-label="Outlier"
                        >
                          <title>Outlier — not used in trimmed mean</title>
                        </AlertTriangle>
                      )}
                      {m.label}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromHistory(m.id)}
                      className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity shrink-0"
                      aria-label="Remove measurement"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs font-mono text-zinc-500">
                    <span>
                      {formatDistanceDisplay(m.configDistance, units)} →{" "}
                      {formatDistanceDisplay(m.actualDistance, units)}
                    </span>
                    <span className="text-zinc-900 dark:text-zinc-100">
                      × {scale.toFixed(3)}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded ${cls.text} ${cls.bg}`}
                    >
                      {formatErrorPct(errPct)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Stats footer */}
          {stats && stats.count >= 2 && (
            <div className="px-4 py-2.5 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 text-xs space-y-0.5">
              {stats.outlierIds.size > 0 && stats.trimmedCount > 0 ? (
                <>
                  <div className="flex items-baseline justify-between">
                    <span className="text-zinc-500">Trimmed mean</span>
                    <span className="font-mono text-zinc-900 dark:text-zinc-100">
                      × {stats.trimmedMeanScale.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-zinc-500">Trimmed range</span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300">
                      × {stats.trimmedMinScale.toFixed(3)} – ×{" "}
                      {stats.trimmedMaxScale.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-zinc-400">
                    <span>All</span>
                    <span className="font-mono">
                      × {stats.meanScale.toFixed(3)} (range × {stats.minScale.toFixed(3)} – × {stats.maxScale.toFixed(3)})
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-baseline justify-between">
                    <span className="text-zinc-500">Mean scale</span>
                    <span className="font-mono text-zinc-900 dark:text-zinc-100">
                      × {stats.meanScale.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-zinc-500">Range</span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300">
                      × {stats.minScale.toFixed(3)} – × {stats.maxScale.toFixed(3)}
                    </span>
                  </div>
                </>
              )}
              <div className="text-xs text-zinc-400 pt-1 leading-relaxed">
                {(() => {
                  const tightAll = stats.maxScale - stats.minScale < 0.04;
                  const tightTrimmed =
                    stats.trimmedCount >= 2 &&
                    stats.trimmedMaxScale - stats.trimmedMinScale < 0.04;
                  if (tightAll) {
                    return "Tight range — looks like a uniform scale issue, safe to apply.";
                  }
                  if (stats.outlierIds.size > 0 && tightTrimmed) {
                    return `${stats.outlierIds.size} outlier${stats.outlierIds.size === 1 ? "" : "s"} removed — the rest cluster tightly. Apply uses the trimmed mean. Consider re-measuring or deleting the outlier${stats.outlierIds.size === 1 ? "" : "s"}.`;
                  }
                  if (stats.allWalls) {
                    return "Wide range across walls — your map has non-uniform distortion. Applying mean helps on average but won't be perfect everywhere.";
                  }
                  return "Wide range across node pairs — likely per-node placement errors. Use the node editor to fix individual nodes instead.";
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {applicableScale != null &&
        Math.abs(applicableScale - 1) > 0.001 && (
          <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2 shrink-0">
            {applyError && (
              <div className="text-xs text-red-600 dark:text-red-400">
                {applyError}
              </div>
            )}
            <button
              type="button"
              onClick={handleApplyScale}
              disabled={applying}
              className="w-full h-9 inline-flex items-center justify-center gap-2 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              {applying
                ? "Rescaling…"
                : `Apply × ${applicableScale.toFixed(3)} to map`}
            </button>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Multiplies every node, room polygon, and floor bounds by{" "}
              <span className="font-mono">× {applicableScale.toFixed(3)}</span>{" "}
              ({applicableSource}). Z heights stay put. History is cleared
              after so you can re-measure to verify.
            </p>
          </div>
        )}
    </div>
  );
}

