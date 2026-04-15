import type { Store, GroundTruthSample } from "@/lib/state/store";

/**
 * Log-log regression fitting for per-node and per-pair calibration.
 *
 * The path-loss model with a constant offset:
 *
 *     d_measured = C × d_real^(n_real / n_assumed)
 *
 * Taking log and multiplying by `n_assumed` to eliminate its division:
 *
 *     n_assumed × log(d_measured) = log(C) + n_real × log(d_real)
 *
 * That's linear in `log(d_real)` with slope `n_real` and intercept
 * `log(C)`. Weighted least squares gives us both parameters from one
 * pass, along with R² as a quality metric. This is strictly more
 * expressive than the old "compute per-sample n, take median"
 * approach, which silently forced `C = 1` and couldn't account for
 * miscalibrated reference RSSI on individual nodes.
 *
 * **Streaming / online updates**
 *
 * Instead of re-fitting from scratch on every sample, we maintain
 * "sufficient statistics" per listener (and per pair) — the weighted
 * sums W, Σx, Σy, Σx², Σxy, Σy². Each new sample updates these in
 * O(1) and the fit is recovered from them in O(1). The old batch
 * 30 s refresh becomes unnecessary — calibration reflects the latest
 * sample as soon as it lands.
 *
 * **Recency weighting**
 *
 * Each new sample contributes a unit of weight, but *before* adding
 * it we decay the existing stats by `exp(-Δt / τ)` where Δt is the
 * time since the last update and τ is ~1 hour. Older samples fade
 * smoothly, so the fit adapts as the environment changes (doors
 * opened, people moved, HVAC cycling) without a hard window.
 */

// ─── Sufficient statistics ────────────────────────────────────────────────

/**
 * Running sums for a time-decayed weighted linear regression in
 * (x, y) = (log(d_real), n_assumed × log(d_measured)) space.
 *
 * **Where this applies**: per-LISTENER fits pool samples across all
 * transmitters, so `d_real` genuinely varies (different neighbors are
 * at different true distances) and the regression is well-determined
 * — both slope `n_real` and intercept `log(C)` are identifiable.
 *
 * **Where it does NOT apply**: per-PAIR fits have all samples at the
 * same `d_real` (the two nodes don't move). Constant x means the
 * regression is singular and you can't separate slope from intercept.
 * For per-pair fits we use a simpler single-parameter scheme — see
 * `PairStats` below.
 */
export interface LogLogStats {
  W: number; // total weight
  Sx: number; // Σ w·x
  Sy: number; // Σ w·y
  Sxx: number; // Σ w·x²
  Sxy: number; // Σ w·x·y
  Syy: number; // Σ w·y²
  lastUpdateMs: number;
}

/**
 * Streaming stats for a per-pair single-parameter fit. At a fixed
 * (listener, transmitter) pair, `d_real` is constant, so the only
 * free parameter is `n_real`. Per sample we compute
 *
 *     n_i = absorptionAtTime_i × log(d_measured_i) / log(d_real)
 *
 * and track a time-decayed weighted average across samples. The fit
 * quality is the *variance* of the n estimates — low variance means
 * a consistent path.
 */
export interface PairStats {
  W: number; // total weight
  SumN: number; // Σ w_i · n_i
  SumN2: number; // Σ w_i · n_i² (for variance → R²-like quality)
  meanTrueDist: number;
  meanMeasured: number;
  lastUpdateMs: number;
}

/** Time constant for recency weighting. Samples halve at τ·ln(2). */
const RECENCY_TAU_MS = 60 * 60 * 1000; // 1 hour

/** Minimum effective weighted sample count before we publish a fit. */
const MIN_EFFECTIVE_SAMPLES = 5;

/**
 * Defensive ceiling on streaming weight. The exponential decay should
 * keep W bounded in steady state (~τ × arrival_rate), but a
 * pathological case (clock skew, dt=0 same-millisecond bursts that
 * skip decay, or someone tweaking RECENCY_TAU_MS without thinking)
 * could let it grow unboundedly. When W crosses this cap, scale all
 * sums down by the same factor — preserves mean/variance exactly,
 * just keeps magnitudes from drifting into precision-loss territory.
 */
const MAX_W = 10_000;

