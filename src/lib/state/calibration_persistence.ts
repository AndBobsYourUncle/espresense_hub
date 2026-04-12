import { promises as fs } from "node:fs";
import path from "node:path";
import type { PairStats } from "@/lib/calibration/autofit";
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

interface CalibrationFileV1 {
  version: 1;
  savedAt: number;

  /** nodePairFitStats: listenerId → transmitterId → PairStats */
  pairFitStats: Record<string, Record<string, PairStats>>;

  /** nodeGroundTruthSamples: listenerId → [GroundTruthSample, ...] */
  groundTruthSamples: Record<string, GroundTruthSample[]>;

  /** Per-node residual aggregators. */
  residuals: Record<
    string,
    {
      loo?: NodeResidualStats;
      gt?: NodeResidualStats;
    }
  >;
}

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

  let parsed: CalibrationFileV1;
  try {
    parsed = JSON.parse(raw) as CalibrationFileV1;
  } catch (err) {
    console.error(
      `[cal-persist] failed to parse ${filePath}:`,
      (err as Error).message,
    );
    return;
  }

  if (parsed.version !== 1) {
    console.warn(
      `[cal-persist] ${filePath} has unknown version ${parsed.version}, ignoring`,
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

  console.log(
    `[cal-persist] loaded: ${pairCount} pair stats · ${sampleCount} GT samples · ${residualNodeCount} residual aggregates (saved ${ageHours.toFixed(1)}h ago)`,
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

  const data: CalibrationFileV1 = {
    version: 1,
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

  // Skip the write if there's nothing meaningful to persist (fresh boot
  // before any MQTT messages). Avoids creating an empty/garbage file.
  const isEmpty =
    Object.keys(data.pairFitStats).length === 0 &&
    Object.keys(data.groundTruthSamples).length === 0 &&
    Object.keys(data.residuals).length === 0;
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
