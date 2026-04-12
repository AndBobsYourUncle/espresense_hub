import { NextResponse } from "next/server";
import {
  activatePin,
  biasStatsToEstimate,
  clearDevicePins,
  computeRefRssiFromPin,
  deactivatePin,
  deleteDevicePin,
  getDevicePins,
  getMostRecentPin,
  recordDevicePin,
} from "@/lib/calibration/device_cal";
import { publishDeviceConfig } from "@/lib/mqtt/client";
import { saveDevicePins } from "@/lib/state/device_persistence";
import { getStore, type DeviceGroundTruthPin } from "@/lib/state/store";

export const dynamic = "force-dynamic";

export interface PinRequestBody {
  x: number;
  y: number;
  z?: number;
}

export interface PinDTO {
  deviceId: string;
  position: readonly [number, number, number];
  measurements: Record<string, number>;
  timestamp: number;
  /** True if this pin is currently accumulating new samples. */
  active: boolean;
  /** Per-node accumulated bias stats: nodeId → { mean, stddev, count }. */
  nodeBias: Record<
    string,
    { mean: number; stddev: number; sampleCount: number }
  >;
}

export interface PinListResponse {
  pins: PinDTO[];
  /** Computed rssi@1m from the most recent pin, if one exists. */
  refRssi: number | null;
  /** Per-node deltas from the most recent pin's rssi@1m computation. */
  deltas: Array<{ nodeId: string; delta: number; ratio: number }>;
}

export interface PinPostResponse {
  pin: PinDTO;
  pins: PinDTO[];
  refRssi: number | null;
  deltas: Array<{ nodeId: string; delta: number; ratio: number }>;
}

export interface ApplyPinResponse {
  refRssi: number;
  published: boolean;
  publishTopic: string | null;
}

function pinToDTO(pin: DeviceGroundTruthPin): PinDTO {
  const measurements: Record<string, number> = {};
  for (const [k, v] of pin.measurements) measurements[k] = v;
  const nodeBias: PinDTO["nodeBias"] = {};
  for (const [nodeId, stats] of pin.nodeBias) {
    const est = biasStatsToEstimate(stats);
    nodeBias[nodeId] = {
      mean: est.mean,
      stddev: est.stddev,
      sampleCount: stats.sampleCount,
    };
  }
  return {
    deviceId: pin.deviceId,
    position: pin.position,
    measurements,
    timestamp: pin.timestamp,
    active: pin.activeUntilMs > Date.now(),
    nodeBias,
  };
}

/** GET — list all pins for this device, plus the most-recent's rssi@1m. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const deviceId = decodeURIComponent(rawId);
  const store = getStore();

  const pins = getDevicePins(store, deviceId);
  const mostRecent = getMostRecentPin(store, deviceId);
  const result = mostRecent ? computeRefRssiFromPin(mostRecent, store) : null;

  const response: PinListResponse = {
    pins: pins.map(pinToDTO),
    refRssi: result?.refRssi ?? null,
    deltas: result?.deltas ?? [],
  };
  return NextResponse.json(response);
}

/**
 * POST — add a new pin for this device (or replace a nearby existing
 * one within 1m). Persists to disk so pins survive restarts.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const deviceId = decodeURIComponent(rawId);

  let body: PinRequestBody;
  try {
    body = (await request.json()) as PinRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (
    typeof body.x !== "number" ||
    typeof body.y !== "number" ||
    !Number.isFinite(body.x) ||
    !Number.isFinite(body.y)
  ) {
    return NextResponse.json(
      { error: "x and y are required finite numbers" },
      { status: 400 },
    );
  }

  const store = getStore();
  const z = typeof body.z === "number" && Number.isFinite(body.z) ? body.z : 0;
  const pin = recordDevicePin(store, deviceId, [body.x, body.y, z]);
  if (!pin) {
    return NextResponse.json(
      { error: "device not found or no measurements available" },
      { status: 404 },
    );
  }

  // Persist immediately so a crash before the next save doesn't lose it.
  saveDevicePins(store).catch((err) =>
    console.error("[pin] saveDevicePins failed", err),
  );

  const result = computeRefRssiFromPin(pin, store);
  const response: PinPostResponse = {
    pin: pinToDTO(pin),
    pins: getDevicePins(store, deviceId).map(pinToDTO),
    refRssi: result?.refRssi ?? null,
    deltas: result?.deltas ?? [],
  };
  return NextResponse.json(response, { status: 201 });
}

/**
 * PUT — apply the most recent pin's computed rssi@1m to firmware
 * via the device's IRK-based MQTT topic.
 */