function clampStats(
  stats: { W: number } & Record<string, number | undefined>,
  fields: ReadonlyArray<string>,
): void {
  if (stats.W <= MAX_W) return;
  const factor = MAX_W / stats.W;
  stats.W = MAX_W;
  for (const f of fields) {
    const v = stats[f];
    if (typeof v === "number") stats[f] = v * factor;
  }
}

const PAIR_STATS_FIELDS = ["SumN", "SumN2"] as const;
const LOGLOG_STATS_FIELDS = ["Sx", "Sy", "Sxx", "Sxy", "Syy"] as const;

/** Distances below this make log() numerically unstable. */
const MIN_TRUE_DIST = 1.0;

/** Physically plausible range for n_real. */
const N_REAL_MIN = 1.5;
const N_REAL_MAX = 8.0;

export function newLogLogStats(): LogLogStats {
  return { W: 0, Sx: 0, Sy: 0, Sxx: 0, Sxy: 0, Syy: 0, lastUpdateMs: 0 };
}

export function newPairStats(): PairStats {
  return {
    W: 0,
    SumN: 0,
    SumN2: 0,
    meanTrueDist: 0,
    meanMeasured: 0,
    lastUpdateMs: 0,
  };
}

/** Decay a PairStats in place to `nowMs`. */
export function decayPairStats(stats: PairStats, nowMs: number): void {
  if (stats.lastUpdateMs === 0) {
    stats.lastUpdateMs = nowMs;
    return;
  }
  const dt = Math.max(0, nowMs - stats.lastUpdateMs);
  if (dt === 0) return;
  const factor = Math.exp(-dt / RECENCY_TAU_MS);
  stats.W *= factor;
  stats.SumN *= factor;
  stats.SumN2 *= factor;
  stats.lastUpdateMs = nowMs;
}

/**
 * Update a per-pair running mean of `n_real` from one ground-truth
 * sample. The mean true/measured values are simple running averages
 * (no decay) so the UI sees the geometric truth rather than a time-
 * weighted view, which would drift as fresh measurements dominate.
 */
export function addSampleToPairStats(
  stats: PairStats,
  sample: GroundTruthSample,
): void {
  if (
    sample.measured <= 0 ||
    sample.trueDist <= MIN_TRUE_DIST ||
    !Number.isFinite(sample.measured) ||
    !Number.isFinite(sample.trueDist)
  ) {
    return;
  }
  const nAssumed =
    Number.isFinite(sample.absorptionAtTime) && sample.absorptionAtTime > 0.1
      ? sample.absorptionAtTime
      : DEFAULT_N_ASSUMED;
  const logTrue = Math.log(sample.trueDist);
  if (Math.abs(logTrue) < 1e-6) return;
  // Structural-loss correction: the per-pair `n_real` should reflect
  // clutter-driven propagation, not architecture. The only consumer
  // today is the device-detail diagnostics panel (PathAware is not in
  // the active locator stack), so there's no live position pipeline
  // whose distance-correction contract we need to preserve. Pushing
  // the cleaner value makes the diagnostic more informative and
  // pre-aligns the data for any future RF-aware locator that reads
  // per-pair fits.
  const W =
    Number.isFinite(sample.obstructionLossDb) && sample.obstructionLossDb != null
      ? sample.obstructionLossDb
      : 0;
  const correctedY = nAssumed * Math.log(sample.measured) - W * LN10_OVER_10;
  const n = correctedY / logTrue;
  if (!Number.isFinite(n) || n < N_REAL_MIN || n > N_REAL_MAX) return;

  decayPairStats(stats, sample.timestamp);
  // Running mean of true/measured distances — non-decayed so the UI
  // reads a stable geometric truth.
  const oldCount = stats.meanTrueDist === 0 ? 0 : stats.W; // approx
  const newCount = oldCount + 1;
  stats.meanTrueDist =
    (stats.meanTrueDist * oldCount + sample.trueDist) / newCount;
  stats.meanMeasured =
    (stats.meanMeasured * oldCount + sample.measured) / newCount;

  stats.W += 1;
  stats.SumN += n;
  stats.SumN2 += n * n;
  clampStats(stats as unknown as { W: number } & Record<string, number | undefined>, PAIR_STATS_FIELDS);
}

/**
 * Recover per-pair fit parameters from running sums. Since x is
 * constant at a single pair, we only fit the mean of n. Quality is
 * expressed as a (1 − variance / fixed_max_var) proxy so the field
 * lines up with the listener-level R² semantics (higher = better).
 */
