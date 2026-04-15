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
  exteriorWallAttenuationDb: number;
  doorAttenuationDb: number;
}

/** Convenience: pull the RF params out of a live Config. */
export function rfParamsFromConfig(config: Config): RfParams {
  return {
    referenceRssi1m: config.rf.reference_rssi_1m,
    pathLossExponent: config.rf.path_loss_exponent,
    wallAttenuationDb: config.rf.wall_attenuation_db,
    exteriorWallAttenuationDb: config.rf.exterior_wall_attenuation_db,
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
 *
 * `sourceRoomCentroid`, when provided, tells the model which side of
 * any wall-mounted-node's wall is "interior." Signal propagating into
 * the interior skips the mount wall; signal propagating out through it
 * is attenuated normally. Omit when the source's assigned room is
 * unknown (the mount wall is then always skipped — looser model).
 */
export function predictRssi(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  walls: readonly WallSegment[],
  params: RfParams,
  sourceRoomCentroid?: readonly [number, number],
): number {
  const dx = tx - fx;
  const dy = ty - fy;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const pathLoss = 10 * params.pathLossExponent * Math.log10(distance);
  const obstruction = obstructionLossDb(
    fx,
    fy,
    tx,
    ty,
    walls,
    params,
    sourceRoomCentroid,
  );
  return params.referenceRssi1m - pathLoss - obstruction;
}

/**
 * Total structural attenuation, in dB, along the line from (fx, fy) to
 * (tx, ty). Sums per-crossing losses for interior walls, exterior walls
 * (typically ~2.5× interior), and doors (small opening loss). Returns 0
 * when the source and target are in the same open-plan floor_area or
 * when no walls intervene.
 *
 * This is the per-path "W" term in the path-loss model:
 *
 *     expected_rssi = ref_1m − 10·n·log10(d) − W
 *
 * Shared with the RF propagation heatmap and with the calibration path,
 * so the same physics informs both "what should we expect to hear" and
 * "what residual is the node's own calibration responsible for."
 */
export function obstructionLossDb(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  walls: readonly WallSegment[],
  params: RfParams,
  sourceRoomCentroid?: readonly [number, number],
): number {
  const { interior, exterior, doors } = countCrossings(
    fx,
    fy,
    tx,
    ty,
    walls,
    sourceRoomCentroid,
  );
  return (
    interior * params.wallAttenuationDb +
    exterior * params.exteriorWallAttenuationDb +
    doors * params.doorAttenuationDb
  );
}