export async function PUT(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const deviceId = decodeURIComponent(rawId);
  const store = getStore();

  const pin = getMostRecentPin(store, deviceId);
  if (!pin) {
    return NextResponse.json(
      { error: "no pin placed for this device" },
      { status: 404 },
    );
  }

  const result = computeRefRssiFromPin(pin, store);
  if (!result) {
    return NextResponse.json(
      { error: "not enough usable data to compute rssi@1m" },
      { status: 400 },
    );
  }

  const settings =
    store.deviceSettingsById.get(deviceId) ??
    store.deviceSettingsByAlias.get(deviceId);

  if (!settings?.originalId) {
    return NextResponse.json(
      {
        error:
          "device original ID (IRK) not found — retained config may not have arrived yet",
      },
      { status: 404 },
    );
  }

  const publishTopic = `espresense/settings/${settings.originalId}/config`;
  let published = false;
  try {
    const fullConfig: Record<string, unknown> = {};
    if (settings.id) fullConfig.id = settings.id;
    if (settings.name) fullConfig.name = settings.name;
    fullConfig["rssi@1m"] = result.refRssi;
    await publishDeviceConfig(settings.originalId, fullConfig);
    published = true;
    console.log(
      `[pin] ${deviceId}: applied rssi@1m=${result.refRssi} dBm to ${publishTopic}`,
    );
  } catch (err) {
    console.error(
      `[pin] failed to publish rssi@1m for ${deviceId}:`,
      (err as Error).message,
    );
  }

  const response: ApplyPinResponse = {
    refRssi: result.refRssi,
    published,
    publishTopic,
  };
  return NextResponse.json(response);
}

/**
 * PATCH — toggle a pin's active accumulation state.
 *
 * Body: { timestamp: number, active: boolean }
 *
 * When activated, this pin starts collecting bias samples for every
 * incoming measurement (assuming the device is detected as
 * stationary). Only one pin per device can be active at a time —
 * activating one auto-deactivates the others.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const deviceId = decodeURIComponent(rawId);
  const store = getStore();

  let body: {
    timestamp?: number;
    active?: boolean;
    position?: [number, number, number] | [number, number];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.timestamp !== "number") {
    return NextResponse.json(
      { error: "expected { timestamp: number, ... }" },
      { status: 400 },
    );
  }

  // Position update (drag-to-reposition).
  if (body.position) {
    const [x, y, z] = [
      body.position[0],
      body.position[1],
      body.position[2] ?? 0,
    ];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return NextResponse.json(
        { error: "invalid position coordinates" },
        { status: 400 },
      );
    }
    const pins = store.devicePins.get(deviceId);
    const pin = pins?.find((p) => p.timestamp === body.timestamp);
    if (!pin) {
      return NextResponse.json({ error: "pin not found" }, { status: 404 });
    }
    // Mutate the readonly position via cast — store is ours to manage.
    (pin as unknown as { position: [number, number, number] }).position = [
      x,
      y,
      z,
    ];
    // Reset accumulated bias stats — old samples were calibrated against
    // the OLD position and would be wrong at the new one. The user can
    // reactivate to start collecting fresh samples at the new spot.
    pin.nodeBias.clear();
    pin.activeUntilMs = 0;
    saveDevicePins(store).catch((err) =>
      console.error("[pin] saveDevicePins failed", err),
    );
  }

  // Active-state toggle.
  if (typeof body.active === "boolean") {
    if (body.active) {
      const pin = activatePin(store, deviceId, body.timestamp);
      if (!pin) {
        return NextResponse.json({ error: "pin not found" }, { status: 404 });
      }
    } else {
      deactivatePin(store, deviceId, body.timestamp);
    }
  }

  return NextResponse.json({
    pins: getDevicePins(store, deviceId).map(pinToDTO),
  });
}

/**
 * DELETE — remove a single pin by `?timestamp=...`, or all pins
 * if no query param is given. Persists the change to disk.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const deviceId = decodeURIComponent(rawId);
  const store = getStore();

  const url = new URL(request.url);
  const tsParam = url.searchParams.get("timestamp");

  if (tsParam) {
    const ts = Number(tsParam);
    if (!Number.isFinite(ts)) {
      return NextResponse.json(
        { error: "invalid timestamp" },
        { status: 400 },
      );
    }
    const removed = deleteDevicePin(store, deviceId, ts);
    if (!removed) {
      return NextResponse.json({ error: "pin not found" }, { status: 404 });
    }
  } else {
    clearDevicePins(store, deviceId);
  }

  saveDevicePins(store).catch((err) =>
    console.error("[pin] saveDevicePins failed", err),
  );
  return NextResponse.json({ ok: true });
}