export interface PairFitParams {
  nReal: number;
  rSquared: number; // variance-based quality proxy, 0..1
  effectiveSamples: number;
  meanTrueDist: number;
  meanMeasured: number;
}

export function computePairFit(stats: PairStats): PairFitParams | null {
  if (stats.W < MIN_EFFECTIVE_SAMPLES) return null;
  const nMean = stats.SumN / stats.W;
  const nVar = Math.max(0, stats.SumN2 / stats.W - nMean * nMean);
  // Map variance to a 0..1 quality score. Variance of 0 → 1.0 (perfect
  // consistency). Variance of 1 (n values spread across a full
  // log-space unit) → 0.5. Variance of 4 → 0.2. Never literally 0.
  const rSquared = 1 / (1 + nVar);
  return {
    nReal: nMean,
    rSquared,
    effectiveSamples: stats.W,
    meanTrueDist: stats.meanTrueDist,
    meanMeasured: stats.meanMeasured,
  };
}

/**
 * Decay all sums by `exp(-Δt/τ)` where Δt is the elapsed time since
 * the last update. First call just stamps the time and returns.
 */
export function decayStats(stats: LogLogStats, nowMs: number): void {
  if (stats.lastUpdateMs === 0) {
    stats.lastUpdateMs = nowMs;
    return;
  }
  const dt = Math.max(0, nowMs - stats.lastUpdateMs);
  if (dt === 0) return;
  const factor = Math.exp(-dt / RECENCY_TAU_MS);
  stats.W *= factor;
  stats.Sx *= factor;
  stats.Sy *= factor;
  stats.Sxx *= factor;
  stats.Sxy *= factor;
  stats.Syy *= factor;
  stats.lastUpdateMs = nowMs;
}

/** Fallback when a sample's `absorptionAtTime` is unusable (firmware
 *  had no absorption setting yet, or the MQTT retained value was "0"). */
const DEFAULT_N_ASSUMED = 2.7;

/**
 * Converts a dB obstruction loss to the equivalent shift in `y =
 * n_assumed · ln(d_measured)` space. Derivation:
 *
 *     rssi_obs = ref_1m − 10·n_real·log10(d_real) − W          (physics)
 *     rssi_obs = tx_ref − 10·n_assumed·log10(d_measured)       (firmware)
 *
 * Equating and rearranging in natural-log coordinates:
 *
 *     n_assumed · ln(d_measured) = log(C) + n_real·ln(d_real) + W·ln(10)/10
 *
 * So subtracting `W · LN10_OVER_10` from y before regression factors
 * out the known structural loss, leaving the fit to explain only
 * cluttered-propagation effects (path-loss exponent `n_real` + per-node
 * TX/RX bias in `log(C)`).
 */
const LN10_OVER_10 = Math.LN10 / 10;

/**
 * Add one ground-truth sample to the running stats. Applies recency
 * decay first, then accumulates the new sample with unit weight.
 * Silently no-ops on samples whose distances aren't usable for logs.
 * Historic samples with `absorptionAtTime <= 0` are accepted with the
 * default substituted — they survive in the ring buffer from before
 * the handler learned to reject "0" absorption settings, and dropping
 * them would leave affected listeners with empty fits until the
 * buffer turns over.
 */
export function addSampleToStats(
  stats: LogLogStats,
  sample: GroundTruthSample,
): void {
  if (
    sample.measured <= 0 ||
    sample.trueDist <= MIN_TRUE_DIST ||
    !Number.isFinite(sample.measured) ||
    !Number.isFinite(sample.trueDist)
  ) {
    return;
  }
  const nAssumed =
    Number.isFinite(sample.absorptionAtTime) && sample.absorptionAtTime > 0.1
      ? sample.absorptionAtTime
      : DEFAULT_N_ASSUMED;
  decayStats(stats, sample.timestamp);
  const x = Math.log(sample.trueDist);
  // Per-LISTENER fit: `y` is the firmware's log-distance in "absorption
  // units." Intentionally does NOT subtract the structural-loss term W
  // — firmware has no geometric awareness, so its absorption setting
  // must be the path-loss exponent it effectively sees, walls and all.
  // Factoring W out here and auto-applying the cleaner value makes
  // firmware systematically overestimate distance on walled paths
  // (confirmed empirically: dropping push values from ~4.0 to ~2.8
  // blew up device positions on a home with drywall-heavy geometry).
  //
  // The per-pair fit DOES subtract W — its consumers (PathAware,
  // EnvironmentAware, diagnostics) have geometry and can apply the
  // correction at the device estimate, not the listener-neighborhood
  // average.
  const y = nAssumed * Math.log(sample.measured);
  stats.W += 1;
  stats.Sx += x;
  stats.Sy += y;
  stats.Sxx += x * x;
  stats.Sxy += x * y;
  stats.Syy += y * y;
  clampStats(stats as unknown as { W: number } & Record<string, number | undefined>, LOGLOG_STATS_FIELDS);
}

