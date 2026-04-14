import type { Config } from "@/lib/config";
import { countCrossings, type WallSegment } from "./rf_geometry";

/**
 * Physical parameters used by the RF model. Mirrored from
 * `config.rf.*` so callers aren't forced to re-read the whole config.
 */
export interface RfParams {
  referenceRssi1m: number;
  pathLossExponent: number;
  wallAttenuationDb: number;
  doorAttenuationDb: number;
}

/** Convenience: pull the RF params out of a live Config. */
export function rfParamsFromConfig(config: Config): RfParams {
  return {
    referenceRssi1m: config.rf.reference_rssi_1m,
    pathLossExponent: config.rf.path_loss_exponent,
    wallAttenuationDb: config.rf.wall_attenuation_db,
    doorAttenuationDb: config.rf.door_attenuation_db,
  };
}

/**
 * Predict RSSI at `(tx, ty)` for a transmitter at `(fx, fy)`, in dBm.
 * Applies the log-distance path-loss model plus per-wall and per-door
 * attenuation based on how many wall/door segments the straight line
 * between source and target crosses.
 *
 *     RSSI(d) = ref  −  10·n·log10(d)
 *                    −  walls × wall_attenuation
 *                    −  doors × door_attenuation
 *
 * Distances below 1 m use 1 m (the reference distance) — avoids
 * `log(0)` and reflects the reality that "closer than 1 m" doesn't
 * give stronger signal than the reference measurement.
 */
export function predictRssi(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  walls: readonly WallSegment[],
  params: RfParams,
): number {
  const dx = tx - fx;
  const dy = ty - fy;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const pathLoss = 10 * params.pathLossExponent * Math.log10(distance);
  const { walls: wallHits, doors: doorHits } = countCrossings(
    fx,
    fy,
    tx,
    ty,
    walls,
  );
  const wallLoss = wallHits * params.wallAttenuationDb;
  const doorLoss = doorHits * params.doorAttenuationDb;
  return params.referenceRssi1m - pathLoss - wallLoss - doorLoss;
}
