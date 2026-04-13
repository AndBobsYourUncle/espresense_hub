import type {
  DeviceGroundTruthPin,
  PinNodeBiasStats,
  Store,
} from "@/lib/state/store";

/**
 * Minimum true distance (meters) for a pin sample to contribute to the
 * rssi@1m computation. BLE at very short range (< 2 m) is in the near-
 * field where the log-distance model breaks down.
 */
const MIN_TRUE_DIST = 2.0;

/** Snap-tolerance: clicking within this distance of an existing pin
 *  replaces that pin instead of creating a new one. Lets the user
 *  re-pin the same spot without accumulating duplicates. */
const REPLACE_TOLERANCE_M = 1.0;

/** How long a freshly-placed/clicked pin stays "active" before
 *  auto-deactivating from a long silence. Each new accumulation
 *  extends the window. */
export const DEFAULT_ACTIVE_DURATION_MS = 30 * 60_000;

/** Bias values outside this range are considered noise and not
 *  accumulated — protects against bad measurements at near-field. */
const BIAS_MIN_FOR_ACCUM = 0.2;
const BIAS_MAX_FOR_ACCUM = 5.0;

/** Below this true distance, log/path-loss model breaks down. */
const MIN_TRUE_DIST_FOR_ACCUM = 1.0;

/**
 * Add a new ground-truth pin for a device, OR replace a nearby existing
 * pin if the click was within REPLACE_TOLERANCE_M of one. Multiple
 * pins per device build a spatial bias map (see device_bias.ts).
 */
export function recordDevicePin(
  store: Store,
  deviceId: string,
  position: readonly [number, number, number],
): DeviceGroundTruthPin | null {
  const device = store.devices.get(deviceId);
  if (!device) return null;

  const measurements = new Map<string, number>();
  for (const m of device.measurements.values()) {
    const d = m.smoothedDistance ?? m.distance;
    if (d != null && Number.isFinite(d) && d > 0) {
      measurements.set(m.nodeId, d);
    }
  }
  if (measurements.size === 0) return null;

  const now = Date.now();
  let pins = store.devicePins.get(deviceId);
  if (!pins) {
    pins = [];
    store.devicePins.set(deviceId, pins);
  }

  // Re-clicking a nearby pin reactivates it AND replaces the snapshot
  // with current readings (in case the device's average position shifted
  // slightly since the last placement). The accumulated nodeBias stats
  // are PRESERVED — that's the point of being able to re-pin.
  const nearbyIdx = pins.findIndex((p) => {
    const dx = p.position[0] - position[0];
    const dy = p.position[1] - position[1];
    return Math.sqrt(dx * dx + dy * dy) < REPLACE_TOLERANCE_M;
  });

  // Deactivate any other active pin for this device — only one
  // accumulator at a time per device.
  for (const p of pins) {
    if (p.activeUntilMs > now) p.activeUntilMs = 0;
  }

  if (nearbyIdx >= 0) {
    const existing = pins[nearbyIdx];
    existing.measurements = measurements;
    existing.activeUntilMs = now + DEFAULT_ACTIVE_DURATION_MS;
    return existing;
  }

  const pin: DeviceGroundTruthPin = {
    deviceId,
    position,
    measurements,
    nodeBias: new Map(),
    timestamp: now,
    activeUntilMs: now + DEFAULT_ACTIVE_DURATION_MS,
  };
  pins.push(pin);
  return pin;
}

/** Mark a specific pin as active for accumulation. Deactivates any
 *  other active pin for the same device. Also resets the device's
 *  Kalman velocity to zero — clicking "activate" is the user
 *  asserting "I am stationary at this spot right now", so any prior
 *  velocity estimate (e.g. from walking up to drop the pin) would
 *  otherwise trigger the motion detector and immediately deactivate. */
export function activatePin(
  store: Store,
  deviceId: string,
  timestamp: number,
): DeviceGroundTruthPin | null {
  const pins = store.devicePins.get(deviceId);
  if (!pins) return null;
  const now = Date.now();
  let target: DeviceGroundTruthPin | null = null;
  for (const p of pins) {
    if (p.timestamp === timestamp) {
      p.activeUntilMs = now + DEFAULT_ACTIVE_DURATION_MS;
      target = p;
    } else if (p.activeUntilMs > now) {
      p.activeUntilMs = 0;
    }
  }

  // Zero the Kalman velocity for this device (if state exists).
  // Position is left untouched — the locator already knows where it
  // thinks the device is; we're just stating the velocity is ~0.
  const device = store.devices.get(deviceId);
  if (device?.kalman?.x && device.kalman.x.length >= 6) {
    device.kalman.x[3] = 0;
    device.kalman.x[4] = 0;
    device.kalman.x[5] = 0;
  }

  return target;
}

/** Deactivate a pin (or all pins for a device if timestamp omitted). */
export function deactivatePin(
  store: Store,
  deviceId: string,
  timestamp?: number,
): void {
  const pins = store.devicePins.get(deviceId);
  if (!pins) return;
  for (const p of pins) {
    if (timestamp == null || p.timestamp === timestamp) {
      p.activeUntilMs = 0;
    }
  }
}

/** Get the device's currently active pin, if any. */
export function getActivePin(
  store: Store,
  deviceId: string,
): DeviceGroundTruthPin | null {
  const pins = store.devicePins.get(deviceId);
  if (!pins) return null;
  const now = Date.now();
  for (const p of pins) {
    if (p.activeUntilMs > now) return p;
  }
  return null;
}

/**
 * Accumulate a single (nodeId, measured_distance) sample into the
 * given pin's node-bias statistics. Computes the bias against the
 * pin's known true position, validates the sample, and updates the
 * running mean/variance for that node. Extends the pin's active
 * window so it stays open as long as samples keep flowing.
 */
