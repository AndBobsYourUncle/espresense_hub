"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Sparkles, Trash2, X, Activity } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { useUnits } from "@/components/UnitsProvider";
import { formatDistanceDisplay } from "@/lib/units";
import type {
  CalibrationResponse,
  NodeCalibrationDTO,
} from "@/app/api/calibration/route";
import type { AutofitResponse } from "@/app/api/calibration/autofit/route";
import type { ApplyResponse } from "@/app/api/calibration/apply/route";
import type { AutoApplyAuditResponse } from "@/app/api/calibration/audit/route";
import type { NodeFit, NodePairFit } from "@/lib/calibration/autofit";

const POLL_MS = 2000;
const MIN_CONFIDENT_SAMPLES = 20;

function biasClassification(
  meanMeters: number,
  count: number,
): { dot: string; row: string; label: string } {
  if (count < MIN_CONFIDENT_SAMPLES) {
    return {
      dot: "bg-zinc-400",
      row: "",
      label: "low confidence",
    };
  }
  const a = Math.abs(meanMeters);
  if (a < 0.5)
    return {
      dot: "bg-emerald-500",
      row: "",
      label: "good",
    };
  if (a < 1.5)
    return {
      dot: "bg-amber-500",
      row: "",
      label: "warning",
    };
  return {
    dot: "bg-red-500",
    row: "",
    label: "bad",
  };
}

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function useCalibration(): {
  data: CalibrationResponse | null;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<CalibrationResponse | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch("/api/calibration", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as CalibrationResponse;
      setData(json);
    } catch {
      // ignore — next tick retries
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchOnce();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchOnce]);

  return { data, refresh: fetchOnce };
}