/**
 * Recover the fit parameters from the sufficient statistics. Returns
 * null if there isn't enough weight or the x-distribution is degenerate.
 * R² is the classical coefficient of determination for a weighted fit.
 */
export interface LogLogFit {
  nReal: number;
  logK: number;
  rSquared: number;
  effectiveSamples: number;
}

export function computeLogLogFit(stats: LogLogStats): LogLogFit | null {
  const W = stats.W;
  if (W < MIN_EFFECTIVE_SAMPLES) return null;

  const denom = W * stats.Sxx - stats.Sx * stats.Sx;
  if (Math.abs(denom) < 1e-9) return null; // all x near-identical

  const numerator = W * stats.Sxy - stats.Sx * stats.Sy;
  const nReal = numerator / denom;
  const logK = (stats.Sy - nReal * stats.Sx) / W;

  const yDenom = W * stats.Syy - stats.Sy * stats.Sy;
  const rSquared =
    yDenom > 1e-9 ? (numerator * numerator) / (denom * yDenom) : 0;

  // Clamp n_real into the physical range as a safety net. The
  // regression itself is unbounded; this prevents numerically-unstable
  // samples from producing nonsense corrections that blow up PathAware.
  const clampedN = Math.max(N_REAL_MIN, Math.min(N_REAL_MAX, nReal));

  return {
    nReal: clampedN,
    logK,
    rSquared: Math.max(0, Math.min(1, rSquared)),
    effectiveSamples: W,
  };
}

// ─── Per-node fit (single n per listener) ─────────────────────────────────

export interface NodeFit {
  nodeId: string;
  /** Number of raw samples seen. */
  totalSamples: number;
  /** Effective weighted count after recency decay. */
  validSamples: number;
  /** Samples dropped for failing sanity checks. */
  outliers: number;
  /** Mode of `absorptionAtTime` across samples — the firmware's likely current value. */
  currentAbsorption: number;
  /** The new `n_real` from log-log regression. */
  proposedAbsorption: number;
  /** R² of the regression, 0..1. Higher = cleaner fit. */
  rSquared: number;
  /** Log-space residual RMSE, a rough uncertainty indicator. */
  iqr: number;
  /** Placeholder kept for UI compat — no longer a true MAD. */
  mad: number;
  q1: number;
  q3: number;
  /** True if we're confident enough to push this value to firmware. */
  confident: boolean;
}

/** Minimum effective samples before a node fit is worth pushing to firmware. */
const NODE_FIT_MIN_SAMPLES = 100;

