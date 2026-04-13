"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCompareArrows,
  Sparkles,
  Timer,
  Trash2,
  X,
} from "lucide-react";
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
import type { DevicePositionsResponse } from "@/app/api/devices/positions/route";
import type { NodeFit, NodePairFit } from "@/lib/calibration/autofit";
import { LOCATOR_LABELS } from "@/components/map/locatorColors";

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

/**
 * Fetch the auto-apply audit + rate-limit state every 10 s. Returns the
 * snapshot plus a tick that increments every second so consumers can
 * re-render countdowns between fetches.
 */
function useAuditState(): {
  audit: AutoApplyAuditResponse | null;
  /** A monotonically increasing tick so callers can trigger re-renders. */
  tick: number;
} {
  const [audit, setAudit] = useState<AutoApplyAuditResponse | null>(null);
  const [tick, setTick] = useState(0);

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
    const fetchId = setInterval(load, 10_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => {
      cancelled = true;
      clearInterval(fetchId);
      clearInterval(tickId);
    };
  }, []);

  return { audit, tick };
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
  const { audit } = useAuditState();
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
          <AutoApplyStatus audit={audit} />
          <LocatorComparisonPanel />

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
            <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No residual data yet. Stats accumulate as device measurements
              arrive — you need at least 3 nodes reporting on the same device
              for any sample to be recorded.
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  <tr>
                    <Th>Node</Th>
                    <Th>Settings</Th>
                    <Th className="text-right whitespace-nowrap">
                      GT bias
                      <div className="text-xs normal-case font-normal tracking-normal text-zinc-400 whitespace-nowrap">
                        node→node
                      </div>
                    </Th>
                    <Th className="text-right whitespace-nowrap">
                      LOO bias
                      <div className="text-xs normal-case font-normal tracking-normal text-zinc-400 whitespace-nowrap">
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
                            <span className="text-xs text-zinc-400">
                              {cls.label}
                            </span>
                            <RateLimitBadge nodeId={n.nodeId} audit={audit} />
                          </div>
                        </Td>
                        <Td>
                          {/* flex-nowrap (not flex-wrap) so the three
                              pills always stay on one line, even when
                              other cells push the column narrow. The
                              row height should never flip from 1 to 2
                              lines because of column-width drift. */}
                          <div className="flex items-center gap-1.5 flex-nowrap whitespace-nowrap">
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
                        <Td className="text-right text-xs text-zinc-500 dark:text-zinc-400">
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
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed border-b border-zinc-200 dark:border-zinc-800">
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
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
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
                            : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {delta >= 0 ? "+" : ""}
                      {delta.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-500 dark:text-zinc-400">
                      ±{(p.iqr / 2).toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-500 dark:text-zinc-400">
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
 * Shows the live auto-apply status: cycle countdown, recent events,
 * currently rate-limited nodes. The auto-apply runs in the background
 * every 5 minutes and pushes confident absorption updates to firmware
 * automatically — this is the user's window into what it's been doing
 * and what it's about to do.
 */
function AutoApplyStatus({
  audit,
}: {
  audit: AutoApplyAuditResponse | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!audit) return null;

  const now = Date.now();
  // Estimate the next cycle from the latest event; if no events yet, fall
  // back to "anytime within cycleIntervalMs" — we don't know the exact
  // boot time. The UI will be roughly right within a cycle.
  const events = audit.events;
  const lastEvent = events[0];
  const lastEventAt = lastEvent?.timestamp ?? null;
  const nextCycleAt = lastEventAt
    ? lastEventAt + audit.cycleIntervalMs
    : now + audit.cycleIntervalMs;
  const nextCycleMs = Math.max(0, nextCycleAt - now);

  const hourAgo = now - 3_600_000;
  const lastHourCount = events.filter((e) => e.timestamp >= hourAgo).length;
  const intervalMin = audit.cycleIntervalMs / 60_000;
  const rateLimitMin = audit.rateLimitMs / 60_000;

  // Nodes that pushed recently and can't be re-pushed yet — sorted by
  // soonest-to-clear first so the user sees an actionable countdown.
  const rateLimited: Array<{ nodeId: string; clearsInMs: number }> = [];
  for (const [nodeId, ts] of Object.entries(audit.lastAutoApplyByNode)) {
    const clearsAt = ts + audit.rateLimitMs;
    const clearsInMs = clearsAt - now;
    if (clearsInMs > 0) rateLimited.push({ nodeId, clearsInMs });
  }
  rateLimited.sort((a, b) => a.clearsInMs - b.clearsInMs);

  const lastAgo = lastEvent
    ? formatRelativeTime(audit.serverTime - lastEvent.timestamp)
    : null;

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center justify-between gap-2 text-left px-4 py-3"
      >
        <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          <span className="font-medium">Auto-apply</span>
          <span
            className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400"
            title={`Cycle runs every ${intervalMin.toFixed(0)} minutes`}
          >
            <Timer className="h-3 w-3" />
            next in {formatCountdown(nextCycleMs)}
          </span>
          {rateLimited.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"
              title={`${rateLimited.length} node${rateLimited.length === 1 ? "" : "s"} rate-limited (${rateLimitMin.toFixed(0)}-min cooldown after each push)`}
            >
              <Clock className="h-3 w-3" />
              {rateLimited.length} cooling
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
          {lastEvent ? (
            <>
              <span>last action {lastAgo}</span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span>
                {lastHourCount} change{lastHourCount === 1 ? "" : "s"}/hr
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
        <div className="px-4 pb-3 space-y-4 border-t border-zinc-200 dark:border-zinc-800 pt-3">
          {/* Rate-limited nodes section — only shown if any are cooling. */}
          {rateLimited.length > 0 && (
            <section>
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
                <Clock className="h-3 w-3" />
                Rate-limited
                <span className="normal-case tracking-normal text-zinc-400">
                  · pushed within last {rateLimitMin.toFixed(0)} min,
                  cannot re-push until cooldown clears
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs">
                {rateLimited.map((r) => (
                  <div
                    key={r.nodeId}
                    className="flex items-center justify-between gap-2 py-0.5 px-2 rounded bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300"
                  >
                    <span className="truncate">{r.nodeId}</span>
                    <span className="text-amber-600/70 dark:text-amber-400/70 shrink-0 tabular-nums">
                      {formatCountdown(r.clearsInMs)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Recent events section. */}
          <section>
            <div className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
              Recent pushes
              {events.length > 0 && (
                <span className="normal-case tracking-normal text-zinc-400">
                  {" "}
                  · showing {Math.min(events.length, 30)} of {events.length}
                </span>
              )}
            </div>
            {events.length === 0 ? (
              <div className="text-zinc-500 dark:text-zinc-400 text-xs leading-relaxed">
                No auto-apply events yet. The system pushes a calibration
                update when a node&apos;s proposed absorption differs from
                its current value by more than 0.05 (rate-limited to once
                per {rateLimitMin.toFixed(0)} minutes per node). With
                everything within threshold, nothing needs pushing —
                that&apos;s the steady state.
              </div>
            ) : (
              <table className="w-full text-xs font-mono tabular-nums">
                <thead className="text-xs uppercase text-zinc-400">
                  <tr>
                    <th className="text-left font-normal py-1 w-20">when</th>
                    <th className="text-left font-normal py-1">node</th>
                    <th className="text-right font-normal py-1">old → new</th>
                    <th className="text-right font-normal py-1 w-12">Δ</th>
                    <th className="text-right font-normal py-1 w-16">
                      samples
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 30).map((e, i) => (
                    <tr
                      key={`${e.timestamp}-${e.nodeId}-${i}`}
                      className="border-t border-zinc-100 dark:border-zinc-800/50"
                    >
                      <td className="py-1 text-zinc-500 dark:text-zinc-400">
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
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * Small inline badge that appears next to a node's name in the calibration
 * table when that node was recently auto-applied and is still inside its
 * cooldown window. Shows the time remaining until the next push is allowed.
 * Renders nothing when the node is not rate-limited — so rows stay clean
 * the rest of the time.
 */
function RateLimitBadge({
  nodeId,
  audit,
}: {
  nodeId: string;
  audit: AutoApplyAuditResponse | null;
}) {
  if (!audit) return null;
  const lastApplied = audit.lastAutoApplyByNode[nodeId];
  if (!lastApplied) return null;
  const clearsAt = lastApplied + audit.rateLimitMs;
  const clearsInMs = clearsAt - Date.now();
  if (clearsInMs <= 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400"
      title={`Auto-apply pushed this node ${formatRelativeTime(Date.now() - lastApplied)}; next push allowed in ${formatCountdown(clearsInMs)} (${(audit.rateLimitMs / 60_000).toFixed(0)}-min cooldown)`}
    >
      <Clock className="h-2.5 w-2.5" />
      {formatCountdown(clearsInMs)}
    </span>
  );
}

/**
 * Cross-locator comparison panel. Shows running mean distance from
 * each non-active locator's output to ours, persisted across restarts.
 * Aggregates across all devices for the headline number; expands per-
 * device for diagnostic drill-down. Polls /api/devices/positions every
 * 5 s for fresh stats.
 */
function LocatorComparisonPanel() {
  const { units } = useUnits();
  const [data, setData] = useState<DevicePositionsResponse | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openDevice, setOpenDevice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/devices/positions", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as DevicePositionsResponse;
        if (!cancelled) setData(json);
      } catch {
        // best-effort
      }
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const aggregates = useAggregates(data);
  if (!data) return null;
  const totalSamples = aggregates.reduce((s, a) => s + a.count, 0);
  if (aggregates.length === 0 || totalSamples === 0) return null;

  // Headline number: smallest mean Δ (probably IDW since it agrees with
  // RoomAware most), and largest (probably ESP-Companion).
  const sorted = [...aggregates].sort((a, b) => a.mean - b.mean);
  const closest = sorted[0];
  const farthest = sorted[sorted.length - 1];

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center justify-between gap-2 text-left px-4 py-3"
      >
        <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <GitCompareArrows className="h-3.5 w-3.5 text-purple-500" />
          <span className="font-medium">Locator comparison</span>
          <span className="text-zinc-500 dark:text-zinc-400">
            {aggregates.length} locators · {totalSamples.toLocaleString()} total
            samples
          </span>
        </div>
        <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
          {closest && farthest && closest.key !== farthest.key && (
            <>
              <span className="text-emerald-600 dark:text-emerald-400 font-mono">
                closest: {LOCATOR_LABELS[closest.key] ?? closest.key}{" "}
                {formatDistanceDisplay(closest.mean, units)}
              </span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-amber-600 dark:text-amber-400 font-mono">
                farthest: {LOCATOR_LABELS[farthest.key] ?? farthest.key}{" "}
                {formatDistanceDisplay(farthest.mean, units)}
              </span>
            </>
          )}
          <ChevronDown
            className={`h-3 w-3 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-4 border-t border-zinc-200 dark:border-zinc-800 pt-3">
          {/* Aggregate table */}
          <section>
            <div className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
              Aggregate (all devices, sample-weighted)
            </div>
            <table className="w-full text-xs font-mono tabular-nums">
              <thead className="text-xs uppercase text-zinc-400 dark:text-zinc-500">
                <tr>
                  <th className="text-left font-normal py-1">locator</th>
                  <th className="text-right font-normal py-1">mean Δ</th>
                  <th className="text-right font-normal py-1">σ</th>
                  <th className="text-right font-normal py-1">samples</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => (
                  <tr
                    key={a.key}
                    className="border-t border-zinc-100 dark:border-zinc-800/50"
                  >
                    <td className="py-1 text-zinc-700 dark:text-zinc-200">
                      {LOCATOR_LABELS[a.key] ?? a.key}
                    </td>
                    <td className="py-1 text-right">
                      {formatDistanceDisplay(a.mean, units)}
                    </td>
                    <td className="py-1 text-right text-zinc-500 dark:text-zinc-400">
                      {formatDistanceDisplay(a.stddev, units)}
                    </td>
                    <td className="py-1 text-right text-zinc-500 dark:text-zinc-400">
                      {a.count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Per-device drill-down */}
          <section>
            <div className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
              Per-device
            </div>
            <div className="space-y-1">
              {data.devices
                .filter(
                  (d) =>
                    d.locatorDeltas &&
                    Object.keys(d.locatorDeltas).length > 0,
                )
                .map((d) => {
                  const isOpen = openDevice === d.id;
                  const entries = Object.entries(d.locatorDeltas ?? {}).sort(
                    ([, a], [, b]) => a.mean - b.mean,
                  );
                  return (
                    <div
                      key={d.id}
                      className="rounded border border-zinc-200 dark:border-zinc-800 overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => setOpenDevice(isOpen ? null : d.id)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {isOpen ? (
                            <ChevronDown className="h-3 w-3 text-zinc-400 shrink-0" />
                          ) : (
                            <ChevronRight className="h-3 w-3 text-zinc-400 shrink-0" />
                          )}
                          <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                            {d.name ?? d.id}
                          </span>
                        </div>
                        <span className="text-zinc-500 dark:text-zinc-400 font-mono shrink-0">
                          {entries.length} locators
                        </span>
                      </button>
                      {isOpen && (
                        <table className="w-full text-xs font-mono tabular-nums border-t border-zinc-100 dark:border-zinc-800/50">
                          <tbody>
                            {entries.map(([algo, s]) => (
                              <tr
                                key={algo}
                                className="border-t border-zinc-100 dark:border-zinc-800/50 first:border-t-0"
                              >
                                <td className="py-1 px-3 text-zinc-700 dark:text-zinc-200">
                                  {LOCATOR_LABELS[algo] ?? algo}
                                </td>
                                <td className="py-1 px-3 text-right">
                                  {formatDistanceDisplay(s.mean, units)}
                                </td>
                                <td className="py-1 px-3 text-right text-zinc-500 dark:text-zinc-400 w-20">
                                  ±{formatDistanceDisplay(s.stddev, units)}
                                </td>
                                <td className="py-1 px-3 text-right text-zinc-500 dark:text-zinc-400 w-20">
                                  {s.count.toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
            </div>
          </section>

          <div className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Distance from each comparison locator&apos;s output to our
            active position, averaged across the lifetime of the system
            (persisted across restarts). Cross-device aggregate is
            sample-weighted. Capped at 10 000 samples per pair to bound
            precision; older samples decay proportionally past that.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compute sample-weighted aggregate stats per locator across all devices.
 * Sum-weighted mean and pooled-variance stddev (correct for combining
 * different per-device sample counts).
 */
function useAggregates(
  data: DevicePositionsResponse | null,
): Array<{ key: string; mean: number; stddev: number; count: number }> {
  if (!data) return [];
  const sumByAlgo = new Map<string, number>();
  const sumSqByAlgo = new Map<string, number>();
  const countByAlgo = new Map<string, number>();
  for (const d of data.devices) {
    if (!d.locatorDeltas) continue;
    for (const [algo, s] of Object.entries(d.locatorDeltas)) {
      // Reconstruct sum and sumSq from the per-device aggregate (mean,
      // stddev, count) so we can correctly recombine across devices.
      // sum = mean * count; sumSq = (variance + mean²) * count
      const sum = s.mean * s.count;
      const variance = s.stddev * s.stddev;
      const sumSq = (variance + s.mean * s.mean) * s.count;
      sumByAlgo.set(algo, (sumByAlgo.get(algo) ?? 0) + sum);
      sumSqByAlgo.set(algo, (sumSqByAlgo.get(algo) ?? 0) + sumSq);
      countByAlgo.set(algo, (countByAlgo.get(algo) ?? 0) + s.count);
    }
  }
  const out: Array<{ key: string; mean: number; stddev: number; count: number }> = [];
  for (const [algo, count] of countByAlgo) {
    if (count <= 0) continue;
    const mean = (sumByAlgo.get(algo) ?? 0) / count;
    const variance = Math.max(
      0,
      (sumSqByAlgo.get(algo) ?? 0) / count - mean * mean,
    );
    out.push({ key: algo, mean, stddev: Math.sqrt(variance), count });
  }
  return out;
}

/** Format a positive ms duration as "Mm SSs" or "MM:SS" for short windows. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
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
      <div className="text-xs uppercase tracking-wide text-zinc-400">
        Per-pair fits ({pairs.length} neighbors)
      </div>
      <table className="w-full text-xs">
        <thead className="text-xs uppercase tracking-wide text-zinc-400">
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
                ? "text-zinc-500 dark:text-zinc-400"
                : absDelta < 0.5
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400";
            return (
              <tr
                key={p.transmitterId}
                className="border-t border-zinc-100/60 dark:border-zinc-800/40"
              >
                <td className="px-2 py-1 font-mono">{p.transmitterId}</td>
                <td className="px-2 py-1 text-right font-mono text-zinc-500 dark:text-zinc-400">
                  {formatDistanceDisplay(p.meanTrueDist, units)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-900 dark:text-zinc-100">
                  {p.perPairAbsorption.toFixed(2)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${deltaCls}`}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(2)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-500 dark:text-zinc-400">
                  ±{(p.iqr / 2).toFixed(2)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-500 dark:text-zinc-400">
                  {p.validSamples}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-xs text-zinc-400 leading-relaxed">
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
    <div className="font-mono text-xs leading-tight tabular-nums whitespace-nowrap">
      <div className={hasData ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-300"}>
        {hasData
          ? `${mean >= 0 ? "+" : ""}${formatDistanceDisplay(mean, units)}`
          : "—"}
      </div>
      <div className="text-xs text-zinc-400">
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
      <span className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 text-xs text-zinc-400 font-mono">
        <span className="uppercase tracking-wide">{label}</span>
        <span>—</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 text-xs font-mono">
      <span className="uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-zinc-900 dark:text-zinc-100">{value}</span>
    </span>
  );
}