export default function CalibrationPageClient() {
  const { data, refresh } = useCalibration();
  const { units } = useUnits();
  const [resetting, setResetting] = useState(false);

  // Auto-fit modal state
  const [proposals, setProposals] = useState<NodeFit[] | null>(null);
  const [fitting, setFitting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Expanded rows on the per-node table → show per-pair breakdown
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement | null>());

  // Auto-expand and scroll to a node when navigated here from the
  // inspection panel via `/calibration?node=<id>`.
  const searchParams = useSearchParams();
  const focusNode = searchParams.get("node");
  useEffect(() => {
    if (!focusNode) return;
    setExpandedNode(focusNode);
    // Wait for the row to render with the expanded sub-row, then scroll.
    const id = setTimeout(() => {
      const row = rowRefs.current.get(focusNode);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(id);
  }, [focusNode]);

  const handleReset = async () => {
    if (!window.confirm("Clear all per-node residual statistics?")) return;
    setResetting(true);
    try {
      await fetch("/api/calibration", { method: "DELETE" });
      await refresh();
    } finally {
      setResetting(false);
    }
  };

  const handleAutofit = async () => {
    setFitting(true);
    setApplyError(null);
    try {
      const res = await fetch("/api/calibration/autofit", { method: "POST" });
      if (!res.ok) {
        setApplyError(`autofit failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as AutofitResponse;
      setProposals(json.fits);
    } catch (err) {
      setApplyError((err as Error).message);
    } finally {
      setFitting(false);
    }
  };

  const handleApply = async () => {
    if (!proposals) return;
    const updates = proposals
      .filter((f) => f.confident)
      .map((f) => ({
        nodeId: f.nodeId,
        absorption: f.proposedAbsorption,
      }));
    if (updates.length === 0) {
      setApplyError("No confident fits to apply.");
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch("/api/calibration/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates, resetStats: true }),
      });
      const json = (await res.json()) as ApplyResponse;
      if (!json.ok) {
        setApplyError(
          `pushed ${json.pushed}, ${json.failed.length} failed: ${json.failed
            .map((f) => `${f.nodeId} (${f.error})`)
            .join(", ")}`,
        );
      } else {
        setProposals(null);
        await refresh();
      }
    } catch (err) {
      setApplyError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const rows = data?.nodes ?? [];
  const totalSamples = rows.reduce((s, n) => s + n.count, 0);

  return (
    <>
      <PageHeader
        title="Calibration"
        description={`${rows.length} node${rows.length === 1 ? "" : "s"} · ${totalSamples.toLocaleString()} residual samples`}
      />
      <main className="flex-1 min-h-0 p-6 overflow-auto">
        <div className="max-w-3xl space-y-4">
          <AutoApplyStatus />

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            <p className="font-medium text-zinc-900 dark:text-zinc-100 mb-1">
              Per-node distance bias
            </p>
            <p>
              For every device measurement, the locator computes the device&apos;s
              position from <em>all other</em> nodes (leave-one-out), then
              compares what the excluded node&apos;s distance{" "}
              <em>should</em> have been against what it actually reported.
              The mean of those residuals over time tells you whether a node
              is consistently over- or under-distancing.
            </p>
            <p className="mt-1.5">
              <span className="text-emerald-600 dark:text-emerald-400">+</span>{" "}
              positive bias = the node reports distances LARGER than reality.
              <br />
              <span className="text-emerald-600 dark:text-emerald-400">−</span>{" "}
              negative bias = the node reports distances SMALLER than reality.
            </p>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No residual data yet. Stats accumulate as device measurements
              arrive — you need at least 3 nodes reporting on the same device
              for any sample to be recorded.
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <Th>Node</Th>
                    <Th>Settings</Th>
                    <Th className="text-right">
                      GT bias
                      <div className="text-[9px] normal-case font-normal text-zinc-400">
                        node→node
                      </div>
                    </Th>
                    <Th className="text-right">
                      LOO bias
                      <div className="text-[9px] normal-case font-normal text-zinc-400">
                        leave-one-out
                      </div>
                    </Th>
                    <Th className="text-right">Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => {
                    // Use the better of the two for the indicator dot —
                    // ground truth wins if available.
                    const primaryBias =
                      n.gtCount > 0
                        ? n.gtMeanResidualMeters
                        : n.meanResidualMeters;
                    const primaryCount =
                      n.gtCount > 0 ? n.gtCount : n.count;
                    const cls = biasClassification(primaryBias, primaryCount);
                    const isExpanded = expandedNode === n.nodeId;
                    const hasPairs = n.pairs && n.pairs.length > 0;
                    return (
                      <Fragment key={n.nodeId}>
                      <tr
                        ref={(el) => {
                          rowRefs.current.set(n.nodeId, el);
                        }}
                        onClick={() =>
                          setExpandedNode(isExpanded ? null : n.nodeId)
                        }
                        className="border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-900/30 cursor-pointer"
                      >
                        <Td>
                          <div className="flex items-center gap-2">
                            {hasPairs ? (
                              isExpanded ? (
                                <ChevronDown className="h-3 w-3 text-zinc-400 shrink-0" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-zinc-400 shrink-0" />
                              )
                            ) : (
                              <span className="w-3" />
                            )}
                            <span className={`h-2 w-2 rounded-full ${cls.dot}`} />
                            <span className="font-medium text-zinc-900 dark:text-zinc-100">
                              {n.nodeId}
                            </span>
                            <span className="text-[10px] text-zinc-400">
                              {cls.label}
                            </span>
                          </div>
                        </Td>
                        <Td>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <SettingPill
                              label="abs"
                              value={n.settings["absorption"]}
                            />
                            <SettingPill
                              label="rx"
                              value={n.settings["rx_adj_rssi"]}
                            />
                            <SettingPill
                              label="tx"
                              value={n.settings["tx_ref_rssi"]}
                            />
                          </div>
                        </Td>
                        <Td className="text-right">
                          <BiasCell
                            mean={n.gtMeanResidualMeters}
                            stddev={n.gtStddevMeters}
                            count={n.gtCount}
                            units={units}
                          />
                        </Td>
                        <Td className="text-right">
                          <BiasCell
                            mean={n.meanResidualMeters}
                            stddev={n.stddevMeters}
                            count={n.count}
                            units={units}
                          />
                        </Td>
                        <Td className="text-right text-xs text-zinc-500">
                          {formatRelative(n.lastUpdated)}
                        </Td>
                      </tr>
                      {isExpanded && hasPairs && (
                        <tr className="border-t border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/40 dark:bg-zinc-900/20">
                          <td colSpan={5} className="px-4 py-3">
                            <PairBreakdown
                              listenerAbsorption={parseFloat(
                                n.settings["absorption"] ?? "2.7",
                              )}
                              pairs={n.pairs}
                              units={units}
                            />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 && (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleAutofit}
                disabled={fitting}
                title="Compute proposals now and review before applying. Background auto-apply runs every 5 min — this is for forcing an immediate review (e.g. after node config changes)."
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {fitting ? "Fitting…" : "Preview absorption fit"}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={resetting}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {resetting ? "Resetting…" : "Reset all stats"}
              </button>
            </div>
          )}

          {applyError && (
            <div className="rounded-md border border-red-300 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/30 px-4 py-2 text-xs text-red-700 dark:text-red-400">
              {applyError}
            </div>
          )}
        </div>
      </main>

      {proposals && (
        <AutofitModal
          proposals={proposals}
          onClose={() => setProposals(null)}
          onApply={handleApply}
          applying={applying}
        />
      )}
    </>
  );
}

function AutofitModal({
  proposals,
  onClose,
  onApply,
  applying,
}: {
  proposals: NodeFit[];
  onClose: () => void;
  onApply: () => void;
  applying: boolean;
}) {
  const confidentCount = proposals.filter((p) => p.confident).length;
  const skippedCount = proposals.length - confidentCount;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 px-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-sm font-semibold">Auto-fit absorption</div>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="px-4 py-3 text-xs text-zinc-500 leading-relaxed border-b border-zinc-200 dark:border-zinc-800">
            Closed-form per-node fit from ground-truth node-to-node samples.{" "}
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              {confidentCount}
            </span>{" "}
            of {proposals.length} nodes have a confident fit.
            {skippedCount > 0 && (
              <>
                {" "}
                <span className="text-amber-600 dark:text-amber-400">
                  {skippedCount} will be skipped
                </span>{" "}
                (not enough samples or too much spread).
              </>
            )}
          </div>

          <table className="w-full text-xs">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Node</th>
                <th className="px-4 py-2 text-right font-medium">Current</th>
                <th className="px-4 py-2 text-right font-medium">Proposed</th>
                <th className="px-4 py-2 text-right font-medium">Δ</th>
                <th className="px-4 py-2 text-right font-medium">IQR</th>
                <th className="px-4 py-2 text-right font-medium">Samples</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => {
                const delta = p.proposedAbsorption - p.currentAbsorption;
                return (
                  <tr
                    key={p.nodeId}
                    className={`border-t border-zinc-100 dark:border-zinc-800/60 ${
                      p.confident ? "" : "opacity-50"
                    }`}
                  >
                    <td className="px-4 py-2 font-medium">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            p.confident ? "bg-emerald-500" : "bg-zinc-400"
                          }`}
                        />
                        {p.nodeId}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {p.currentAbsorption.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-medium">
                      {p.proposedAbsorption.toFixed(2)}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-mono ${
                        delta > 0
                          ? "text-emerald-700 dark:text-emerald-400"
                          : delta < 0
                            ? "text-red-700 dark:text-red-400"
                            : "text-zinc-500"
                      }`}
                    >
                      {delta >= 0 ? "+" : ""}
                      {delta.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-500">
                      ±{(p.iqr / 2).toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-500">
                      {p.validSamples.toLocaleString()}
                      {p.outliers > 0 && (
                        <span className="text-amber-500">
                          {" "}
                          ({p.outliers} outl.)
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <footer className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applying || confidentCount === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className="h-3 w-3" />
            {applying
              ? "Applying…"
              : `Push ${confidentCount} value${confidentCount === 1 ? "" : "s"} via MQTT`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-4 py-2.5 text-left font-medium ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 ${className ?? ""}`}>{children}</td>;
}

/**
 * Shows the live auto-apply status: when it last fired, how many
 * actions in the last hour, recent events. The auto-apply runs in
 * the background every 5 minutes and pushes confident absorption
 * updates to firmware automatically — this is the user's window
 * into what it's been doing.
 */
function AutoApplyStatus() {
  const [audit, setAudit] = useState<AutoApplyAuditResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/calibration/audit");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as AutoApplyAuditResponse;
        if (!cancelled) setAudit(data);
      } catch {
        // best-effort
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!audit) return null;

  const events = audit.events;
  const lastEvent = events[0];
  const hourAgo = Date.now() - 3_600_000;
  const lastHourCount = events.filter((e) => e.timestamp >= hourAgo).length;
  const intervalMin = audit.cycleIntervalMs / 60_000;

  const lastAgo = lastEvent
    ? formatRelativeTime(audit.serverTime - lastEvent.timestamp)
    : null;

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 px-4 py-3 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          <span className="font-medium">Auto-apply</span>
          <span className="text-zinc-500">
            cycles every {intervalMin.toFixed(0)}m
          </span>
        </div>
        <div className="flex items-center gap-2 text-zinc-500">
          {lastEvent ? (
            <>
              <span>last action {lastAgo}</span>
              <span>·</span>
              <span>
                {lastHourCount} change{lastHourCount === 1 ? "" : "s"} in last
                hour
              </span>
            </>
          ) : (
            <span>system stable — no changes pushed yet</span>
          )}
          <ChevronDown
            className={`h-3 w-3 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          {events.length === 0 ? (
            <div className="text-zinc-500">
              No auto-apply events yet. The system pushes a calibration
              update when a node&apos;s proposed absorption differs from its
              current value by more than 0.05 (rate-limited to once per
              10 minutes per node).
            </div>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead className="text-[10px] uppercase text-zinc-400">
                <tr>
                  <th className="text-left font-normal py-1">when</th>
                  <th className="text-left font-normal py-1">node</th>
                  <th className="text-right font-normal py-1">old → new</th>
                  <th className="text-right font-normal py-1">Δ</th>
                  <th className="text-right font-normal py-1">samples</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 30).map((e, i) => (
                  <tr
                    key={`${e.timestamp}-${e.nodeId}-${i}`}
                    className="border-t border-zinc-100 dark:border-zinc-800/50"
                  >
                    <td className="py-1 text-zinc-500">
                      {formatRelativeTime(audit.serverTime - e.timestamp)}
                    </td>
                    <td className="py-1 text-zinc-700 dark:text-zinc-200">
                      {e.nodeId}
                    </td>
                    <td className="py-1 text-right text-zinc-700 dark:text-zinc-200">
                      {e.oldValue.toFixed(2)} → {e.newValue.toFixed(2)}
                    </td>
                    <td
                      className={`py-1 text-right ${
                        e.delta > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {e.delta >= 0 ? "+" : ""}
                      {e.delta.toFixed(2)}
                    </td>
                    <td className="py-1 text-right text-zinc-400">
                      {e.validSamples}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function PairBreakdown({
  listenerAbsorption,
  pairs,
  units,
}: {
  listenerAbsorption: number;
  pairs: NodePairFit[];
  units: "metric" | "imperial";
}) {
  // Sort by absolute deviation from listener average — most divergent first.
  const sorted = [...pairs].sort(
    (a, b) =>
      Math.abs(b.perPairAbsorption - listenerAbsorption) -
      Math.abs(a.perPairAbsorption - listenerAbsorption),
  );

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-400">
        Per-pair fits ({pairs.length} neighbors)
      </div>
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-zinc-400">
          <tr>
            <th className="text-left font-normal px-2 py-1">Transmitter</th>
            <th className="text-right font-normal px-2 py-1">True dist</th>
            <th className="text-right font-normal px-2 py-1">Per-pair n</th>
            <th className="text-right font-normal px-2 py-1">Δ from avg</th>
            <th className="text-right font-normal px-2 py-1">IQR</th>
            <th className="text-right font-normal px-2 py-1">Samples</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const delta = p.perPairAbsorption - listenerAbsorption;
            const absDelta = Math.abs(delta);
            const deltaCls =
              absDelta < 0.2
                ? "text-zinc-500"
                : absDelta < 0.5
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400";
            return (
              <tr
                key={p.transmitterId}
                className="border-t border-zinc-100/60 dark:border-zinc-800/40"
              >
                <td className="px-2 py-1 font-mono">{p.transmitterId}</td>
                <td className="px-2 py-1 text-right font-mono text-zinc-500">
                  {formatDistanceDisplay(p.meanTrueDist, units)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-900 dark:text-zinc-100">
                  {p.perPairAbsorption.toFixed(2)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${deltaCls}`}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(2)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-500">
                  ±{(p.iqr / 2).toFixed(2)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-500">
                  {p.validSamples}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-[10px] text-zinc-400 leading-relaxed">
        Each row is the absorption that would make this single (listener →
        transmitter) path read accurately. The listener-level absorption
        ({listenerAbsorption.toFixed(2)}) is the median across all pairs.
        Pairs with large Δ are paths through unusually strong or weak
        attenuation — typically extra walls, metal furniture, or open
        line-of-sight.
      </div>
    </div>
  );
}

function BiasCell({
  mean,
  stddev,
  count,
  units,
}: {
  mean: number;
  stddev: number;
  count: number;
  units: "metric" | "imperial";
}) {
  // Always render the two-line structure even when empty — otherwise the
  // row height jumps each time a poll flips count between 0 and >0, which
  // creates noticeable visual reflow in the table on every refresh.
  // tabular-nums keeps digit widths consistent so the column doesn't
  // wiggle as values change either.
  const hasData = count > 0;
  return (
    <div className="font-mono text-xs leading-tight tabular-nums">
      <div className={hasData ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-300"}>
        {hasData
          ? `${mean >= 0 ? "+" : ""}${formatDistanceDisplay(mean, units)}`
          : "—"}
      </div>
      <div className="text-[10px] text-zinc-400">
        {hasData
          ? `±${formatDistanceDisplay(stddev, units)} · ${count.toLocaleString()}`
          : "\u00a0"}
      </div>
    </div>
  );
}

function SettingPill({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  if (value == null) {
    return (
      <span className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 text-[10px] text-zinc-400 font-mono">
        <span className="uppercase tracking-wide">{label}</span>
        <span>—</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 text-[10px] font-mono">
      <span className="uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="text-zinc-900 dark:text-zinc-100">{value}</span>
    </span>
  );
}