export function fitNodeAbsorption(
  nodeId: string,
  samples: readonly GroundTruthSample[],
): NodeFit {
  // Replay all samples through the streaming stats (pre-decayed to
  // each sample's timestamp) so the fit is equivalent to what the
  // online path would produce.
  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const stats = newLogLogStats();
  const absCounts = new Map<number, number>();
  let validRaw = 0;
  let outliers = 0;
  for (const s of sorted) {
    absCounts.set(
      s.absorptionAtTime,
      (absCounts.get(s.absorptionAtTime) ?? 0) + 1,
    );
    const wBefore = stats.W;
    addSampleToStats(stats, s);
    if (stats.W > wBefore) validRaw += 1;
    else outliers += 1;
  }

  // Mode of `absorptionAtTime` — if calibration changed mid-collection
  // the dominant value best represents "what the firmware is using now."
  let currentAbsorption = 2.7;
  let bestCount = 0;
  for (const [abs, c] of absCounts) {
    if (c > bestCount) {
      bestCount = c;
      currentAbsorption = abs;
    }
  }

  // Firmware-applicable slope: the best `n` assuming intercept = 0
  // (i.e. `log(C) = 0`, `C = 1`). This is the single parameter the
  // firmware's distance formula actually uses. Derived analytically
  // from the same sufficient statistics as the 2-param regression:
  //
  //     minimize Σ w_i (y_i − n·x_i)²
  //     ⇒ n = Σ(w·x·y) / Σ(w·x²) = Sxy / Sxx
  //
  // DO NOT return the 2-parameter slope here — that value assumes a
  // paired intercept correction (via tx_ref_rssi) that the firmware
  // absorption setting alone can't express. Pushing just the 2-param
  // slope to firmware produces wildly wrong distances because the
  // formula's offset term is left uncompensated.
  if (stats.Sxx < 1e-9 || stats.W < MIN_EFFECTIVE_SAMPLES) {
    return {
      nodeId,
      totalSamples: samples.length,
      validSamples: Math.round(stats.W),
      outliers,
      currentAbsorption,
      proposedAbsorption: currentAbsorption,
      rSquared: 0,
      iqr: 0,
      mad: 0,
      q1: 0,
      q3: 0,
      confident: false,
    };
  }
  const rawSlope = stats.Sxy / stats.Sxx;
  const proposedAbsorption = Math.max(
    N_REAL_MIN,
    Math.min(N_REAL_MAX, rawSlope),
  );

  // 1-param R²: goodness of fit for `y = n·x` (no intercept).
  //   SS_res = Σ w·(y − n·x)²
  //          = Syy − 2n·Sxy + n²·Sxx
  //   SS_tot = Σ w·y² = Syy   (no centering — intercept forced to 0)
  const nFit = rawSlope;
  const ssRes = Math.max(
    0,
    stats.Syy - 2 * nFit * stats.Sxy + nFit * nFit * stats.Sxx,
  );
  const ssTot = stats.Syy > 1e-9 ? stats.Syy : 1e-9;
  const rSquared = Math.max(0, Math.min(1, 1 - ssRes / ssTot));

  // Spread proxy for the UI column. Same semantics as the per-pair
  // version — derived from lack-of-fit so higher means less certain.
  const iqrProxy = 2 * Math.sqrt(Math.max(0, 1 - rSquared));

  return {
    nodeId,
    totalSamples: samples.length,
    validSamples: Math.round(stats.W),
    outliers,
    currentAbsorption,
    proposedAbsorption,
    rSquared,
    iqr: iqrProxy,
    mad: iqrProxy / 1.4826,
    q1: proposedAbsorption - iqrProxy / 2,
    q3: proposedAbsorption + iqrProxy / 2,
    confident: validRaw >= NODE_FIT_MIN_SAMPLES && rSquared >= 0.5,
  };
}

/** Fit every listener node that has any samples. */
export function fitAllNodes(store: Store): NodeFit[] {
  const fits: NodeFit[] = [];
  for (const [nodeId, samples] of store.nodeGroundTruthSamples) {
    fits.push(fitNodeAbsorption(nodeId, samples));
  }
  return fits.sort((a, b) => b.validSamples - a.validSamples);
}

// ─── Per-pair fit ─────────────────────────────────────────────────────────

/**
 * Per-(listener, transmitter) calibration. At a fixed pair the true
 * distance is constant, so only the path-loss *exponent* `n_real` is
 * identifiable from samples on that path alone — the constant offset
 * `log(C)` can't be separated from the mean of log(d_measured) at a
 * single x. For the offset we rely on the listener-level fit, which
 * pools samples across many different true distances.
 *
 * `rSquared` here is a variance-based quality proxy rather than a
 * true regression R² (the regression is degenerate), but semantics
 * line up: higher means the per-sample n values agree more tightly,
 * which is a real signal about how clean this specific path is.
 *
 * `perPairAbsorption` is a back-compat alias of `nReal` so the
 * calibration UI that reads the old field keeps rendering.
 */
export interface NodePairFit {
  transmitterId: string;
  /** Local path-loss exponent for this specific (L, T) path. */
  nReal: number;
  /**
   * Variance-based quality, 0..1. Higher = more consistent per-sample
   * n values across time. Used by PathAware to down-weight muddy
   * paths during correction interpolation.
   */
  rSquared: number;
  /** Effective weighted count after recency decay. */
  effectiveSamples: number;

