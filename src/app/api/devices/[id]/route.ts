import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { computePathAwareDiagnostics } from "@/lib/locators/diagnostics";
import { buildNodeIndex } from "@/lib/locators";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

export interface MeasurementDetailDTO {
  nodeId: string;
  nodeName: string;
  nodePoint: readonly [number, number, number] | null;
  measuredDistance: number | null;
  expectedDistance: number | null;
  /** measured − expected (positive = node overestimates distance). */
  residual: number | null;
  rssi: number | null;
  refRssi: number | null;
  lastSeen: number;
  /**
   * Distance after PathAware's per-pair absorption correction. Null
   * when there was no calibration data to apply, or when it equaled
   * `measuredDistance` (i.e. correction was a no-op). Meters.
   */
  correctedDistance: number | null;
  /** `correctedDistance − expectedDistance`. Null when corrected is null. */
  correctedResidual: number | null;
  /** IDW-interpolated absorption `n` used for this fix, if applied. */
  nEffective: number | null;
  /** Firmware-configured absorption at the time of the correction. */
  nAssumed: number | null;
  /**
   * True when this measurement looks like an outlier at the current
   * position and would be dropped by the MAD-based rejection step.
   */
  rejected: boolean;
}

export interface ConfidenceBreakdownDTO {
  fitScore: number;
  geomScore: number;
  coverageScore: number;
  fixScore: number;
  rmse: number;
  blended: number;
  convergencePenaltyApplied: boolean;
  fixCount: number;
}

export interface DeviceDetailDTO {
  id: string;
  name: string | null;
  position: {
    x: number;
    y: number;
    z: number;
    confidence: number;
    fixes: number;
    algorithm: string;
    computedAt: number;
    /**
     * Component-wise breakdown of the blended confidence score. Present
     * only for the PathAware locator (the only one that publishes it).
     * Recomputed at request time so the numbers reflect the current
     * measurement set, which may differ slightly from the value frozen
     * at the moment of the solve.
     */
    confidenceBreakdown: ConfidenceBreakdownDTO | null;
  } | null;
  measurements: MeasurementDetailDTO[];
  firstSeen: number;
  lastSeen: number;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const id = decodeURIComponent(rawId);

  const store = getStore();
  const device = store.devices.get(id);
  if (!device) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }

  // Build a node lookup so we can resolve names + 3D points for each fix.
  // loadConfig is fast (a few ms) and re-runs on every request — fine for now.
  const config = await loadConfig();
  const nodeNameById = new Map<string, string>();
  for (const n of config.nodes) {
    if (n.id) nodeNameById.set(n.id, n.name ?? n.id);
  }
  const geometryIndex = buildNodeIndex(config);

  // Re-derive PathAware's view at the current stored position so the UI
  // can show per-fix corrections, rejected outliers, and a confidence
  // breakdown. This is read-only — the solve has already happened.
  const staleAfterMs = config.timeout * 1000;
  const diagnostics = computePathAwareDiagnostics(
    device,
    geometryIndex,
    store,
    staleAfterMs,
  );
  const diagByNode = new Map(diagnostics?.fixes.map((f) => [f.nodeId, f]));

  const measurements: MeasurementDetailDTO[] = [];
  for (const m of device.measurements.values()) {
    const point = geometryIndex.get(m.nodeId) ?? null;
    const nodeName = nodeNameById.get(m.nodeId) ?? m.nodeId;

    // Use the same distance the solver used — the smoothed EMA — so
    // residuals displayed here line up with what the fit score is
    // computing against. Falls back to raw for measurements that
    // predate smoothing (HMR, pre-migration state).
    const measuredDistance = m.smoothedDistance ?? m.distance ?? null;

    let expectedDistance: number | null = null;
    let residual: number | null = null;
    if (point && device.position && measuredDistance != null) {
      const dx = device.position.x - point[0];
      const dy = device.position.y - point[1];
      const dz = device.position.z - point[2];
      expectedDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      residual = measuredDistance - expectedDistance;
    }

    const diag = diagByNode.get(m.nodeId);
    // Only surface a corrected distance when the correction actually
    // moved the needle — otherwise the UI can just show the smoothed value.
    const corrected =
      diag && diag.nEffective != null
        ? diag.correctedDistance
        : null;
    const correctedRes =
      corrected != null && expectedDistance != null
        ? corrected - expectedDistance
        : null;

    measurements.push({
      nodeId: m.nodeId,
      nodeName,
      nodePoint: point,
      measuredDistance,
      expectedDistance,
      residual,
      rssi: m.rssi ?? null,
      refRssi: m.refRssi ?? null,
      lastSeen: m.lastSeen,
      correctedDistance: corrected,
      correctedResidual: correctedRes,
      nEffective: diag?.nEffective ?? null,
      nAssumed: diag?.nAssumed ?? null,
      rejected: diag?.rejected ?? false,
    });
  }

  // Sort by measured distance ascending so the closest fixes are at the top.
  measurements.sort(
    (a, b) =>
      (a.measuredDistance ?? Infinity) - (b.measuredDistance ?? Infinity),
  );

  const body: DeviceDetailDTO = {
    id: device.id,
    name: device.name ?? null,
    position: device.position
      ? {
          x: device.position.x,
          y: device.position.y,
          z: device.position.z,
          confidence: device.position.confidence,
          fixes: device.position.fixes,
          algorithm: device.position.algorithm,
          computedAt: device.position.computedAt,
          confidenceBreakdown: diagnostics?.confidence ?? null,
        }
      : null,
    measurements,
    firstSeen: device.firstSeen,
    lastSeen: device.lastSeen,
  };

  return NextResponse.json(body);
}
