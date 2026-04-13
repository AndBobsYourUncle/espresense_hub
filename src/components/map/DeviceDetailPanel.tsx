"use client";

import { ChevronDown, X } from "lucide-react";
import { useState } from "react";
import type {
  ConfidenceBreakdownDTO,
  MeasurementDetailDTO,
} from "@/app/api/devices/[id]/route";
import { useUnits } from "@/components/UnitsProvider";
import { useDraggable } from "@/lib/hooks/useDraggable";
import { formatDistanceDisplay, type UnitSystem } from "@/lib/units";
import { useDeviceSelection } from "./DeviceSelectionProvider";
import DevicePinsPanel from "./DevicePinsPanel";

function residualBadge(
  residual: number | null,
  rejected: boolean,
  units: UnitSystem,
): {
  label: string;
  className: string;
} {
  if (rejected) {
    return {
      label: residual != null
        ? `dropped ${residual >= 0 ? "+" : "−"}${formatDistanceDisplay(Math.abs(residual), units)}`
        : "dropped",
      className:
        "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    };
  }
  if (residual == null) {
    return {
      label: "—",
      className:
        "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
    };
  }
  const a = Math.abs(residual);
  const sign = residual >= 0 ? "+" : "−";
  const value = `${sign}${formatDistanceDisplay(a, units)}`;
  if (a < 1.0)
    return {
      label: value,
      className:
        "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    };
  if (a < 3.0)
    return {
      label: value,
      className:
        "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    };
  return {
    label: value,
    className:
      "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  };
}

function MeasurementRow({
  m,
  units,
}: {
  m: MeasurementDetailDTO;
  units: UnitSystem;
}) {
  // Prefer the corrected residual (what PathAware actually uses) over
  // the raw one when calibration data was applied. Falls back to raw
  // when no correction happened.
  const displayResidual = m.correctedResidual ?? m.residual;
  const badge = residualBadge(displayResidual, m.rejected, units);
  const hasCorrection =
    m.correctedDistance != null &&
    m.measuredDistance != null &&
    Math.abs(m.correctedDistance - m.measuredDistance) > 0.01;

  return (
    <div
      className={`border-t border-zinc-100 dark:border-zinc-800/60 py-2.5 px-4 text-xs ${
        m.rejected ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {m.nodeName}
        </div>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1.5 text-zinc-500 dark:text-zinc-400 font-mono">
        <div>
          <div className="text-xs text-zinc-400 uppercase">measured</div>
          <div>
            {m.measuredDistance != null
              ? formatDistanceDisplay(m.measuredDistance, units)
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-400 uppercase">expected</div>
          <div>
            {m.expectedDistance != null
              ? formatDistanceDisplay(m.expectedDistance, units)
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-400 uppercase">RSSI</div>
          <div>{m.rssi != null ? `${m.rssi} dBm` : "—"}</div>
        </div>
      </div>
      {hasCorrection && m.correctedDistance != null && m.nEffective != null && (
        <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400 font-mono flex items-center justify-between gap-2">
          <span className="text-zinc-400 uppercase">path-aware</span>
          <span>
            → {formatDistanceDisplay(m.correctedDistance, units)}
            <span className="text-zinc-400 ml-1">
              (n={m.nEffective.toFixed(2)})
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function ConfidenceBreakdown({
  breakdown,
  units,
}: {
  breakdown: ConfidenceBreakdownDTO;
  units: UnitSystem;
}) {
  const rows: Array<{ label: string; value: number; note?: string }> = [
    {
      label: "fit",
      value: breakdown.fitScore,
      note: `${formatDistanceDisplay(breakdown.rmse, units)} rmse`,
    },
    { label: "geometry", value: breakdown.geomScore },
    { label: "coverage", value: breakdown.coverageScore },
    {
      label: "fixes",
      value: breakdown.fixScore,
      note: `${breakdown.fixCount} used`,
    },
  ];
  return (
    <div className="mt-2 space-y-1 text-xs font-mono text-zinc-500 dark:text-zinc-400 pl-2 border-l border-zinc-200 dark:border-zinc-800">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="text-zinc-400 w-16">{r.label}</span>
          <div className="h-1 flex-1 rounded-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
            <div
              className="h-full bg-zinc-400 dark:bg-zinc-600"
              style={{ width: `${Math.round(r.value * 100)}%` }}
            />
          </div>
          <span className="text-zinc-700 dark:text-zinc-300 w-8 text-right">
            {Math.round(r.value * 100)}%
          </span>
          {r.note && (
            <span className="text-zinc-400 w-20 text-right truncate">
              {r.note}
            </span>
          )}
        </div>
      ))}
      {breakdown.convergencePenaltyApplied && (
        <div className="text-amber-600 dark:text-amber-400 text-xs">
          ⚠ iteration didn’t converge — 10% penalty applied
        </div>
      )}
    </div>
  );
}

export default function DeviceDetailPanel() {
  const { selectedId, detail, loading, select } = useDeviceSelection();
  const { units } = useUnits();
  const open = selectedId != null;
  const [measurementsOpen, setMeasurementsOpen] = useState(false);

  // Drag-to-reposition the panel — useful when it covers something the
  // user wants to interact with on the map.
  const { pos, dragging, handlers } = useDraggable({ x: 0, y: 0 });

  // Don't render anything when no device is selected — matches the
  // node panel's "only exists when needed" behavior so there's no
  // ghost panel left on screen after dismiss.
  if (!open) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      className="absolute z-20 inset-x-2 top-2 bottom-2 sm:inset-auto sm:top-16 sm:right-4 sm:bottom-auto sm:w-[340px] sm:max-w-[90vw] sm:max-h-[calc(100%-5rem)] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg flex flex-col"
    >
      <header
        {...handlers}
        className="h-12 px-3 shrink-0 flex items-center justify-between gap-2 border-b border-zinc-100 dark:border-zinc-800 cursor-grab active:cursor-grabbing select-none"
        style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
      >
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Device
          </div>
          <div className="text-sm font-semibold truncate">
            {detail?.name ?? selectedId ?? "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => select(null)}
          className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-auto min-h-0">
        {loading && !detail ? (
          <div className="p-6 text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>
        ) : !detail ? (
          <div className="p-6 text-sm text-zinc-500 dark:text-zinc-400">
            Device not found in the current state. It may have aged out.
          </div>
        ) : (
          <>
            <section className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <div className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
                Position
              </div>
              {detail.position ? (
                <div className="space-y-1.5 text-xs font-mono text-zinc-600 dark:text-zinc-400">
                  <div className="flex justify-between">
                    <span className="text-zinc-400">x, y, z</span>
                    <span className="text-zinc-900 dark:text-zinc-100">
                      {formatDistanceDisplay(detail.position.x, units)},{" "}
                      {formatDistanceDisplay(detail.position.y, units)},{" "}
                      {formatDistanceDisplay(detail.position.z, units)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">algorithm</span>
                    <span className="text-zinc-900 dark:text-zinc-100">
                      {detail.position.algorithm}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">fixes</span>
                    <span className="text-zinc-900 dark:text-zinc-100">
                      {detail.position.fixes}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-400">confidence</span>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full bg-emerald-500"
                          style={{
                            width: `${Math.round(detail.position.confidence * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="text-zinc-900 dark:text-zinc-100">
                        {Math.round(detail.position.confidence * 100)}%
                      </span>
                    </div>
                  </div>
                  {detail.position.confidenceBreakdown && (
                    <ConfidenceBreakdown
                      breakdown={detail.position.confidenceBreakdown}
                      units={units}
                    />
                  )}
                </div>
              ) : (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  No position computed yet (need ≥2 fixes).
                </div>
              )}
            </section>

            <section>
              {(() => {
                const rejected = detail.measurements.filter(
                  (m) => m.rejected,
                ).length;
                const total = detail.measurements.length;
                const kept = total - rejected;
                // Brief summary numbers when collapsed: kept/dropped + the
                // best/worst residual so the user can see at a glance
                // whether anything is anomalous.
                const withResidual = detail.measurements
                  .filter((m) => m.residual != null && !m.rejected)
                  .map((m) => Math.abs(m.residual!));
                const maxRes =
                  withResidual.length > 0 ? Math.max(...withResidual) : null;
                return (
                  <button
                    type="button"
                    onClick={() => setMeasurementsOpen((o) => !o)}
                    className="w-full px-4 pt-3 pb-2 flex items-center justify-between gap-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors"
                  >
                    <div className="flex items-baseline gap-3 min-w-0">
                      <span className="text-xs uppercase tracking-wide text-zinc-400">
                        Measurements
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                        {total === 0
                          ? "no nodes"
                          : rejected > 0
                            ? `${kept} kept · ${rejected} dropped`
                            : `${total} nodes`}
                        {maxRes != null && (
                          <span className="ml-2 text-zinc-400">
                            · max ±{formatDistanceDisplay(maxRes, units)}
                          </span>
                        )}
                      </span>
                    </div>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-zinc-400 shrink-0 transition-transform ${measurementsOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                );
              })()}
              {measurementsOpen && (
                detail.measurements.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    No nodes reporting this device.
                  </div>
                ) : (
                  <div>
                    {detail.measurements.map((m) => (
                      <MeasurementRow key={m.nodeId} m={m} units={units} />
                    ))}
                  </div>
                )
              )}
            </section>

            <DevicePinsPanel deviceId={selectedId} />

            {measurementsOpen && (
              <section className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-400 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  consistent (residual &lt; {formatDistanceDisplay(1, units)})
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  mild outlier ({formatDistanceDisplay(1, units)}–
                  {formatDistanceDisplay(3, units)})
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  bad fix (≥{formatDistanceDisplay(3, units)}) or rejected
                  outlier — excluded from solve
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