  // Legacy / UI compat fields:
  /** Alias of `nReal`. */
  perPairAbsorption: number;
  /** Total raw samples seen for this pair. */
  totalSamples: number;
  /** Whole-number version of `effectiveSamples`. */
  validSamples: number;
  outliers: number;
  /** UI "uncertainty" indicator, derived from (1 − rSquared). */
  iqr: number;
  meanTrueDist: number;
  meanMeasured: number;
}

/**
 * Rebuild every listener's pair stats from their ring buffer of
 * ground-truth samples. Called on bootstrap and from the calibration
 * API for idempotent self-heal.
 */
export function refreshNodePairFits(store: Store): void {
  for (const [listenerId, samples] of store.nodeGroundTruthSamples) {
    const statsByTx = rebuildPairStatsFromSamples(samples);
    store.nodePairFitStats.set(listenerId, statsByTx);

    let fitMap = store.nodePairFits.get(listenerId);
    if (!fitMap) {
      fitMap = new Map();
      store.nodePairFits.set(listenerId, fitMap);
    } else {
      fitMap.clear();
    }

    for (const [txId, stats] of statsByTx) {
      if (txId === listenerId) continue;
      const pairFit = buildNodePairFitFromStats(txId, stats);
      if (pairFit) fitMap.set(txId, pairFit);
    }
  }
}

/**
 * Group a listener's samples by transmitter and produce streaming
 * `PairStats` per group. Samples are sorted by timestamp so the
 * recency decay is applied in causal order (equivalent to what the
 * online path would produce).
 */
function rebuildPairStatsFromSamples(
  samples: readonly GroundTruthSample[],
): Map<string, PairStats> {
  const byTx = new Map<string, GroundTruthSample[]>();
  for (const s of samples) {
    let bucket = byTx.get(s.transmitterId);
    if (!bucket) {
      bucket = [];
      byTx.set(s.transmitterId, bucket);
    }
    bucket.push(s);
  }

  const statsByTx = new Map<string, PairStats>();
  for (const [txId, txSamples] of byTx) {
    txSamples.sort((a, b) => a.timestamp - b.timestamp);
    const stats = newPairStats();
    for (const s of txSamples) {
      addSampleToPairStats(stats, s);
    }
    statsByTx.set(txId, stats);
  }
  return statsByTx;
}

function buildNodePairFitFromStats(
  txId: string,
  stats: PairStats,
): NodePairFit | null {
  const fit = computePairFit(stats);
  if (!fit) return null;

  // (1 − R²)-derived spread proxy so the existing UI column can still
  // render something meaningful. Perfect consistency → 0, wide spread → 2.
  const iqrProxy = 2 * Math.sqrt(Math.max(0, 1 - fit.rSquared));

  return {
    transmitterId: txId,
    nReal: fit.nReal,
    rSquared: fit.rSquared,
    effectiveSamples: fit.effectiveSamples,
    perPairAbsorption: fit.nReal,
    totalSamples: Math.round(fit.effectiveSamples),
    validSamples: Math.round(fit.effectiveSamples),
    outliers: 0,
    iqr: iqrProxy,
    meanTrueDist: fit.meanTrueDist,
    meanMeasured: fit.meanMeasured,
  };
}

/**
 * Incrementally update one listener's pair fit for a single new
 * ground-truth sample. Called from the MQTT handler on every
 * node-to-node observation. O(1) per call.
 */
export function updatePairFitFromSample(
  store: Store,
  listenerId: string,
  sample: GroundTruthSample,
): void {
  if (sample.transmitterId === listenerId) return;

  let statsByTx = store.nodePairFitStats.get(listenerId);
  if (!statsByTx) {
    statsByTx = new Map();
    store.nodePairFitStats.set(listenerId, statsByTx);
  }
  let stats = statsByTx.get(sample.transmitterId);
  if (!stats) {
    stats = newPairStats();
    statsByTx.set(sample.transmitterId, stats);
  }

  addSampleToPairStats(stats, sample);

  const pairFit = buildNodePairFitFromStats(sample.transmitterId, stats);
  if (!pairFit) return;

  let fitMap = store.nodePairFits.get(listenerId);
  if (!fitMap) {
    fitMap = new Map();
    store.nodePairFits.set(listenerId, fitMap);
  }
  fitMap.set(sample.transmitterId, pairFit);
}