export function accumulatePinSample(
  store: Store,
  pin: DeviceGroundTruthPin,
  nodeId: string,
  measured: number,
): void {
  if (!Number.isFinite(measured) || measured <= 0) return;
  const nodePoint = store.nodeIndex.get(nodeId);
  if (!nodePoint) return;
  const dx = pin.position[0] - nodePoint[0];
  const dy = pin.position[1] - nodePoint[1];
  const dz = pin.position[2] - nodePoint[2];
  const trueDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (trueDist < MIN_TRUE_DIST_FOR_ACCUM) return;

  const bias = measured / trueDist;
  if (
    !Number.isFinite(bias) ||
    bias < BIAS_MIN_FOR_ACCUM ||
    bias > BIAS_MAX_FOR_ACCUM
  ) {
    return;
  }

  let stats = pin.nodeBias.get(nodeId);
  if (!stats) {
    stats = { sampleCount: 0, sumBias: 0, sumBias2: 0, lastUpdateMs: 0 };
    pin.nodeBias.set(nodeId, stats);
  }
  stats.sampleCount += 1;
  stats.sumBias += bias;
  stats.sumBias2 += bias * bias;
  stats.lastUpdateMs = Date.now();

  // Extend the active window — as long as samples keep flowing,
  // the pin stays active.
  pin.activeUntilMs = Date.now() + DEFAULT_ACTIVE_DURATION_MS;
}

/** Compute the mean and stddev from accumulated stats. */
export function biasStatsToEstimate(
  stats: PinNodeBiasStats,
): { mean: number; stddev: number } {
  if (stats.sampleCount === 0) return { mean: 1, stddev: 0 };
  const mean = stats.sumBias / stats.sampleCount;
  const variance = Math.max(
    0,
    stats.sumBias2 / stats.sampleCount - mean * mean,
  );
  return { mean, stddev: Math.sqrt(variance) };
}

/** Remove a pin by timestamp. Returns true if a pin was removed. */
export function deleteDevicePin(
  store: Store,
  deviceId: string,
  timestamp: number,
): boolean {
  const pins = store.devicePins.get(deviceId);
  if (!pins) return false;
  const idx = pins.findIndex((p) => p.timestamp === timestamp);
  if (idx < 0) return false;
  pins.splice(idx, 1);
  if (pins.length === 0) store.devicePins.delete(deviceId);
  return true;
}

/** Remove all pins for a device. */
export function clearDevicePins(store: Store, deviceId: string): void {
  store.devicePins.delete(deviceId);
}

/**
 * From a pin, compute the per-node rssi@1m adjustment needed so the
 * firmware's distance formula outputs the correct value for this
 * device.
 *
 * Math: the firmware computes `d = 10^((refRssi - rssi) / (10 × n))`.
 * If `d_measured / d_true = C`, adjusting refRssi by `−10 × n × log₁₀(C)`
 * makes `d_new = d_old / C = d_true`. Each node has its own `n`
 * (absorption), so we compute a per-node delta and take the median for
 * robustness.
 *
 * Returns the integer dBm value to publish as `rssi@1m`, or null if
 * there isn't enough usable data.
 */
export function computeRefRssiFromPin(
  pin: DeviceGroundTruthPin,
  store: Store,
  currentRefRssi: number = -59,
): { refRssi: number; deltas: Array<{ nodeId: string; delta: number; ratio: number }> } | null {
  const deltas: Array<{ nodeId: string; delta: number; ratio: number }> = [];

  for (const [nodeId, measured] of pin.measurements) {
    const nodePoint = store.nodeIndex.get(nodeId);
    if (!nodePoint) continue;
    const dx = pin.position[0] - nodePoint[0];
    const dy = pin.position[1] - nodePoint[1];
    const dz = pin.position[2] - nodePoint[2];
    const trueDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (trueDist < MIN_TRUE_DIST) continue;
    if (measured <= 0) continue;

    const ratio = measured / trueDist;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;

    // Node's absorption (n). Fall back to 2.7 if not set.
    const absRaw = store.nodeSettings.get(nodeId)?.get("absorption");
    const parsedAbs = absRaw != null ? parseFloat(absRaw) : NaN;
    const absorption =
      Number.isFinite(parsedAbs) && parsedAbs > 0.1 ? parsedAbs : 2.7;

    // Delta = -10 × n × log₁₀(ratio)
    const delta = -10 * absorption * Math.log10(ratio);
    deltas.push({ nodeId, delta, ratio });
  }

  if (deltas.length < 3) return null;

  // Robust median of deltas.
  const sorted = [...deltas].sort((a, b) => a.delta - b.delta);
  const mid = sorted.length >> 1;
  const medianDelta =
    sorted.length % 2 === 1
      ? sorted[mid].delta
      : (sorted[mid - 1].delta + sorted[mid].delta) / 2;

  const refRssi = Math.round(currentRefRssi + medianDelta);

  return { refRssi, deltas };
}

/** Return all pins for a device, newest first. */
export function getDevicePins(
  store: Store,
  deviceId: string,
): DeviceGroundTruthPin[] {
  const pins = store.devicePins.get(deviceId) ?? [];
  return [...pins].sort((a, b) => b.timestamp - a.timestamp);
}

/** Return the most recent pin for a device, or null. */
export function getMostRecentPin(
  store: Store,
  deviceId: string,
): DeviceGroundTruthPin | null {
  const pins = store.devicePins.get(deviceId);
  if (!pins || pins.length === 0) return null;
  return pins.reduce((newest, p) =>
    p.timestamp > newest.timestamp ? p : newest,
  );
}
