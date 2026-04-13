/**
 * Per-node input smoothing for BLE distance measurements.
 *
 * Motivation: single-snapshot RSSI → distance readings have substantial
 * variance (a few dB of RSSI jitter becomes a few meters of distance
 * error, especially at longer ranges). The solver sees this variance
 * directly as "the corrected distances don't agree at the solution" and
 * the fit score drops. Smoothing the *input* distances before they hit
 * the solver is strictly better than smoothing the *output* position:
 *
 *   - It reduces the solver's residuals (fit score goes up for real)
 *   - It's equivalent to averaging multiple RSSI samples per node, which
 *     is what the CLT says you want for noise with fixed variance
 *   - Position smoothing on top still handles the residual output noise
 *
 * Trade-off: smoothing adds lag when the device moves. We use a short
 * time constant (`TAU_SECONDS = 3`) so motion catches up in ~3–6 s, and
 * clamp the max gap so a long silence resets rather than lazily blending
 * a stale value forward.
 *
 * Implementation is the standard irregularly-sampled EMA:
 *   α = 1 − exp(−Δt / τ)
 * A minimum α floor keeps same-millisecond bursts advancing, and a
 * maximum gap reset drops stale priors outright.
 */

/**
 * Time constant for the per-node EMA, in seconds. Set at bootstrap from
 * `filtering.smoothing_weight` in config.yaml — see `setSmoothingWeight`.
 * Higher = smoother but laggier when the device moves; lower = more
 * responsive but jittery when stationary.
 */
let TAU_SECONDS = 1.5;

/** Minimum blend per update so same-ms bursts still advance the state. */
const MIN_ALPHA = 0.05;

/** Past this gap, treat the prior reading as stale and accept the raw value. */
const MAX_GAP_MS = 30_000;

/**
 * Tune the input-side smoothing time constant from a 0..1 weight that
 * matches `filtering.smoothing_weight` in config.yaml. Mapping:
 *
 *   weight 0.0 → τ = 0.0 s   (no smoothing, raw passthrough)
 *   weight 0.4 → τ = 1.5 s   (current default — modest lag, modest jitter)
 *   weight 0.7 → τ = 3.0 s   (upstream default — heavy smoothing)
 *   weight 1.0 → τ = 5.0 s   (very heavy smoothing for noisy environments)
 *
 * Linear in `weight`, so the user can dial responsiveness up or down
 * without thinking in time-constant units.
 */
export function setMeasurementSmoothingWeight(weight: number): void {
  const w = Math.max(0, Math.min(1, weight));
  TAU_SECONDS = w * 5;
}

/** Result of a measurement smoothing update. */
export interface SmoothedMeasurement {
  /** EMA of the distance. */
  mean: number;
  /**
   * Running variance of the distance (exponentially decayed).
   * High variance = node's reading fluctuates a lot = likely
   * intermittent body-shadow or multipath. The solver can use this
   * to down-weight unreliable nodes.
   */
  variance: number;
}

/**
 * Blend a new raw distance reading with the existing smoothed state for
 * the same (device, node) pair. Returns the updated mean AND variance.
 *
 * Variance is tracked via a time-decayed version of Welford's online
 * algorithm: on each sample, we update a running `M2` (sum of squared
 * deviations from the mean) with the same alpha used for the mean EMA.
 * `variance = M2 / effective_weight`. This naturally adapts: a node
 * whose readings are stable has low variance, a body-blocked node
 * whose readings swing from 3 m to 8 m as the user turns has high
 * variance.
 */
export function smoothMeasurementDistance(
  prevSmoothed: number | undefined,
  prevSmoothedAt: number | undefined,
  prevVariance: number | undefined,
  rawNew: number,
  nowMs: number,
): SmoothedMeasurement {
  if (prevSmoothed === undefined || prevSmoothedAt === undefined) {
    return { mean: rawNew, variance: 0 };
  }
  const dtMs = Math.max(0, nowMs - prevSmoothedAt);
  if (dtMs >= MAX_GAP_MS) return { mean: rawNew, variance: 0 };

  // τ = 0 means smoothing disabled — fast-path the raw passthrough.
  if (TAU_SECONDS <= 0) return { mean: rawNew, variance: 0 };

  const dtSec = dtMs / 1000;
  const timeAlpha = 1 - Math.exp(-dtSec / TAU_SECONDS);
  const alpha = Math.max(MIN_ALPHA, Math.min(1, timeAlpha));

  // EMA of mean.
  const newMean = prevSmoothed + alpha * (rawNew - prevSmoothed);

  // EMA of variance (Welford-style with exponential decay).
  // deviation from old mean × deviation from new mean, blended in.
  const devOld = rawNew - prevSmoothed;
  const devNew = rawNew - newMean;
  const prevVar = prevVariance ?? 0;
  const newVariance = (1 - alpha) * prevVar + alpha * devOld * devNew;

  return { mean: newMean, variance: Math.max(0, newVariance) };
}
