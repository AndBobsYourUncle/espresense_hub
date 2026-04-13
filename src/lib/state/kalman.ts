/**
 * 6-D constant-velocity Kalman filter for device positions.
 *
 * State vector:  [x, y, z, vx, vy, vz]                      (6 elements)
 * Covariance:    6×6 row-major (36 elements)
 * Measurement:   [x, y, z] from the locator output           (3 elements)
 *
 * --- Why Kalman over the EMA we had before ---
 *
 * The EMA assumes "the device wants to stay where it was"; every new
 * fix is blended slowly toward the previous estimate. That works for a
 * stationary device but lags badly during motion — the EMA can only
 * track movement by accumulating fixes that disagree with the old
 * estimate, which by definition takes time.
 *
 * The Kalman filter tracks **position and velocity** as state. Each
 * update it first *predicts* forward by the elapsed time using the
 * current velocity, then blends that prediction with the new
 * measurement weighted by their relative uncertainties (the Kalman
 * gain). The result:
 *
 *   - When the device is moving steadily, the prediction already
 *     points where it's going — the new fix only refines, doesn't
 *     drag the marker forward. Far less perceived lag than EMA.
 *   - When stationary, velocity converges to zero, predict is a
 *     no-op, and measurement noise averages out as in a heavy EMA.
 *   - Outlier fixes get near-zero weight automatically when they
 *     fall outside the prediction's uncertainty bounds.
 *
 * --- Tuning ---
 *
 * Two knobs from `filtering.{process_noise, measurement_noise}`:
 *
 *   process_noise (σ_a, m/s²) — std dev of acceleration. How much the
 *     velocity is allowed to change between updates. Higher = more
 *     responsive to direction changes but jitter creeps back in.
 *     0.5 is reasonable for a human walking; 1.5+ for a phone being
 *     waved around.
 *
 *   measurement_noise (σ_m, meters) — base std dev of the locator
 *     output's position error. Scaled per-update by 1/confidence,
 *     so a 0.3-confidence fix gets ~3× the noise of a 1.0-confidence
 *     fix. 0.5 m is a good default for our locator stack.
 *
 * --- Why constant-velocity (and not constant-acceleration) ---
 *
 * Humans walking change direction often enough that an explicit
 * acceleration term in the state isn't worth the extra complexity.
 * The process noise term absorbs unmodeled accelerations as injected
 * uncertainty — exactly what discrete white-noise-acceleration models
 * do. KISS.
 */

/** Kalman state stored per-device. */
export interface KalmanState {
  /** [x, y, z, vx, vy, vz] */
  x: number[];
  /** 6×6 covariance, row-major. */
  P: number[];
  /** Wall-clock ms of the last update — for computing dt on the next. */
  lastMs: number;
}

/** Process noise σ_a, in m/s². Settable from config at bootstrap. */
let SIGMA_A = 0.5;

/** Measurement noise σ_m, in meters (baseline before confidence scaling). */
let SIGMA_M = 0.5;

/**
 * Maximum dt between updates we'll predict over. Past this, the
 * velocity prior is too stale to trust — we reinitialize state from
 * the measurement (with conservative covariance).
 */
const MAX_GAP_MS = 30_000;

/**
 * Maximum reasonable per-update predicted gap, in seconds. A 30 s gap
 * with a stale 1 m/s velocity would predict 30 m of movement —
 * obviously wrong. Capping dt prevents the predict step from
 * extrapolating into nonsense.
 */
const MAX_PREDICT_DT_S = 5;

/** Set the process noise (m/s² acceleration std dev). Called from bootstrap. */
export function setKalmanProcessNoise(sigma: number): void {
  SIGMA_A = Math.max(0.001, sigma);
}

/** Set the measurement noise (m position std dev baseline). */
export function setKalmanMeasurementNoise(sigma: number): void {
  SIGMA_M = Math.max(0.001, sigma);
}

/**
 * Initialize a new Kalman state from a single measurement.
 *
 * Initial covariance: confident on position (σ_m), unknown on velocity
 * (assume up to ±2 m/s on first sight). The next fix that arrives
 * will quickly refine the velocity estimate.
 */
