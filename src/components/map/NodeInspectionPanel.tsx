"use client";

import { useEffect, useState } from "react";
import { Edit3, X } from "lucide-react";
import type {
  CalibrationResponse,
  NodeCalibrationDTO,
} from "@/app/api/calibration/route";
import { useUnits } from "@/components/UnitsProvider";
import { useDraggable } from "@/lib/hooks/useDraggable";
import { formatDistanceDisplay, type UnitSystem } from "@/lib/units";
import { useMapTool } from "./MapToolProvider";
import { useNodeEdit } from "./NodeEditProvider";
import type { NodeMarkerData } from "./NodeMarkers";

interface Props {
  nodes: readonly NodeMarkerData[];
}

const POLL_MS = 5000;

function useNodeCalibration(nodeId: string | null): NodeCalibrationDTO | null {
  const [info, setInfo] = useState<NodeCalibrationDTO | null>(null);

  useEffect(() => {
    if (nodeId == null) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/calibration", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as CalibrationResponse;
        const found = data.nodes.find((n) => n.nodeId === nodeId);
        if (!cancelled) setInfo(found ?? null);
      } catch {
        // swallow — next tick retries
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nodeId]);

  return info;
}

function biasColor(meters: number): string {
  const a = Math.abs(meters);
  if (a < 0.5) return "text-emerald-600 dark:text-emerald-400";
  if (a < 1.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function InfoRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span
        className={`font-mono ${valueClass ?? "text-zinc-900 dark:text-zinc-100"}`}
      >
        {value}
      </span>
    </div>
  );
}

export default function NodeInspectionPanel({ nodes }: Props) {
  const { inspectedNodeId, setInspectedNodeId } = useMapTool();
  const { startEditing } = useNodeEdit();
  const { units } = useUnits();
  const info = useNodeCalibration(inspectedNodeId);
  const { pos, handlers } = useDraggable({ x: 0, y: 0 });

  const node =
    inspectedNodeId != null
      ? nodes.find((n) => n.id === inspectedNodeId)
      : null;
  if (!node || !inspectedNodeId) return null;

  const [px, py, pz] = node.point;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        transform: `translate(${pos.x}px, ${pos.y}px)`,
      }}
      className="absolute z-20 inset-x-2 top-2 bottom-2 sm:inset-auto sm:top-16 sm:right-4 sm:bottom-auto sm:w-[300px] sm:max-w-[90vw] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg flex flex-col"
    >
      {/* Drag handle = the header */}
      <header
        {...handlers}
        className="h-10 px-3 flex items-center justify-between gap-2 border-b border-zinc-100 dark:border-zinc-800 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Node
          </div>
          <div className="text-sm font-semibold truncate">
            {node.name ?? node.id}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setInspectedNodeId(null);
              startEditing(inspectedNodeId, node.point);
            }}
            title="Edit node position"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setInspectedNodeId(null)}
            title="Close"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="px-4 py-3 space-y-3 text-xs">
        <section className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Position
          </div>
          <InfoRow
            label="x, y, z"
            value={`${formatDistanceDisplay(px, units)}, ${formatDistanceDisplay(py, units)}, ${formatDistanceDisplay(pz, units)}`}
          />
        </section>

        <section className="space-y-1 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Calibration
          </div>
          {info ? (
            <>
              <InfoRow
                label="absorption"
                value={info.settings["absorption"] ?? "—"}
              />
              <InfoRow
                label="rx adj"
                value={info.settings["rx_adj_rssi"] ?? "—"}
              />
              <InfoRow
                label="tx ref"
                value={info.settings["tx_ref_rssi"] ?? "—"}
              />
            </>
          ) : (
            <div className="text-zinc-400 italic">loading…</div>
          )}
        </section>

        {info && info.gtCount > 0 && (
          <section className="space-y-1 pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wide text-zinc-400">
              Ground-truth bias
            </div>
            <InfoRow
              label="mean"
              value={`${info.gtMeanResidualMeters >= 0 ? "+" : ""}${formatDistanceDisplay(info.gtMeanResidualMeters, units)}`}
              valueClass={biasColor(info.gtMeanResidualMeters)}
            />
            <InfoRow
              label="stddev"
              value={`±${formatDistanceDisplay(info.gtStddevMeters, units)}`}
            />
            <InfoRow label="samples" value={info.gtCount.toLocaleString()} />
          </section>
        )}

        {info && info.pairs && info.pairs.length > 0 && (
          <section className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <a
              href={`/calibration?node=${encodeURIComponent(inspectedNodeId)}`}
              className="inline-block text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              See per-pair breakdown ({info.pairs.length} neighbors) →
            </a>
          </section>
        )}

        <p className="text-xs text-zinc-400 leading-relaxed pt-2 border-t border-zinc-100 dark:border-zinc-800">
          Drag the header to move this panel. Other nodes&apos; measured-distance
          circles around this node are shown on the map.
        </p>
      </div>
    </div>
  );
}
