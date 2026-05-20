import { promises as fs } from "node:fs";
import path from "node:path";
import type { PairStats } from "@/lib/calibration/autofit";
import type {
  CascadeFit,
  NodeOffsets,
  PairRssiStats,
} from "@/lib/calibration/cascade";
import { resolveConfigPath } from "@/lib/config/load";
import type {
  GroundTruthSample,
  NodeResidualStats,
  Store,
} from "@/lib/state/store";

/**
 * Persist calibration runtime state across app restarts.
 *
 * What's saved:
 *   - Per-pair streaming sufficient stats (nodePairFitStats) — what
 *     PathAware uses at solve time.
 *   - Ground-truth sample ring buffer — what fitAllNodes reads to
 *     produce per-listener absorption proposals.
 *   - Residual aggregators (LOO + GT) — diagnostic continuity for the
 *     calibration page.
 *
 * What's NOT saved (intentionally transient):
 *   - Device positions/measurements (refill from MQTT in seconds)
 *   - MQTT connection state
 *   - Node telemetry / online status
 *   - Currently-active pin (always loads inactive — user re-clicks)
 *
 * File: `calibration.json` next to config.yaml. Saved every 60 s by a
 * background timer, plus a final flush on graceful shutdown.
 */

const FILE_NAME = "calibration.json";

/**
 * v1: the original — pair fit stats, ground-truth samples, residuals.
 * v2: adds cascade calibration (Phase 1 of state-tracker rebuild):
 *   - per-(TX, RX) RSSI residual stats
 *   - latest cascade fit (Layer 1 + 2 parameters)
 *
 * The loader accepts both versions; v1 files just don't have the
 * cascade fields, which means the cascade re-bootstraps from scratch
 * on a v1→v2 upgrade. That converges in hours once MQTT runs.
 */
interface CalibrationFileV1 {
  version: 1;
  savedAt: number;
  pairFitStats: Record<string, Record<string, PairStats>>;
  groundTruthSamples: Record<string, GroundTruthSample[]>;
  residuals: Record<
    string,
    {
      loo?: NodeResidualStats;
      gt?: NodeResidualStats;
    }
  >;
}

interface SerializedCascadeFit {
  pathLossExponent: number;
  wallAttenuationDb: number;
  exteriorWallAttenuationDb: number;
  doorAttenuationDb: number;
  /** Phase 1.7+. Optional for back-compat with older saved fits. */
  reflectionLossDb?: number;
  referenceRssi1m: number;
  nodeOffsets: Record<string, { txOffsetDb: number; rxOffsetDb: number }>;
  referenceNodeId: string | null;
  rSquared: number;
  residualStdDb: number;
  pairCount: number;
  totalWeight: number;
  fittedAtMs: number;
}

interface CalibrationFileV2 {
  version: 2;
  savedAt: number;
  pairFitStats: Record<string, Record<string, PairStats>>;
  groundTruthSamples: Record<string, GroundTruthSample[]>;
  residuals: Record<
    string,
    {
      loo?: NodeResidualStats;
      gt?: NodeResidualStats;
    }
  >;
  /** Cascade per-(TX, RX) RSSI residual stats, txId → rxId → stats. */
  cascadePairStats?: Record<string, Record<string, PairRssiStatsSerialized>>;
  /** Most recent cascade fit; serialized form (Map → Record). */
  latestCascadeFit?: SerializedCascadeFit;
}

/** Stripped serialized form of PairRssiStats — no recent ring buffer for size. */
interface PairRssiStatsSerialized {
  weight: number;
  sumRssi: number;
  sumRssiSq: number;
  trueDist: number;
  walls: { interior: number; exterior: number; doors: number };
  lastUpdateMs: number;
  totalSamples: number;
}

type CalibrationFile = CalibrationFileV1 | CalibrationFileV2;

function calibrationPath(): string {
  return path.join(path.dirname(resolveConfigPath()), FILE_NAME);
}

/**
 * Load persisted calibration state into the store. Called on bootstrap,
 * before MQTT connects. Silently no-ops if the file doesn't exist
 * (first run on a fresh install).
 */
