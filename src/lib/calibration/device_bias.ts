import { buildObstructionFn } from "@/lib/map/rf_cache";
import type { DeviceGroundTruthPin, Store } from "@/lib/state/store";

/**
 * Per-device per-node bias model.
 *
 * Node-to-node calibration measures path-loss between ESP32 nodes.
 * But device-to-node paths have additional unknowns (device antenna,
 * TX power, body shadow, mounting orientation) that node-to-node
 * data can't see. This module learns those biases from user-placed
 * pins.
 *
 * For each pin at known device position P, for each node N reporting
 * a measurement to that device:
 *
 *     bias = measured_distance / true_distance(P, N)
 *
 * A bias of 1.0 means the node sees the device "correctly" (after
 * existing calibration). A bias of 3.0 means the node consistently
 * overestimates this device by 3× at this location — likely due to
 * antenna pattern + body shadow.
 *
 * **Spatial variation**: a single bias number per (device, node)
 * pair only works when the user is near a pinned location. Bias
 * varies across the house — body shadow shifts as the user moves.
 * With multiple pins, we interpolate the bias field via inverse-
 * distance weighting over the device's current position estimate.
 *
 * **RF-aware geometric transfer**: the raw stored bias contains TWO
 * different effects mashed together — per-(device, node) intrinsics
 * (antenna gain, body shadow) that are spatially stable, plus
 * geometric attenuation along the pin-to-node path (walls, doors)
 * that varies with the device's actual position. Without separating
 * these, a pin in the bedroom teaches the system "this device looks
 * 1.6× too far from master_bathroom node" — but that includes a
 * wall the path went through. When the device walks to the living
 * room, the same 1.6× ratio gets applied even though the new path
 * doesn't traverse that wall, producing systematic over-correction.
 *
 * The fix: at lookup time, compute the structural attenuation W from
 * the RF map for both the pin position and the current estimate
 * position. The bias adjustment factor is:
 *
 *     adjusted_bias = stored_bias × 10^((W_est − W_pin) / (10·n_firmware))
 *
 * Net effect: the per-device intrinsic (antenna pattern, etc.) is
 * preserved, while the geometric portion is recomputed for the
 * device's current location. Pins now generalize across positions
 * instead of being hyper-local to where they were placed.
 *
 * Falls back to no-op transfer when the RF cache isn't available
 * (W=0 on both sides → adjustment = 1.0 → identical to pre-RF
 * behavior).
 */

/** Result of looking up a node's bias for a device at a position. */
export interface BiasLookup {
  /** Multiplicative bias to APPLY: corrected = measured / bias. */
  bias: number;
  /** Confidence 0..1 — high when the device is near pinned positions. */
  confidence: number;
  /** How many pins contributed (weighted by IDW). */
  effectivePins: number;
}

/** Distance scale for IDW falloff (meters). */
const IDW_SCALE = 3.0;

/** Bias values outside this range are rejected as outliers. */
const BIAS_MIN = 0.2;
const BIAS_MAX = 5.0;

/** Minimum true distance for bias computation — avoid near-field. */
const MIN_TRUE_DIST = 1.0;

/**
 * Compute (device, node) → bias from a pin, transferred to the
 * device's current position estimate via the RF map. Prefers the
 * accumulated `nodeBias` stats when available (more samples → tighter
 * estimate); falls back to the single-snapshot `measurements` for
 * fresh pins.
 *
 * `estimate` is the device's currently-believed position. The raw
 * bias from the pin is geometrically adjusted to account for the
 * difference in path attenuation between (pin → node) and
 * (estimate → node). When the RF cache isn't built, the adjustment
 * falls through as a no-op (identical to pre-RF-aware behavior).
 */
