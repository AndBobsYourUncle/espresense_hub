import type { Point3D } from "@/lib/map/geometry";
import type { DeviceState, Store } from "@/lib/state/store";
import { rejectOutliers } from "./outlier";
import {
  computePathAwareConfidence,
  correctFixesWithDetail,
  type ConfidenceBreakdown,
} from "./path_aware";
import type { NodeFix } from "./types";

/**
 * Per-fix diagnostic detail — what the locator "saw" for one reporting
 * node at the device's currently-stored position. Surfaced through the
 * device detail API so the UI can show why each measurement looks good
 * or bad and whether it was dropped as an outlier.
 */
export interface FixDiagnostic {
  nodeId: string;
  /** Raw distance from the firmware, meters. */
  rawDistance: number;
  /**
   * Distance after per-pair absorption correction, meters. Equals
   * `rawDistance` when no calibration data applied to this listener.
   */
  correctedDistance: number;
  /** Euclidean distance from node to the stored position, meters. */
  expectedDistance: number;
  /** `rawDistance − expectedDistance` — what the base locator sees. */
  rawResidual: number;
  /** `correctedDistance − expectedDistance` — what PathAware sees. */
  correctedResidual: number;
  /**
   * IDW-interpolated `n_real` used for the correction. Null when this
   * listener had no per-pair fits or all were invalid.
   */
  nEffective: number | null;
  /** Firmware's currently-configured `absorption` value for this listener. */
  nAssumed: number;
  /**
   * True when this fix would be dropped by the MAD-based outlier
   * rejection at the stored position. Reflects PathAware's confidence
   * calculation — the base locator's runtime rejection may differ
   * slightly because it runs at an earlier position estimate.
   */
  rejected: boolean;
}

export interface PathAwareDiagnostics {
  fixes: FixDiagnostic[];
  confidence: ConfidenceBreakdown;
}

/**
 * Reconstruct the PathAware view of a device at its current stored
 * position. The solve that produced the position has already happened
 * — this is a read-only re-derivation for display purposes.
 *
 * Contract: pass the same `nodeIndex` and `staleAfterMs` the live
 * locator uses, so the fix filter here matches what the solver used.
 * The resulting diagnostics describe "given the current position and
 * current measurements, which fixes look anomalous and what would the
 * confidence breakdown look like."
 */
export function computePathAwareDiagnostics(
  device: DeviceState,
  nodeIndex: Map<string, Point3D>,
  store: Store,
  staleAfterMs: number,
): PathAwareDiagnostics | null {
  const position = device.position;
  if (!position) return null;

  const cutoff = Date.now() - staleAfterMs;
  const rawFixes: NodeFix[] = [];
  for (const m of device.measurements.values()) {
    const distance = m.smoothedDistance ?? m.distance;
    if (distance == null || !Number.isFinite(distance)) continue;
    if (m.lastSeen < cutoff) continue;
    const point = nodeIndex.get(m.nodeId);
    if (!point) continue;
    rawFixes.push({ nodeId: m.nodeId, point, distance });
  }
  if (rawFixes.length === 0) return null;

  const solution: readonly [number, number, number] = [
    position.x,
    position.y,
    position.z,
  ];

  // Apply the same correction the solver used. When there are no pair
  // fits yet, every entry comes back as a passthrough.
  const details = correctFixesWithDetail(rawFixes, solution, store);
  const correctedFixes: NodeFix[] = details.map((d) => ({
    ...d.fix,
    distance: d.correctedDistance,
  }));

  // Run outlier rejection against the corrected fixes at the stored
  // position to identify which ones look anomalous *now*.
  const keptFixes = rejectOutliers(correctedFixes, solution);
  const keptIds = new Set(keptFixes.map((f) => f.nodeId));

  // Confidence breakdown uses only the kept fixes, matching what the
  // solver's confidence calculation does.
  const confidence = computePathAwareConfidence(
    keptFixes,
    solution,
    store,
    true, // we don't know if the original iteration converged here
  );

  const fixes: FixDiagnostic[] = details.map((d) => {
    const dx = solution[0] - d.fix.point[0];
    const dy = solution[1] - d.fix.point[1];
    const dz = solution[2] - d.fix.point[2];
    const expectedDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return {
      nodeId: d.fix.nodeId,
      rawDistance: d.fix.distance,
      correctedDistance: d.correctedDistance,
      expectedDistance,
      rawResidual: d.fix.distance - expectedDistance,
      correctedResidual: d.correctedDistance - expectedDistance,
      nEffective: d.nEffective,
      nAssumed: d.nAssumed,
      rejected: !keptIds.has(d.fix.nodeId),
    };
  });

  return { fixes, confidence };
}
