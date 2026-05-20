"use client";

import { useEffect, useState } from "react";
import { Edit3, X } from "lucide-react";
import type {
  CascadePairEntry,
  CascadeResponse,
} from "@/app/api/calibration/cascade/route";
import { useUnits } from "@/components/UnitsProvider";
import { useDraggable } from "@/lib/hooks/useDraggable";
import { formatDistanceDisplay } from "@/lib/units";
import { useMapTool } from "./MapToolProvider";
import { useNodeEdit } from "./NodeEditProvider";
import type { NodeMarkerData } from "./NodeMarkers";

interface Props {
  nodes: readonly NodeMarkerData[];
}

const POLL_MS = 5000;

/** Poll the cascade endpoint while the panel is open. Cheap — shared
 *  across the whole UI, no tool-gating needed. */
function useCascade(nodeId: string | null): CascadeResponse | null {
  const [data, setData] = useState<CascadeResponse | null>(null);
  useEffect(() => {
    if (nodeId == null) {
      setData(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/calibration/cascade", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as CascadeResponse;
        if (!cancelled) setData(j);
      } catch {
        // best effort — next tick retries
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nodeId]);
  return data;
}

function residualColor(db: number): string {
  const a = Math.abs(db);
  if (a < 3) return "text-emerald-600 dark:text-emerald-400";
  if (a < 6) return "text-lime-600 dark:text-lime-400";
  if (a < 9) return "text-amber-600 dark:text-amber-400";
  if (a < 14) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function signedDb(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)} dB`;
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
  const {
    inspectedNodeId,
    setInspectedNodeId,
    focusedCascadePairKey,
    setFocusedCascadePairKey,
  } = useMapTool();
  const { startEditing } = useNodeEdit();
  const { units } = useUnits();
  const cascade = useCascade(inspectedNodeId);
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
      className="absolute z-20 inset-x-2 top-2 max-h-[calc(100%-1rem)] sm:inset-auto sm:top-16 sm:right-4 sm:w-[340px] sm:max-w-[90vw] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg flex flex-col"
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

      <div className="px-4 py-3 space-y-3 text-xs overflow-y-auto">
        <section className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Position
          </div>
          <InfoRow
            label="x, y, z"
            value={`${formatDistanceDisplay(px, units)}, ${formatDistanceDisplay(py, units)}, ${formatDistanceDisplay(pz, units)}`}
          />
        </section>

        <CascadeSection
          nodeId={inspectedNodeId}
          cascade={cascade}
          focusedPairKey={focusedCascadePairKey}
          onPairClick={setFocusedCascadePairKey}
        />
      </div>
    </div>
  );
}

/**
 * Cascade-calibration view of a node: Layer-2 offsets (this node's
 * learned TX/RX bias vs the fitted reference), an overall residual
 * summary, and a per-pair table — every pair involving this node
 * with the walls the ray-cast sees, the cascade's routed-path walls
 * when different, residual at the latest fit, and sample weight.
 *
 * The per-pair table is the "show me the stats for everything this
 * node is paired with" view — one row per direction, sorted by
 * |residual| desc so the worst gaps surface first.
 */
function CascadeSection({
  nodeId,
  cascade,
  focusedPairKey,
  onPairClick,
}: {
  nodeId: string;
  cascade: CascadeResponse | null;
  focusedPairKey: string | null;
  onPairClick: (key: string | null) => void;
}) {
  if (!cascade) {
    return (
      <section className="space-y-1 pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <div className="text-xs uppercase tracking-wide text-zinc-400">
          Cascade
        </div>
        <div className="text-zinc-400 italic">loading…</div>
      </section>
    );
  }

  const fit = cascade.fit;
  const offsets = fit?.nodeOffsets[nodeId];
  const isReference = fit?.referenceNodeId === nodeId;

  // Pairs involving this node (both directions), sorted by |residual|.
  const myPairs: CascadePairEntry[] = cascade.pairs
    .filter((p) => p.txId === nodeId || p.rxId === nodeId)
    .sort((a, b) => {
      const ar = a.residualDb == null ? -1 : Math.abs(a.residualDb);
      const br = b.residualDb == null ? -1 : Math.abs(b.residualDb);
      return br - ar;
    });
  const residuals = myPairs
    .map((p) => p.residualDb)
    .filter((r): r is number => r != null);
  const meanAbs =
    residuals.length > 0
      ? residuals.reduce((a, r) => a + Math.abs(r), 0) / residuals.length
      : null;

  return (
    <section className="space-y-1 pt-2 border-t border-zinc-100 dark:border-zinc-800">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-400">
          Cascade
        </div>
        {fit && (
          <div className="text-[10px] text-zinc-400 font-mono">
            σ {fit.residualStdDb.toFixed(2)} dB · n_path {fit.pathLossExponent.toFixed(2)}
          </div>
        )}
      </div>

      {!fit ? (
        <div className="text-zinc-400 italic">no fit yet</div>
      ) : (
        <>
          <InfoRow
            label="tx offset"
            value={offsets ? signedDb(offsets.txOffsetDb) : "—"}
            valueClass={isReference ? "text-zinc-400" : undefined}
          />
          <InfoRow
            label="rx offset"
            value={offsets ? signedDb(offsets.rxOffsetDb) : "—"}
            valueClass={isReference ? "text-zinc-400" : undefined}
          />
          {isReference && (
            <div className="text-[10px] text-zinc-400 italic pt-0.5">
              reference node — offsets anchored at 0
            </div>
          )}

          <div className="pt-1">
            <InfoRow
              label="pairs"
              value={myPairs.length.toString()}
            />
            {meanAbs != null && (
              <InfoRow
                label="mean |residual|"
                value={`${meanAbs.toFixed(2)} dB`}
                valueClass={residualColor(meanAbs)}
              />
            )}
          </div>

          {myPairs.length > 0 && (
            <PairsTable
              nodeId={nodeId}
              pairs={myPairs}
              focusedPairKey={focusedPairKey}
              onPairClick={onPairClick}
            />
          )}

          <div className="pt-2 text-[10px] text-zinc-400 leading-relaxed">
            Click a pair line on the map to isolate just the walls it crosses.
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Per-pair breakdown table. One row per pair-direction (so a
 * bidirectional pair shows up twice — see the asymmetry explicitly).
 *
 *   role         "→"  this node broadcasts · "←"  this node listens
 *   counterpart  the other node's id
 *   resid        fit residual, colored by magnitude
 *   walls        direct ray-cast crossings, "Ni/Ne/Nd" compact form
 *   routed       cascade's routed-path walls when it diverged from
 *                direct; "—" when the cascade used the direct line
 *   w            recency-decayed sample weight
 */
function PairsTable({
  nodeId,
  pairs,
  focusedPairKey,
  onPairClick,
}: {
  nodeId: string;
  pairs: readonly CascadePairEntry[];
  focusedPairKey: string | null;
  onPairClick: (key: string | null) => void;
}) {
  // Auto-scroll the focused row into view when the focus changes from
  // elsewhere (e.g. user clicks a pair line on the map).
  useEffect(() => {
    if (!focusedPairKey) return;
    const el = document.querySelector<HTMLTableRowElement>(
      `tr[data-pair-key="${CSS.escape(focusedPairKey)}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedPairKey]);

  return (
    <div className="pt-2 -mx-4">
      <div className="max-h-72 overflow-y-auto border-y border-zinc-100 dark:border-zinc-800">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-white dark:bg-zinc-950 text-zinc-400 font-normal">
            <tr>
              <th className="text-left px-4 py-1 font-normal"></th>
              <th className="text-left px-2 py-1 font-normal">pair</th>
              <th className="text-right px-2 py-1 font-normal">resid</th>
              <th className="text-right px-2 py-1 font-normal" title="direct walls (interior/exterior/doors)">
                walls
              </th>
              <th className="text-right px-2 py-1 font-normal" title="routed walls when ≠ direct">
                routed
              </th>
              <th className="text-right px-4 py-1 font-normal">w</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => {
              const isTx = p.txId === nodeId;
              const other = isTx ? p.rxId : p.txId;
              const role = isTx ? "→" : "←";
              const walls = `${p.walls.interior}i/${p.walls.exterior}e/${p.walls.doors}d`;
              const routed = p.routedPath
                ? `${p.routedPath.interior}i/${p.routedPath.exterior}e/${p.routedPath.doors}d`
                : null;
              const routedDiffers =
                routed != null && routed !== walls;
              const key = `${p.txId}|${p.rxId}`;
              const isFocused = focusedPairKey === key;
              return (
                <tr
                  key={key}
                  data-pair-key={key}
                  onClick={() => onPairClick(isFocused ? null : key)}
                  className={`border-t border-zinc-100 dark:border-zinc-900 cursor-pointer ${
                    isFocused
                      ? "bg-blue-50 dark:bg-blue-950/40 ring-1 ring-inset ring-blue-300 dark:ring-blue-800"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  }`}
                >
                  <td className="px-4 py-1 text-zinc-400">{role}</td>
                  <td className="px-2 py-1 font-mono truncate max-w-[120px]">
                    {other}
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-mono ${
                      p.residualDb != null
                        ? residualColor(p.residualDb)
                        : "text-zinc-400"
                    }`}
                  >
                    {p.residualDb != null
                      ? signedDb(p.residualDb).replace(" dB", "")
                      : "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-zinc-500">
                    {walls}
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-mono ${
                      routedDiffers
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-zinc-400"
                    }`}
                    title={
                      p.routedPath && p.routedPath.points.length > 2
                        ? "multi-hop routed path"
                        : undefined
                    }
                  >
                    {routedDiffers ? routed : "—"}
                  </td>
                  <td className="px-4 py-1 text-right font-mono text-zinc-500">
                    {p.weight < 10
                      ? p.weight.toFixed(1)
                      : Math.round(p.weight)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
