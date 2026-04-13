import { fitAllNodes } from "@/lib/calibration/autofit";
import { publishNodeSetting } from "@/lib/mqtt/client";
import { getStore } from "@/lib/state/store";

/**
 * Online calibration auto-apply.
 *
 * Periodically computes per-node absorption fits from the streaming
 * ground-truth statistics, and pushes the proposed value to firmware
 * via MQTT when it differs meaningfully from what's currently set.
 *
 * Safety gates (must ALL pass):
 *   - The fit is `confident` (>= 100 valid samples)
 *   - |proposed − current| ≥ DELTA_THRESHOLD (don't churn on noise)
 *   - |proposed − current| ≤ MAX_SINGLE_STEP (sanity — never let one
 *     update push absorption by more than this)
 *   - Proposed value is in [N_MIN, N_MAX] (physical range)
 *   - At least PER_NODE_RATE_LIMIT_MS since the last auto-apply for
 *     this specific node (gives firmware time to settle and the EMA
 *     to refill with corrected readings before re-evaluating)
 *
 * Convergence: the rate limit + small step lets the system iteratively
 * walk toward the optimal absorption value without firmware churn.
 * Master_bedroom_3 example: 4.50 → 2.56 (one big step) → 2.65 (smaller
 * step 10 min later) → 2.68 → 2.69 → settles, no more updates.
 */

/** Minimum |Δ| to bother publishing. Sub-noise changes get ignored. */
const DELTA_THRESHOLD = 0.05;

/** Maximum |Δ| we'll publish in a single update. */
const MAX_SINGLE_STEP = 1.0;

/** Physical range for absorption. Fits outside get rejected. */
const N_MIN = 2.0;
const N_MAX = 7.0;

/** Per-node minimum gap between auto-applies. */
export const PER_NODE_RATE_LIMIT_MS = 10 * 60_000;

/**
 * Mutable runtime state. Lives on `globalThis` as a per-process
 * singleton so bootstrap (instrumentation.ts) and API routes share
 * the same state — Next.js can otherwise load the same module file
 * into separate contexts and each gets its own copy of any module-
 * scoped `let`, which would silently break `setAutoApplyConfig`'s
 * effect from the API surface's perspective. Same trick the store
 * uses (`__espresenseStore`).
 */
interface AutoApplyState {
  intervalMs: number;
  enabled: boolean;
  /** Per-node rate-limit timestamps (epoch ms of most recent push). */
  lastByNode: Map<string, number>;
  /** Recent push events, newest first. Bounded to AUDIT_LOG_MAX. */
  auditLog: AutoApplyEvent[];
}
const globalForAutoApply = globalThis as unknown as {
  __espresenseAutoApplyState?: AutoApplyState;
};
function state(): AutoApplyState {
  if (!globalForAutoApply.__espresenseAutoApplyState) {
    globalForAutoApply.__espresenseAutoApplyState = {
      intervalMs: 5 * 60_000,
      enabled: true,
      lastByNode: new Map(),
      auditLog: [],
    };
  }
  return globalForAutoApply.__espresenseAutoApplyState;
}

/** First-cycle delay after boot. Constant — no need to make tunable. */
export const AUTO_APPLY_INITIAL_DELAY_MS = 60_000;

/** Current cycle interval in milliseconds. */
export function getAutoApplyIntervalMs(): number {
  return state().intervalMs;
}

/** Whether the auto-apply background loop runs at all. */
export function isAutoApplyEnabled(): boolean {
  return state().enabled;
}

/** Configure auto-apply from the `optimization` config block. */
export function setAutoApplyConfig(opts: {
  enabled: boolean;
  intervalSecs: number;
}): void {
  const s = state();
  s.enabled = opts.enabled;
  if (opts.intervalSecs > 0 && Number.isFinite(opts.intervalSecs)) {
    s.intervalMs = opts.intervalSecs * 1000;
  }
}

export interface AutoApplyEvent {
  nodeId: string;
  oldValue: number;
  newValue: number;
  delta: number;
  validSamples: number;
  rSquared: number;
  timestamp: number;
}

const AUDIT_LOG_MAX = 200;

export function getAutoApplyAuditLog(): readonly AutoApplyEvent[] {
  return state().auditLog;
}