export function kalmanInit(
  pos: readonly [number, number, number],
  nowMs: number,
  measurementSigma = SIGMA_M,
): KalmanState {
  const sm2 = measurementSigma * measurementSigma;
  // Velocity priors: assume 2 m/s std dev — generous, will tighten fast.
  const sv2 = 2 * 2;
  const P = new Array(36).fill(0);
  // Diagonal: positional variance (top-left 3×3) + velocity variance (bot-right 3×3)
  P[0 * 6 + 0] = sm2;
  P[1 * 6 + 1] = sm2;
  P[2 * 6 + 2] = sm2;
  P[3 * 6 + 3] = sv2;
  P[4 * 6 + 4] = sv2;
  P[5 * 6 + 5] = sv2;
  return {
    x: [pos[0], pos[1], pos[2], 0, 0, 0],
    P,
    lastMs: nowMs,
  };
}

/**
 * Run one predict + update cycle. Returns the new state. The caller
 * stores it back on the device record.
 *
 *   prev:        existing state (or null/undefined → initialize)
 *   measurement: locator output [x, y, z]
 *   confidence:  0..1 from the locator; scales measurement noise
 *   nowMs:       wall-clock ms when the fix was computed
 */
export function kalmanStep(
  prev: KalmanState | null | undefined,
  measurement: readonly [number, number, number],
  confidence: number,
  nowMs: number,
): KalmanState {
  const sigmaM = SIGMA_M / Math.max(0.1, confidence);

  // Cold start (first fix or after a long silence).
  if (!prev) return kalmanInit(measurement, nowMs, sigmaM);
  const dtMs = nowMs - prev.lastMs;
  if (dtMs < 0 || dtMs >= MAX_GAP_MS) {
    return kalmanInit(measurement, nowMs, sigmaM);
  }
  const dt = Math.min(MAX_PREDICT_DT_S, dtMs / 1000);

  // --- Predict step --------------------------------------------------
  // x_pred = F · x        F = constant-velocity transition
  const [px, py, pz, vx, vy, vz] = prev.x;
  const xPred = [px + vx * dt, py + vy * dt, pz + vz * dt, vx, vy, vz];

  // P_pred = F · P · Fᵀ + Q
  // For our F (identity + dt on the off-diagonal velocity block), the
  // resulting matrix has a clean closed form per (position, velocity)
  // axis pair. We do it inline to avoid a generic 6×6 matmul.
  // Q is the discrete white-noise-acceleration model:
  //   per-axis 2×2 block = σ_a² · [[dt⁴/4, dt³/2], [dt³/2, dt²]]
  const sa2 = SIGMA_A * SIGMA_A;
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt2 * dt2;
  const Qpp = sa2 * (dt4 / 4); // pos-pos
  const Qpv = sa2 * (dt3 / 2); // pos-vel cross
  const Qvv = sa2 * dt2; // vel-vel

  // P_pred from F·P·Fᵀ. Reorganized into per-axis 2×2 blocks
  // (pos_axis, vel_axis), since F couples each (pos, vel) pair only.
  const PPred = computePPred(prev.P, dt);
  // Add Q (axis-independent, on-diagonal blocks of 2×2).
  for (let i = 0; i < 3; i++) {
    const pp = i; // position index
    const vv = i + 3; // velocity index
    PPred[pp * 6 + pp] += Qpp;
    PPred[vv * 6 + vv] += Qvv;
    PPred[pp * 6 + vv] += Qpv;
    PPred[vv * 6 + pp] += Qpv;
  }

  // --- Update step ---------------------------------------------------
  // y = z - H · x_pred       innovation (3×1)
  const innov = [
    measurement[0] - xPred[0],
    measurement[1] - xPred[1],
    measurement[2] - xPred[2],
  ];

  // S = H · P_pred · Hᵀ + R     innovation covariance (3×3)
  // H selects the position rows/cols, so S = top-left 3×3 of P_pred + R
  const sm2 = sigmaM * sigmaM;
  const S = [
    PPred[0 * 6 + 0] + sm2, PPred[0 * 6 + 1],       PPred[0 * 6 + 2],
    PPred[1 * 6 + 0],       PPred[1 * 6 + 1] + sm2, PPred[1 * 6 + 2],
    PPred[2 * 6 + 0],       PPred[2 * 6 + 1],       PPred[2 * 6 + 2] + sm2,
  ];
  const Sinv = invert3x3(S);
  if (!Sinv) {
    // Degenerate covariance — reinitialize rather than NaN propagating.
    return kalmanInit(measurement, nowMs, sigmaM);
  }

  // K = P_pred · Hᵀ · S⁻¹     Kalman gain (6×3)
  // P_pred · Hᵀ is the first 3 columns of P_pred (since H selects pos).
  const PHt: number[] = new Array(18); // 6 rows × 3 cols
  for (let r = 0; r < 6; r++) {
    PHt[r * 3 + 0] = PPred[r * 6 + 0];
    PHt[r * 3 + 1] = PPred[r * 6 + 1];
    PHt[r * 3 + 2] = PPred[r * 6 + 2];
  }
  const K: number[] = new Array(18); // 6 rows × 3 cols
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 3; c++) {
      K[r * 3 + c] =
        PHt[r * 3 + 0] * Sinv[0 * 3 + c] +
        PHt[r * 3 + 1] * Sinv[1 * 3 + c] +
        PHt[r * 3 + 2] * Sinv[2 * 3 + c];
    }
  }

  // x_new = x_pred + K · y
  const xNew = new Array(6);
  for (let r = 0; r < 6; r++) {
    xNew[r] =
      xPred[r] +
      K[r * 3 + 0] * innov[0] +
      K[r * 3 + 1] * innov[1] +
      K[r * 3 + 2] * innov[2];
  }

  // P_new = (I - K · H) · P_pred
  // K · H sets the position columns of an effective 6×6 mask.
  const KH = new Array(36).fill(0);
  for (let r = 0; r < 6; r++) {
    KH[r * 6 + 0] = K[r * 3 + 0];
    KH[r * 6 + 1] = K[r * 3 + 1];
    KH[r * 6 + 2] = K[r * 3 + 2];
  }
  const PNew = new Array(36);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      let s = PPred[r * 6 + c];
      for (let k = 0; k < 6; k++) {
        s -= KH[r * 6 + k] * PPred[k * 6 + c];
      }
      PNew[r * 6 + c] = s;
    }
  }
  // Symmetrize to fight numerical drift.
  for (let r = 0; r < 6; r++) {
    for (let c = r + 1; c < 6; c++) {
      const avg = 0.5 * (PNew[r * 6 + c] + PNew[c * 6 + r]);
      PNew[r * 6 + c] = avg;
      PNew[c * 6 + r] = avg;
    }
  }

  return { x: xNew, P: PNew, lastMs: nowMs };
}