function biasFromPin(
  pin: DeviceGroundTruthPin,
  nodeId: string,
  store: Store,
  estimate: readonly [number, number, number],
): { bias: number; trueDist: number; sampleCount: number } | null {
  const nodePoint = store.nodeIndex.get(nodeId);
  if (!nodePoint) return null;
  const dx = pin.position[0] - nodePoint[0];
  const dy = pin.position[1] - nodePoint[1];
  const dz = pin.position[2] - nodePoint[2];
  const trueDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (trueDist < MIN_TRUE_DIST) return null;

  // Compute the raw bias (no RF adjustment yet). Prefer accumulated
  // stats when we have enough samples.
  let rawBias: number | null = null;
  let sampleCount = 0;

  const accumulated = pin.nodeBias.get(nodeId);
  if (accumulated && accumulated.sampleCount >= 5) {
    const mean = accumulated.sumBias / accumulated.sampleCount;
    if (Number.isFinite(mean) && mean >= BIAS_MIN && mean <= BIAS_MAX) {
      rawBias = mean;
      sampleCount = accumulated.sampleCount;
    }
  }
  if (rawBias == null) {
    // Fall back to the snapshot from when the pin was placed.
    const measured = pin.measurements.get(nodeId);
    if (measured == null || measured <= 0) return null;
    const bias = measured / trueDist;
    if (!Number.isFinite(bias) || bias < BIAS_MIN || bias > BIAS_MAX) {
      return null;
    }
    rawBias = bias;
    sampleCount = 1;
  }

  // RF-aware geometric transfer: shift the bias from the pin's
  // position to the estimate's position. See module-level comment
  // for the derivation. Returns rawBias unchanged when the RF cache
  // isn't ready or the node's firmware absorption is unreadable.
  const obstructionFn = buildObstructionFn(nodeId, [
    nodePoint[0],
    nodePoint[1],
  ]);
  if (!obstructionFn) {
    return { bias: rawBias, trueDist, sampleCount };
  }
  const wPin = obstructionFn(pin.position[0], pin.position[1]);
  const wEst = obstructionFn(estimate[0], estimate[1]);
  // Pull current firmware absorption from the node's retained MQTT
  // settings. Falls back to a sane default if the value is missing
  // or unparseable — keeps the adjustment well-defined even on a
  // freshly-deployed setup.
  const absRaw = store.nodeSettings.get(nodeId)?.get("absorption");
  const parsedAbs = absRaw != null ? parseFloat(absRaw) : NaN;
  const nFirmware = Number.isFinite(parsedAbs) && parsedAbs > 0.1 ? parsedAbs : 2.7;
  const adjustment = Math.pow(10, (wEst - wPin) / (10 * nFirmware));
  const adjustedBias = rawBias * adjustment;

  // Re-clamp post-adjustment. A pathological combination (huge wall
  // delta + low absorption) could push the adjusted bias outside the
  // physically plausible range; clamp rather than feed nonsense into
  // the locator's distance-correction step.
  if (adjustedBias < BIAS_MIN || adjustedBias > BIAS_MAX) {
    return { bias: Math.max(BIAS_MIN, Math.min(BIAS_MAX, adjustedBias)), trueDist, sampleCount };
  }
  return { bias: adjustedBias, trueDist, sampleCount };
}

/**
 * Look up the local bias for a (device, node) pair at a given
 * position estimate. Uses IDW interpolation across all pins for
 * this device.
 *
 * Returns bias=1.0 (no correction) when no pins exist for this
 * device, when no pins included this node, or when the device is
 * far from any pin.
 */
export function lookupBias(
  store: Store,
  deviceId: string,
  nodeId: string,
  positionEstimate: readonly [number, number, number],
): BiasLookup {
  const pins = store.devicePins.get(deviceId);
  if (!pins || pins.length === 0) {
    return { bias: 1, confidence: 0, effectivePins: 0 };
  }

  let weightedBias = 0;
  let totalWeight = 0;

  for (const pin of pins) {
    const sample = biasFromPin(pin, nodeId, store, positionEstimate);
    if (!sample) continue;

    // IDW weight: gaussian falloff from pin to current estimate.
    const dx = pin.position[0] - positionEstimate[0];
    const dy = pin.position[1] - positionEstimate[1];
    const dz = pin.position[2] - positionEstimate[2];
    const distFromPin = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const distWeight = Math.exp(-((distFromPin / IDW_SCALE) ** 2));

    // Sample-count weight: a pin with 200 accumulated samples is far
    // more reliable than a single snapshot. Cap at 50 so a long-
    // running pin doesn't completely override a freshly-placed one
    // when the device is right on top of the new one.
    const countWeight = Math.min(50, sample.sampleCount) / 50;
    // Floor so single snapshots still contribute.
    const reliabilityWeight = 0.2 + 0.8 * countWeight;

    const w = distWeight * reliabilityWeight;
    weightedBias += w * sample.bias;
    totalWeight += w;
  }

  if (totalWeight < 0.05) {
    // Effectively no pin near the current estimate — no correction.
    return { bias: 1, confidence: 0, effectivePins: totalWeight };
  }

  const bias = weightedBias / totalWeight;
  // Confidence: how much "weight mass" surrounded the estimate.
  // 1.0 = right on top of one or more pins. 0.0 = far from all pins.
  const confidence = Math.min(1, totalWeight);

  return { bias, confidence, effectivePins: totalWeight };
}

/**
 * Apply a confidence-weighted bias correction. When confidence is
 * low (no nearby pins), we shrink the correction toward 1.0 (no
 * change) to avoid extrapolating from poorly-supported regions.
 */
export function shrinkBias(lookup: BiasLookup): number {
  return 1 + lookup.confidence * (lookup.bias - 1);
}