export async function loadCalibration(store: Store): Promise<void> {
  const filePath = calibrationPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[cal-persist] no existing file at ${filePath}`);
      return;
    }
    throw err;
  }

  let parsed: CalibrationFile;
  try {
    parsed = JSON.parse(raw) as CalibrationFile;
  } catch (err) {
    console.error(
      `[cal-persist] failed to parse ${filePath}:`,
      (err as Error).message,
    );
    return;
  }

  const version = (parsed as { version?: number }).version;
  if (version !== 1 && version !== 2) {
    console.warn(
      `[cal-persist] ${filePath} has unknown version ${String(version)}, ignoring`,
    );
    return;
  }

  const ageMs = Date.now() - (parsed.savedAt ?? 0);
  const ageHours = ageMs / 3_600_000;
  if (ageHours > 24) {
    console.warn(
      `[cal-persist] saved state is ${ageHours.toFixed(1)}h old — ` +
        `if your nodes/environment changed during downtime, consider ` +
        `deleting ${filePath} for a clean recalibration.`,
    );
  }

  // Restore pair fit stats.
  let pairCount = 0;
  for (const [listenerId, byTx] of Object.entries(parsed.pairFitStats ?? {})) {
    const map = new Map<string, PairStats>();
    for (const [txId, stats] of Object.entries(byTx)) {
      if (
        typeof stats?.W === "number" &&
        typeof stats?.SumN === "number" &&
        typeof stats?.SumN2 === "number"
      ) {
        map.set(txId, {
          W: stats.W,
          SumN: stats.SumN,
          SumN2: stats.SumN2,
          meanTrueDist: stats.meanTrueDist ?? 0,
          meanMeasured: stats.meanMeasured ?? 0,
          lastUpdateMs: stats.lastUpdateMs ?? 0,
        });
        pairCount += 1;
      }
    }
    if (map.size > 0) store.nodePairFitStats.set(listenerId, map);
  }

  // Restore ground-truth samples.
  let sampleCount = 0;
  for (const [listenerId, samples] of Object.entries(
    parsed.groundTruthSamples ?? {},
  )) {
    if (!Array.isArray(samples)) continue;
    const valid = samples.filter(
      (s) =>
        typeof s?.transmitterId === "string" &&
        typeof s?.measured === "number" &&
        typeof s?.trueDist === "number" &&
        typeof s?.absorptionAtTime === "number" &&
        typeof s?.timestamp === "number",
    );
    if (valid.length > 0) {
      store.nodeGroundTruthSamples.set(listenerId, valid);
      sampleCount += valid.length;
    }
  }

  // Restore residual aggregators.
  let residualNodeCount = 0;
  for (const [nodeId, r] of Object.entries(parsed.residuals ?? {})) {
    if (r.loo) store.nodeResiduals.set(nodeId, { ...r.loo });
    if (r.gt) store.nodeGroundTruthResiduals.set(nodeId, { ...r.gt });
    if (r.loo || r.gt) residualNodeCount += 1;
  }

  // Restore cascade-calibration state (v2+ only). v1 files just
  // skip this — cascade re-bootstraps from incoming MQTT samples.
  let cascadePairCount = 0;
  if (parsed.version === 2) {
    for (const [txId, byRx] of Object.entries(parsed.cascadePairStats ?? {})) {
      const inner = new Map<string, PairRssiStats>();
      for (const [rxId, s] of Object.entries(byRx)) {
        if (
          typeof s?.weight === "number" &&
          typeof s?.sumRssi === "number" &&
          typeof s?.trueDist === "number" &&
          s?.walls != null
        ) {
          inner.set(rxId, {
            weight: s.weight,
            sumRssi: s.sumRssi,
            sumRssiSq: s.sumRssiSq,
            trueDist: s.trueDist,
            walls: { ...s.walls },
            lastUpdateMs: s.lastUpdateMs ?? 0,
            totalSamples: s.totalSamples ?? Math.round(s.weight),
            // Ring buffer is not persisted (size + recency-only value).
            // Re-populates from new MQTT samples after restart.
            recent: [],
          });
          cascadePairCount += 1;
        }
      }
      if (inner.size > 0) store.pairRssiStats.set(txId, inner);
    }
    if (parsed.latestCascadeFit) {
      const f = parsed.latestCascadeFit;
      const nodeOffsets = new Map<string, NodeOffsets>();
      for (const [id, o] of Object.entries(f.nodeOffsets ?? {})) {
        nodeOffsets.set(id, {
          txOffsetDb: o.txOffsetDb ?? 0,
          rxOffsetDb: o.rxOffsetDb ?? 0,
        });
      }
      const restored: CascadeFit = {
        pathLossExponent: f.pathLossExponent,
        wallAttenuationDb: f.wallAttenuationDb,
        exteriorWallAttenuationDb: f.exteriorWallAttenuationDb,
        doorAttenuationDb: f.doorAttenuationDb,
        // Default reflection loss to 6 dB (the prior mean) when
        // restoring a pre-Phase-1.7 saved fit.
        reflectionLossDb: f.reflectionLossDb ?? 6.0,
        referenceRssi1m: f.referenceRssi1m,
        nodeOffsets,
        referenceNodeId: f.referenceNodeId,
        rSquared: f.rSquared,
        residualStdDb: f.residualStdDb,
        pairCount: f.pairCount,
        totalWeight: f.totalWeight,
        fittedAtMs: f.fittedAtMs,
        // Routed paths aren't persisted (recomputed on next refit
        // from current routing graph). Restore as empty.
        routedPaths: new Map(),
      };
      store.latestCascadeFit = restored;
    }
  }

  console.log(
    `[cal-persist] loaded: ${pairCount} pair stats · ${sampleCount} GT samples · ${residualNodeCount} residual aggregates · ${cascadePairCount} cascade pairs (saved ${ageHours.toFixed(1)}h ago)`,
  );

  // Rebuild derived nodePairFits from the restored stats. This avoids a
  // 5-minute window after restart where PathAware has streaming stats
  // but no derived NodePairFit objects yet.
  const { refreshNodePairFits } = await import("@/lib/calibration/autofit");
  refreshNodePairFits(store);
}

/**
 * Save the current calibration state to disk. Called on a 60 s timer
 * and from graceful-shutdown handlers. Atomic: writes to .tmp then
 * renames over the live file so a crash mid-write can't corrupt.
 */
export async function saveCalibration(store: Store): Promise<void> {
  const filePath = calibrationPath();

  const data: CalibrationFileV2 = {
    version: 2,
    savedAt: Date.now(),
    pairFitStats: {},
    groundTruthSamples: {},
    residuals: {},
  };

  // Pair fit stats.
  for (const [listenerId, byTx] of store.nodePairFitStats) {
    if (byTx.size === 0) continue;
    const obj: Record<string, PairStats> = {};
    for (const [txId, stats] of byTx) {
      obj[txId] = { ...stats };
    }
    data.pairFitStats[listenerId] = obj;
  }

  // Ground-truth samples.
  for (const [listenerId, samples] of store.nodeGroundTruthSamples) {
    if (samples.length === 0) continue;
    data.groundTruthSamples[listenerId] = samples;
  }

  // Residuals.
  for (const nodeId of new Set([
    ...store.nodeResiduals.keys(),
    ...store.nodeGroundTruthResiduals.keys(),
  ])) {
    const loo = store.nodeResiduals.get(nodeId);
    const gt = store.nodeGroundTruthResiduals.get(nodeId);
    if (loo || gt) {
      data.residuals[nodeId] = {
        loo: loo ? { ...loo } : undefined,
        gt: gt ? { ...gt } : undefined,
      };
    }
  }

  // Cascade calibration (v2): per-pair RSSI residual stats + most
  // recent fit. Ring buffer of recent samples is intentionally not
  // persisted (it's just a diagnostic display, costs storage,
  // re-populates from MQTT after restart in seconds).
  if (store.pairRssiStats.size > 0) {
    const cps: Record<string, Record<string, PairRssiStatsSerialized>> = {};
    for (const [txId, byRx] of store.pairRssiStats) {
      const inner: Record<string, PairRssiStatsSerialized> = {};
      for (const [rxId, stats] of byRx) {
        inner[rxId] = {
          weight: stats.weight,
          sumRssi: stats.sumRssi,
          sumRssiSq: stats.sumRssiSq,
          trueDist: stats.trueDist,
          walls: { ...stats.walls },
          lastUpdateMs: stats.lastUpdateMs,
          totalSamples: stats.totalSamples,
        };
      }
      if (Object.keys(inner).length > 0) cps[txId] = inner;
    }
    if (Object.keys(cps).length > 0) data.cascadePairStats = cps;
  }
  if (store.latestCascadeFit) {
    const f = store.latestCascadeFit;
    const offsets: Record<string, { txOffsetDb: number; rxOffsetDb: number }> = {};
    for (const [id, o] of f.nodeOffsets) {
      offsets[id] = { ...o };
    }
    data.latestCascadeFit = {
      pathLossExponent: f.pathLossExponent,
      wallAttenuationDb: f.wallAttenuationDb,
      exteriorWallAttenuationDb: f.exteriorWallAttenuationDb,
      doorAttenuationDb: f.doorAttenuationDb,
      reflectionLossDb: f.reflectionLossDb,
      referenceRssi1m: f.referenceRssi1m,
      nodeOffsets: offsets,
      referenceNodeId: f.referenceNodeId,
      rSquared: f.rSquared,
      residualStdDb: f.residualStdDb,
      pairCount: f.pairCount,
      totalWeight: f.totalWeight,
      fittedAtMs: f.fittedAtMs,
    };
  }

  // Skip the write if there's nothing meaningful to persist (fresh boot
  // before any MQTT messages). Avoids creating an empty/garbage file.
  const isEmpty =
    Object.keys(data.pairFitStats).length === 0 &&
    Object.keys(data.groundTruthSamples).length === 0 &&
    Object.keys(data.residuals).length === 0 &&
    !data.cascadePairStats &&
    !data.latestCascadeFit;
  if (isEmpty) return;

  const tmp = `${filePath}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    console.error(
      `[cal-persist] failed to save ${filePath}:`,
      (err as Error).message,
    );
  }
}

/** How often to save calibration state to disk. */
export const CALIBRATION_SAVE_INTERVAL_MS = 60_000;
