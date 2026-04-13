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
 * How often the auto-apply check runs. Mutable — settable from
 * `optimization.interval_secs` in config.yaml at bootstrap. Defaults
 * to 5 min, which is much faster than the upstream companion's
 * 1-hour default but matches our streaming-stats philosophy (apply
 * small corrections often, not big ones rarely).
 */
export let AUTO_APPLY_INTERVAL_MS = 5 * 60_000;
export const AUTO_APPLY_INITIAL_DELAY_MS = 60_000;

/** Whether the auto-apply background job runs at all. */
let autoApplyEnabled = true;

/** Configure auto-apply from the `optimization` config block. */
export function setAutoApplyConfig(opts: {
  enabled: boolean;
  intervalSecs: number;
}): void {
  autoApplyEnabled = opts.enabled;
  if (opts.intervalSecs > 0 && Number.isFinite(opts.intervalSecs)) {
    AUTO_APPLY_INTERVAL_MS = opts.intervalSecs * 1000;
  }
}

export function isAutoApplyEnabled(): boolean {
  return autoApplyEnabled;
}

/** Track when each node was last auto-applied so we can rate-limit. */
const lastAutoApplyByNode = new Map<string, number>();

export interface AutoApplyEvent {
  nodeId: string;
  oldValue: number;
  newValue: number;
  delta: number;
  validSamples: number;
  rSquared: number;
  timestamp: number;
}

/** Recent auto-apply audit log (newest first). Bounded to 200 entries. */
const auditLog: AutoApplyEvent[] = [];
const AUDIT_LOG_MAX = 200;

export function getAutoApplyAuditLog(): readonly AutoApplyEvent[] {
  return auditLog;
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
  return {
    auditLog: [...auditLog],
    lastAutoApplyByNode: Object.fromEntries(lastAutoApplyByNode),
  };
}

export function restoreAutoApplyState(snap: AutoApplyStateSnapshot): void {
  auditLog.length = 0;
  if (Array.isArray(snap.auditLog)) {
    for (const e of snap.auditLog.slice(0, AUDIT_LOG_MAX)) {
      auditLog.push(e);
    }
  }
  lastAutoApplyByNode.clear();
  if (snap.lastAutoApplyByNode) {
    for (const [k, v] of Object.entries(snap.lastAutoApplyByNode)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        lastAutoApplyByNode.set(k, v);
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
  if (!autoApplyEnabled) return [];
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
    const lastApplied = lastAutoApplyByNode.get(fit.nodeId) ?? 0;
    if (now - lastApplied < PER_NODE_RATE_LIMIT_MS) continue;

    try {
      await publishNodeSetting(
        fit.nodeId,
        "absorption",
        pushValue.toFixed(2),
      );
      lastAutoApplyByNode.set(fit.nodeId, now);

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
      auditLog.unshift(event);
      if (auditLog.length > AUDIT_LOG_MAX) auditLog.pop();

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
