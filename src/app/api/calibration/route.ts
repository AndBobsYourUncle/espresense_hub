import { NextResponse } from "next/server";
import {
  fitAllNodes,
  refreshNodePairFits,
  type NodePairFit,
} from "@/lib/calibration/autofit";
import {
  getStore,
  meanResidual,
  resetNodeResiduals,
  stddevResidual,
} from "@/lib/state/store";

export const dynamic = "force-dynamic";

export interface NodeCalibrationDTO {
  nodeId: string;
  /** Leave-one-out residuals from device measurements. */
  count: number;
  meanResidualMeters: number;
  stddevMeters: number;
  /** Ground-truth residuals from node-to-node observations. */
  gtCount: number;
  gtMeanResidualMeters: number;
  gtStddevMeters: number;
  /** Debug: last raw sample seen for this node's GT residuals. */
  gtSample?: {
    deviceId: string;
    measured: number;
    trueDist: number;
  };
  /**
   * Per-(listener, transmitter) absorption fits — one entry per neighbor
   * this node has heard at least PAIR_MIN_SAMPLES times.
   */
  pairs: NodePairFit[];
  lastUpdated: number;
  /**
   * Retained per-node settings as published by the ESPresense firmware
   * (absorption, rx_adj_rssi, tx_ref_rssi, etc.). Empty object if the node
   * hasn't published any settings yet.
   */
  settings: Record<string, string>;
  /**
   * Auto-fit proposal for this node's absorption value, from the streaming
   * log-log regression over ground-truth samples. Null if the node has too
   * few samples or a poor R² for a confident fit.
   */
  proposedAbsorption: number | null;
  /** True when the fit has enough samples and R² to be acted on by auto-apply. */
  confident: boolean;
}

export interface CalibrationResponse {
  nodes: NodeCalibrationDTO[];
  serverTime: number;
}

export function GET() {
  const store = getStore();

  // Always rebuild from the ring buffer on calibration read. The
  // online updates from the MQTT handler keep `store.nodePairFits`
  // live during solves, but this endpoint is called rarely (a human
  // looking at the page), so paying for a full rebuild here buys us
  // immunity from half-initialized state left by HMR reloads or
  // from the top-level map having listener entries whose inner maps
  // are empty due to an earlier bug.
  if (store.nodeGroundTruthSamples.size > 0) {
    refreshNodePairFits(store);
  }

  // Index the per-node absorption fits so we can attach them to each DTO.
  const fitByNode = new Map(
    fitAllNodes(store).map((f) => [f.nodeId, f]),
  );

  // Include any node we've heard from — via either residual aggregate or
  // via a retained setting message. Settings can show up before residuals.
  const nodeIds = new Set<string>();
  for (const id of store.nodeResiduals.keys()) nodeIds.add(id);
  for (const id of store.nodeGroundTruthResiduals.keys()) nodeIds.add(id);
  for (const id of store.nodeSettings.keys()) nodeIds.add(id);

  const nodes: NodeCalibrationDTO[] = [];
  for (const nodeId of nodeIds) {
    // Filter out "ghost" nodes — retained MQTT settings from decommissioned
    // ESP32s that are no longer running but whose retained messages still
    // sit on the broker. A node is real if it's in the current config
    // (nodeIndex) or if it's actively producing measurement data.
    const isConfigured = store.nodeIndex.has(nodeId);
    const stats = store.nodeResiduals.get(nodeId);
    const gtStats = store.nodeGroundTruthResiduals.get(nodeId);
    const hasData =
      (stats?.count ?? 0) > 0 || (gtStats?.count ?? 0) > 0;
    if (!isConfigured && !hasData) continue;

    const settingsMap = store.nodeSettings.get(nodeId);
    const settings: Record<string, string> = {};
    if (settingsMap) {
      for (const [k, v] of settingsMap) settings[k] = v;
    }
    // Per-pair fits are kept live in `store.nodePairFits` via the
    // streaming stats updater in the MQTT handler, so we just read the
    // current snapshot — no sample re-scan per request.
    const pairMap = store.nodePairFits.get(nodeId);
    const pairs: NodePairFit[] = pairMap ? Array.from(pairMap.values()) : [];

    nodes.push({
      nodeId,
      count: stats?.count ?? 0,
      meanResidualMeters: stats ? meanResidual(stats) : 0,
      stddevMeters: stats ? stddevResidual(stats) : 0,
      gtCount: gtStats?.count ?? 0,
      gtMeanResidualMeters: gtStats ? meanResidual(gtStats) : 0,
      gtStddevMeters: gtStats ? stddevResidual(gtStats) : 0,
      gtSample:
        gtStats?.lastDeviceId != null &&
        gtStats?.lastMeasured != null &&
        gtStats?.lastTrue != null
          ? {
              deviceId: gtStats.lastDeviceId,
              measured: gtStats.lastMeasured,
              trueDist: gtStats.lastTrue,
            }
          : undefined,
      lastUpdated: Math.max(
        stats?.lastUpdated ?? 0,
        gtStats?.lastUpdated ?? 0,
      ),
      settings,
      pairs,
      proposedAbsorption: fitByNode.get(nodeId)?.proposedAbsorption ?? null,
      confident: fitByNode.get(nodeId)?.confident ?? false,
    });
  }

  // Sort: ground-truth bias first (it's more reliable), falling back to
  // leave-one-out, falling back to "nothing yet" at the bottom.
  nodes.sort((a, b) => {
    const aPriority = a.gtCount > 0 ? 2 : a.count > 0 ? 1 : 0;
    const bPriority = b.gtCount > 0 ? 2 : b.count > 0 ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    const aBias =
      a.gtCount > 0
        ? Math.abs(a.gtMeanResidualMeters)
        : Math.abs(a.meanResidualMeters);
    const bBias =
      b.gtCount > 0
        ? Math.abs(b.gtMeanResidualMeters)
        : Math.abs(b.meanResidualMeters);
    return bBias - aBias;
  });

  const body: CalibrationResponse = {
    nodes,
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}

export function DELETE() {
  resetNodeResiduals(getStore());
  return NextResponse.json({ ok: true });
}
