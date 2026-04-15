import { NextResponse } from "next/server";
import { reloadLiveConfig } from "@/lib/bootstrap";
import { updateRfParameters } from "@/lib/config/write";

export const dynamic = "force-dynamic";

interface ApplyBody {
  pathLossExponent?: number;
  wallAttenuationDb?: number;
  exteriorWallAttenuationDb?: number;
  doorAttenuationDb?: number;
}

/**
 * Persist a subset of fitted RF parameters to config.yaml. The client
 * sends only the fields the user chose to apply (the UI shows fitted vs
 * configured side-by-side and lets the user opt in per-parameter).
 *
 * After write, we reload the live config so the RF cache and every
 * downstream consumer (per-pair fits, propagation overlay, future
 * RoomAware RF-weighting) start using the new values immediately
 * without a service restart.
 */
export async function POST(req: Request) {
  let body: ApplyBody;
  try {
    body = (await req.json()) as ApplyBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const params: Parameters<typeof updateRfParameters>[0] = {};
  if (
    body.pathLossExponent != null &&
    Number.isFinite(body.pathLossExponent) &&
    body.pathLossExponent > 0
  ) {
    params.pathLossExponent = body.pathLossExponent;
  }
  if (
    body.wallAttenuationDb != null &&
    Number.isFinite(body.wallAttenuationDb) &&
    body.wallAttenuationDb >= 0
  ) {
    params.wallAttenuationDb = body.wallAttenuationDb;
  }
  if (
    body.exteriorWallAttenuationDb != null &&
    Number.isFinite(body.exteriorWallAttenuationDb) &&
    body.exteriorWallAttenuationDb >= 0
  ) {
    params.exteriorWallAttenuationDb = body.exteriorWallAttenuationDb;
  }
  if (
    body.doorAttenuationDb != null &&
    Number.isFinite(body.doorAttenuationDb) &&
    body.doorAttenuationDb >= 0
  ) {
    params.doorAttenuationDb = body.doorAttenuationDb;
  }

  if (Object.keys(params).length === 0) {
    return NextResponse.json(
      { error: "No valid parameters supplied" },
      { status: 400 },
    );
  }

  try {
    await updateRfParameters(params);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
  await reloadLiveConfig();

  return NextResponse.json({ applied: params });
}
