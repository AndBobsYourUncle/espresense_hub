import { NextResponse } from "next/server";
import { fitCascade } from "@/lib/calibration/cascade";
import { getCurrentConfig } from "@/lib/config/current";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

/** Per-pair entry surfaced in the API. */
export interface CascadePairEntry {
  txId: string;
  rxId: string;
  /** Mean RSSI observed for this pair, dBm. */
  meanRssiDbm: number;
  /** Stddev of RSSI for this pair, dB. */
  sigmaDb: number;
  /** Effective weight (after recency decay). */
  weight: number;
  /** Total raw samples seen (uncapped). */
  totalSamples: number;
  /** Direct-line (straight) geometry between the two nodes. */
  trueDistM: number;
  walls: { interior: number; exterior: number; doors: number };
  /** When this pair was last updated. */
  lastUpdateMs: number;
  /**
   * Residual at the latest cascade fit, dB. Positive = observed
   * stronger than predicted; negative = observed weaker than
   * predicted. Computed only when `latestCascadeFit` is available.
   */
  residualDb: number | null;
  /**
   * Routed path used by the latest cascade fit (D6) — sequence of
   * (x, y) waypoints from TX to RX through the routing graph, plus
   * the accumulated path properties. When the routing graph found
   * a lower-loss route than the straight line, this differs from
   * the direct line; otherwise it matches.
   *
   * Visualization: draw a polyline through these points to show
   * "how the cascade thinks the signal travels." Compare against
   * the straight-line residual to gauge how much the routing helped.
   */
  routedPath: {
    points: Array<readonly [number, number]>;
    length: number;
    interior: number;
    exterior: number;
    doors: number;
  } | null;
}

export interface CascadeResponse {
  /** Whether a cascade fit has been computed yet. */
  hasFit: boolean;
  /** Latest cascade fit result. */
  fit: {
    pathLossExponent: number;
    wallAttenuationDb: number;
    exteriorWallAttenuationDb: number;
    doorAttenuationDb: number;
    /** Per-bounce specular reflection loss (Phase 1.7+). */
    reflectionLossDb: number;
    referenceRssi1m: number;
    referenceNodeId: string | null;
    nodeOffsets: Record<string, { txOffsetDb: number; rxOffsetDb: number }>;
    rSquared: number;
    residualStdDb: number;
    pairCount: number;
    totalWeight: number;
    fittedAtMs: number;
  } | null;
  /** Currently-configured RF parameters (for diff vs fitted). */
  configured: {
    pathLossExponent: number;
    wallAttenuationDb: number;
    exteriorWallAttenuationDb: number;
    doorAttenuationDb: number;
    reflectionLossDb: number;
    referenceRssi1m: number;
  };
  /** Per-pair statistics + residuals. */
  pairs: CascadePairEntry[];
  serverTime: number;
}

/**
 * Inspector endpoint for the cascade calibration system. Returns
 * the most recent fit (Layer 1 + Layer 2), the per-pair stats with
 * their fitted residuals, and the currently-configured RF params
 * for comparison.
 *
 * Used by the calibration page UI panel + by anyone curling the
 * server to verify the cascade is converging.
 */
export function GET() {
  const store = getStore();
  const config = getCurrentConfig();
  const fit = store.latestCascadeFit;

  // Per-pair flatten + residual computation (only if we have a fit).
  const pairs: CascadePairEntry[] = [];
  for (const [txId, byRx] of store.pairRssiStats) {
    for (const [rxId, stats] of byRx) {
      if (stats.weight < 1) continue;
      const meanRssi = stats.sumRssi / stats.weight;
      const variance = Math.max(
        0,
        stats.sumRssiSq / stats.weight - meanRssi * meanRssi,
      );
      const sigma = Math.sqrt(variance);

      // The residual is computed using the *routed path* (not the
      // straight line) — same model the cascade used for the fit.
      // Falls back to direct-line geometry when the routed path
      // isn't in the fit (cold start before first routed fit).
      const routed = fit?.routedPaths.get(`${txId}|${rxId}`) ?? null;
      let residualDb: number | null = null;
      if (fit) {
        const txOff = fit.nodeOffsets.get(txId)?.txOffsetDb ?? 0;
        const rxOff = fit.nodeOffsets.get(rxId)?.rxOffsetDb ?? 0;
        const lengthM = routed?.totalLength ?? stats.trueDist;
        const interiorN = routed?.interior ?? stats.walls.interior;
        const exteriorN = routed?.exterior ?? stats.walls.exterior;
        const doorsN = routed?.doors ?? stats.walls.doors;
        const wallLoss =
          interiorN * fit.wallAttenuationDb +
          exteriorN * fit.exteriorWallAttenuationDb +
          doorsN * fit.doorAttenuationDb;
        const predicted =
          fit.referenceRssi1m +
          txOff -
          10 * fit.pathLossExponent * Math.log10(Math.max(0.1, lengthM)) -
          wallLoss -
          rxOff;
        residualDb = meanRssi - predicted;
      }

      pairs.push({
        txId,
        rxId,
        meanRssiDbm: meanRssi,
        sigmaDb: sigma,
        weight: stats.weight,
        totalSamples: stats.totalSamples,
        trueDistM: stats.trueDist,
        walls: { ...stats.walls },
        lastUpdateMs: stats.lastUpdateMs,
        residualDb,
        routedPath: routed
          ? {
              points: routed.pathPoints.map((p) => [p[0], p[1]] as const),
              length: routed.totalLength,
              interior: routed.interior,
              exterior: routed.exterior,
              doors: routed.doors,
            }
          : null,
      });
    }
  }
  // Sort by weight desc — most-active pairs first.
  pairs.sort((a, b) => b.weight - a.weight);

  // If no fit cached, compute one on demand (so first inspection
  // after deploy doesn't return null even before the first scheduled
  // refit fires).
  let resolvedFit = fit;
  if (!resolvedFit) {
    resolvedFit = fitCascade(store, config);
    if (resolvedFit) store.latestCascadeFit = resolvedFit;
  }

  const body: CascadeResponse = {
    hasFit: resolvedFit != null,
    fit: resolvedFit
      ? {
          pathLossExponent: resolvedFit.pathLossExponent,
          wallAttenuationDb: resolvedFit.wallAttenuationDb,
          exteriorWallAttenuationDb:
            resolvedFit.exteriorWallAttenuationDb,
          doorAttenuationDb: resolvedFit.doorAttenuationDb,
          reflectionLossDb: resolvedFit.reflectionLossDb,
          referenceRssi1m: resolvedFit.referenceRssi1m,
          referenceNodeId: resolvedFit.referenceNodeId,
          nodeOffsets: Object.fromEntries(
            [...resolvedFit.nodeOffsets.entries()].map(([id, o]) => [
              id,
              { ...o },
            ]),
          ),
          rSquared: resolvedFit.rSquared,
          residualStdDb: resolvedFit.residualStdDb,
          pairCount: resolvedFit.pairCount,
          totalWeight: resolvedFit.totalWeight,
          fittedAtMs: resolvedFit.fittedAtMs,
        }
      : null,
    configured: {
      pathLossExponent: config.rf.path_loss_exponent,
      wallAttenuationDb: config.rf.wall_attenuation_db,
      exteriorWallAttenuationDb: config.rf.exterior_wall_attenuation_db,
      doorAttenuationDb: config.rf.door_attenuation_db,
      reflectionLossDb: config.rf.reflection_loss_db,
      referenceRssi1m: config.rf.reference_rssi_1m,
    },
    pairs,
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
