import type { DevicePosition } from "./store";

/**
 * Temporal smoothing for device positions.
 *
 * Raw locator output jitters on every MQTT message because each new
 * distance measurement shifts the least-squares solution by a handful of
 * centimeters. The user-facing position should reflect *real* movement,
 * not per-measurement noise — so we apply a confidence-weighted
 * exponential moving average before writing to the store.
 *
 * Design:
 *   - **Time-aware** via `alpha = 1 − exp(−dt/τ)`. An update that arrives
 *     quickly (lots of fixes flowing in) contributes less individually,
 *     while an update after a long gap pulls the marker harder. This is
 *     the standard EMA adaptation for irregular sampling intervals.
 *   - **Confidence-weighted**: the final alpha is multiplied by the new
 *     sample's confidence. A 0.3-confidence reading only moves the
 *     marker a third as much as a 1.0-confidence reading would.
 *   - **Min-alpha floor** so a burst of same-millisecond arrivals still
 *     advances the smoothed state instead of getting stuck at alpha=0.
 *   - **Gap reset**: past `MAX_GAP_MS`, the prior is too stale to blend
 *     usefully — we accept the raw result outright. (The exponential
 *     would do this anyway, but the explicit bound makes intent clear.)
 *
 * Only the active locator's position (x, y, z) is smoothed. The
 * `alternatives` array is passed through raw so the ghost markers in
 * compare mode still show each base locator's true per-message jitter.
 */

/**
 * Time constant for the EMA, in seconds. Set at bootstrap from
 * `filtering.smoothing_weight` in config.yaml — see `setPositionSmoothingWeight`.
 * Shorter = more responsive but jittery.
 */
let TAU_SECONDS = 0.5;

/** Minimum alpha per update so same-ms bursts still advance. */
const MIN_ALPHA = 0.02;

/** Past this gap, treat the prior as stale and accept the raw value. */
const MAX_GAP_MS = 30_000;

/**
 * Tune the output-side position smoothing time constant from the same
 * 0..1 weight used for measurement smoothing. Output τ is shorter than
 * input τ because input smoothing already absorbed most of the noise —
 * this layer just polishes the residual jitter.
 *
 *   weight 0.0 → τ = 0.0 s   (no smoothing)
 *   weight 0.4 → τ = 0.5 s   (current default — fast follow)
 *   weight 0.7 → τ = 1.0 s   (upstream default — heavy smoothing)
 *   weight 1.0 → τ = 2.0 s   (very heavy)
 */
export function setPositionSmoothingWeight(weight: number): void {
  const w = Math.max(0, Math.min(1, weight));
  TAU_SECONDS = w * 2;
}

export function smoothDevicePosition(
  prev: DevicePosition | undefined,
  next: DevicePosition,
): DevicePosition {
  if (!prev) return next;

  const dtMs = Math.max(0, next.computedAt - prev.computedAt);
  if (dtMs >= MAX_GAP_MS) return next;

  // τ = 0 means smoothing disabled — accept the raw position outright.
  if (TAU_SECONDS <= 0) return next;

  const dtSec = dtMs / 1000;
  const timeAlpha = 1 - Math.exp(-dtSec / TAU_SECONDS);
  const conf = Math.max(0, Math.min(1, next.confidence));
  const alpha = Math.max(MIN_ALPHA, Math.min(1, timeAlpha * conf));

  return {
    ...next,
    x: prev.x + alpha * (next.x - prev.x),
    y: prev.y + alpha * (next.y - prev.y),
    z: prev.z + alpha * (next.z - prev.z),
  };
}