/**
 * Snapshot of the auto-apply state for persistence: audit log + per-node
 * rate-limit timestamps. Both must round-trip across restarts so we don't
 * (a) lose the forensic record and (b) accidentally re-push a node we
 * just pushed 30 seconds before a deploy.
 */
export interface AutoApplyStateSnapshot {
  auditLog: AutoApplyEvent[];
  lastAutoApplyByNode: Record<string, number>;
}

export function getAutoApplyState(): AutoApplyStateSnapshot {
  const s = state();
  return {
    auditLog: [...s.auditLog],
    lastAutoApplyByNode: Object.fromEntries(s.lastByNode),
  };
}

export function restoreAutoApplyState(snap: AutoApplyStateSnapshot): void {
  const s = state();
  s.auditLog.length = 0;
  if (Array.isArray(snap.auditLog)) {
    for (const e of snap.auditLog.slice(0, AUDIT_LOG_MAX)) {
      s.auditLog.push(e);
    }
  }
  s.lastByNode.clear();
  if (snap.lastAutoApplyByNode) {
    for (const [k, v] of Object.entries(snap.lastAutoApplyByNode)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        s.lastByNode.set(k, v);
      }
    }
  }
}

/**
 * Run one cycle of the auto-apply loop. Computes fits, evaluates each
 * against the safety gates, and publishes the ones that pass.
 *
 * Returns the events that were applied (for logging / testing).
 */
export async function runAutoApplyCycle(): Promise<AutoApplyEvent[]> {
  if (!state().enabled) return [];
  const store = getStore();
  const fits = fitAllNodes(store);
  const now = Date.now();
  const applied: AutoApplyEvent[] = [];

  for (const fit of fits) {
    if (!fit.confident) continue;

    // Read what firmware is currently using.
    const currentRaw = store.nodeSettings.get(fit.nodeId)?.get("absorption");
    const currentParsed = currentRaw != null ? parseFloat(currentRaw) : NaN;
    if (!Number.isFinite(currentParsed) || currentParsed <= 0) continue;

    const delta = fit.proposedAbsorption - currentParsed;
    const absDelta = Math.abs(delta);

    // Skip changes too small to matter.
    if (absDelta < DELTA_THRESHOLD) continue;

    // Sanity: clamp to safe physical range.
    if (
      fit.proposedAbsorption < N_MIN ||
      fit.proposedAbsorption > N_MAX
    ) {
      console.warn(
        `[auto-cal] ${fit.nodeId}: proposed ${fit.proposedAbsorption.toFixed(2)} out of range [${N_MIN}, ${N_MAX}], skipping`,
      );
      continue;
    }

    // Cap the per-step change so a wild fit can't make a giant jump.
    let pushValue = fit.proposedAbsorption;
    if (absDelta > MAX_SINGLE_STEP) {
      pushValue = currentParsed + Math.sign(delta) * MAX_SINGLE_STEP;
    }

    // Per-node rate limit.
    const s = state();
    const lastApplied = s.lastByNode.get(fit.nodeId) ?? 0;
    if (now - lastApplied < PER_NODE_RATE_LIMIT_MS) continue;

    try {
      await publishNodeSetting(
        fit.nodeId,
        "absorption",
        pushValue.toFixed(2),
      );
      s.lastByNode.set(fit.nodeId, now);

      const event: AutoApplyEvent = {
        nodeId: fit.nodeId,
        oldValue: currentParsed,
        newValue: pushValue,
        delta: pushValue - currentParsed,
        validSamples: fit.validSamples,
        rSquared: fit.rSquared,
        timestamp: now,
      };
      applied.push(event);
      s.auditLog.unshift(event);
      if (s.auditLog.length > AUDIT_LOG_MAX) s.auditLog.pop();

      console.log(
        `[auto-cal] ${fit.nodeId}: ${currentParsed.toFixed(2)} → ${pushValue.toFixed(2)} ` +
          `(Δ${event.delta >= 0 ? "+" : ""}${event.delta.toFixed(2)}, R²=${fit.rSquared.toFixed(2)}, n=${fit.validSamples})`,
      );
    } catch (err) {
      console.error(
        `[auto-cal] ${fit.nodeId}: publish failed:`,
        (err as Error).message,
      );
    }
  }

  return applied;
}