/**
 * Compute F · P · Fᵀ for our specific F (constant-velocity, 6×6
 * with `dt` on the (pos, vel) off-diagonals). Done inline to avoid a
 * generic 6×6×6 triple loop — only 3 axes, each a 2×2 transform.
 */
function computePPred(P: readonly number[], dt: number): number[] {
  const out = new Array(36);
  // F is block-diagonal in [(x,vx), (y,vy), (z,vz)] axes... almost.
  // Actually F doesn't mix axes, so the (pos, vel) blocks for x are
  // independent of the y blocks. But the off-diagonal cross-axis terms
  // in P (e.g. P[x][vy]) do propagate through the dt term.
  // Easiest: do the general F·P·Fᵀ. F is sparse:
  //   F[r][c] = δ(r,c) + dt · (1 if c == r+3 and r < 3 else 0)
  // For each output (r, c):
  //   (FPFᵀ)[r][c] = Σ_i Σ_j F[r][i] · P[i][j] · F[c][j]
  // Because F is identity-plus-coupling, this expands to four terms.
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      // Effective F·P contribution: F[r][i] is 1 if i==r, plus dt if r<3 and i==r+3.
      let sum = P[r * 6 + c]; // F[r][r] = 1, F[c][c] = 1
      if (r < 3) sum += dt * P[(r + 3) * 6 + c]; // F[r][r+3] = dt on the row side
      if (c < 3) sum += dt * P[r * 6 + (c + 3)]; // F[c][c+3] = dt on the col side
      if (r < 3 && c < 3) sum += dt * dt * P[(r + 3) * 6 + (c + 3)]; // both
      out[r * 6 + c] = sum;
    }
  }
  return out;
}

/** Invert a 3×3 row-major matrix. Returns null if singular. */
function invert3x3(m: readonly number[]): number[] | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const inv = 1 / det;
  return [A * inv, D * inv, G * inv,
          B * inv, E * inv, H * inv,
          C * inv, F * inv, I * inv];
}
