import { NextResponse } from "next/server";
import {
  fitRfParametersFromStore,
  type RfParamFitResult,
} from "@/lib/calibration/rf_param_fit";
import { getCurrentConfig } from "@/lib/config/current";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

export interface RfFitResponse {
  /** The fit result, or null when there aren't enough samples / matrix is singular. */
  fit: RfParamFitResult | null;
  /** Currently-configured values for diff display. */
  current: {
    pathLossExponent: number;
    wallAttenuationDb: number;
    exteriorWallAttenuationDb: number;
    doorAttenuationDb: number;
  };
  serverTime: number;
}

/**
 * On-demand RF parameter fit. The fit reads from the current sample
 * buffer + current config geometry and returns proposed values
 * alongside the configured ones — the UI shows a diff. Apply is
 * intentionally separate (a different POST) so the user can review
 * before committing values that will reshape every downstream RF-aware
 * computation.
 */
export function POST() {
  const store = getStore();
  const config = getCurrentConfig();
  const fit = fitRfParametersFromStore(store, config);
  const body: RfFitResponse = {
    fit,
    current: {
      pathLossExponent: config.rf.path_loss_exponent,
      wallAttenuationDb: config.rf.wall_attenuation_db,
      exteriorWallAttenuationDb: config.rf.exterior_wall_attenuation_db,
      doorAttenuationDb: config.rf.door_attenuation_db,
    },
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
