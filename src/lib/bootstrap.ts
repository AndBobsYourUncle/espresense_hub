import {
  AUTO_APPLY_INITIAL_DELAY_MS,
  getAutoApplyIntervalMs,
  isAutoApplyEnabled,
  runAutoApplyCycle,
  setAutoApplyConfig,
} from "@/lib/calibration/auto_apply";
import { refreshNodePairFits } from "@/lib/calibration/autofit";
import { loadAuditState, saveAuditState } from "@/lib/state/audit_persistence";
import {
  CALIBRATION_SAVE_INTERVAL_MS,
  loadCalibration,
  saveCalibration,
} from "@/lib/state/calibration_persistence";
import { loadConfig, ConfigNotFoundError } from "@/lib/config";
import { connectMqtt } from "@/lib/mqtt/client";
import { attachHandlers } from "@/lib/mqtt/handler";
import { loadDevicePins, saveDevicePins } from "@/lib/state/device_persistence";
import { runDeviceCleanup } from "@/lib/state/device_cleanup";
import {
  setKalmanMeasurementNoise,
  setKalmanProcessNoise,
} from "@/lib/state/kalman";
import { setMeasurementSmoothingWeight } from "@/lib/state/measurement_smoothing";
import { setPositionSmoothingWeight } from "@/lib/state/smoothing";
import { getStore, setPositionFilter } from "@/lib/state/store";

/**
 * Per-pair fits now update *online* — each ground-truth sample
 * incrementally updates the streaming sufficient statistics (see
 * `updatePairFitFromSample`). The periodic refresh below is kept
 * only as a slow consistency rebuild from the ring buffer, so any
 * accumulated float error or lost state from a stray HMR round gets
 * corrected once every few minutes. No longer time-critical.
 */
const PAIR_FITS_REFRESH_MS = 5 * 60_000;
const PAIR_FITS_INITIAL_DELAY_MS = 5_000;

const globalForBootstrap = globalThis as unknown as {
  __espresenseBootstrapped?: boolean;
};

/**
 * One-shot server-side initialization: read config, connect MQTT, subscribe.
 *
 * Called from `instrumentation.ts` so it runs once per Node.js server start.
 * Guarded via globalThis so HMR re-imports don't re-initialize.
 */
export async function bootstrap(): Promise<void> {
  if (globalForBootstrap.__espresenseBootstrapped) return;
  globalForBootstrap.__espresenseBootstrapped = true;

  const store = getStore();

  try {
    const config = await loadConfig();

    if (!config.mqtt.host) {
      console.warn(
        "[bootstrap] mqtt.host not configured; MQTT integration disabled",
      );
      store.setMqttStatus({
        status: "disconnected",
        error: "mqtt.host not configured",
      });
      return;
    }

    // Populate the shared nodeIndex from config so the locator and node
    // editor share one source of truth for node positions.
    for (const n of config.nodes) {
      if (n.id && n.point) store.nodeIndex.set(n.id, n.point);
    }

    // Apply the user's filtering config. The input-side measurement
    // smoothing always runs (averages RSSI noise per node before
    // solving) and uses smoothing_weight regardless of which output
    // filter is active. The output-side filter is selectable.
    setMeasurementSmoothingWeight(config.filtering.smoothing_weight);
    setPositionSmoothingWeight(config.filtering.smoothing_weight);
    setPositionFilter(config.filtering.position_filter);
    setKalmanProcessNoise(config.filtering.kalman_process_noise);
    setKalmanMeasurementNoise(config.filtering.kalman_measurement_noise);
    console.log(
      `[bootstrap] filter=${config.filtering.position_filter} ` +
        `kalman_process_noise=${config.filtering.kalman_process_noise} ` +
        `kalman_measurement_noise=${config.filtering.kalman_measurement_noise} ` +
        `smoothing_weight=${config.filtering.smoothing_weight}`,
    );

    // Apply auto-apply config. The loop runs only when:
    //   - `optimization.enabled` is true (master switch), AND
    //   - `optimization.optimizer` is `streaming_per_pair` (our
    //     pipeline). The upstream companion's optimizer values
    //     (per_node_absorption, global_absorption, legacy) are not
    //     implemented here, so picking one effectively disables
    //     auto-apply rather than silently doing the wrong thing.
    const isOurOptimizer =
      config.optimization.optimizer === "streaming_per_pair";
    const autoApplyOn = config.optimization.enabled && isOurOptimizer;
    setAutoApplyConfig({
      enabled: autoApplyOn,
      intervalSecs: config.optimization.interval_secs,
      minDelta: config.optimization.min_delta,
    });
    console.log(
      `[bootstrap] auto-apply enabled=${autoApplyOn} ` +
        `(switch=${config.optimization.enabled}, ` +
        `optimizer=${config.optimization.optimizer}) ` +
        `interval=${config.optimization.interval_secs}s ` +
        `min_delta=${config.optimization.min_delta}`,
    );

    // Load persisted state from disk before MQTT starts pushing
    // messages — calibration restored, device biases ready, system
    // continues from where it left off.
    try {
      await loadDevicePins(store);
    } catch (err) {
      console.error("[bootstrap] loadDevicePins failed", err);
    }
    try {
      await loadCalibration(store);
    } catch (err) {
      console.error("[bootstrap] loadCalibration failed", err);
    }
    try {
      await loadAuditState();
    } catch (err) {
      console.error("[bootstrap] loadAuditState failed", err);
    }

    store.setMqttStatus({
      status: "connecting",
      host: config.mqtt.host,
    });

    const client = connectMqtt(config);
    attachHandlers(client, config);
    console.log(
      `[bootstrap] MQTT initialized for ${config.mqtt.host}:${config.mqtt.port}`,
    );

    // Background job: keep the per-pair calibration cache warm so the
    // PathAwareLocator has fresh data at solve time without recomputing
    // fits on every measurement.
    setTimeout(() => {
      try {
        refreshNodePairFits(store);
      } catch (err) {
        console.error("[bootstrap] initial pair-fit refresh failed", err);
      }
    }, PAIR_FITS_INITIAL_DELAY_MS);
    setInterval(() => {
      try {
        refreshNodePairFits(store);
      } catch (err) {
        console.error("[bootstrap] pair-fit refresh failed", err);
      }
    }, PAIR_FITS_REFRESH_MS);

    // Online absorption auto-apply: every interval, push small drift
    // corrections to firmware so calibration converges automatically.
    // First run delayed 1 min so the streaming stats have time to
    // accumulate after a fresh restart. Skipped entirely when the
    // user has disabled it via `optimization.enabled: false`.
    if (isAutoApplyEnabled()) {
      setTimeout(() => {
        runAutoApplyCycle().catch((err) =>
          console.error("[bootstrap] initial auto-apply failed", err),
        );
        setInterval(() => {
          runAutoApplyCycle().catch((err) =>
            console.error("[bootstrap] auto-apply cycle failed", err),
          );
        }, getAutoApplyIntervalMs());
      }, AUTO_APPLY_INITIAL_DELAY_MS);
    } else {
      console.log("[bootstrap] auto-apply disabled by config");
    }

    // Periodic calibration save — every 60 s the streaming stats,
    // sample buffer, and residual aggregators get flushed to disk so
    // a restart picks up where we left off.
    setInterval(() => {
      saveCalibration(store).catch((err) =>
        console.error("[bootstrap] saveCalibration failed", err),
      );
    }, CALIBRATION_SAVE_INTERVAL_MS);

    // Periodic device-pin save — pins accumulate per-(device, node) bias
    // samples from incoming MQTT messages while a pin is active. Without a
    // periodic flush, those samples sit in memory and are only persisted on
    // explicit pin actions (add/delete/activate/deactivate) or graceful
    // shutdown. A hard kill (or SIGTERM the process can't handle in time)
    // would lose all accumulation since the last save event. Same cadence
    // as calibration so the two files stay in rough lockstep.
    setInterval(() => {
      saveDevicePins(store).catch((err) =>
        console.error("[bootstrap] saveDevicePins failed", err),
      );
    }, CALIBRATION_SAVE_INTERVAL_MS);

    // Device away-timeout + retention cleanup — runs every 30 s.
    // Marks devices as away when lastSeen exceeds away_timeout, and
    // removes them from memory when lastSeen exceeds device_retention.
    setInterval(() => {
      runDeviceCleanup(store, config).catch((err) =>
        console.error("[bootstrap] device cleanup failed:", (err as Error).message),
      );
    }, 30_000);

    // Periodic audit + rate-limit save — keeps the auto-apply forensic
    // log durable across restarts and prevents the rate-limit map from
    // being wiped (which would otherwise let auto-apply re-push a node
    // immediately after a deploy).
    setInterval(() => {
      saveAuditState().catch((err) =>
        console.error("[bootstrap] saveAuditState failed", err),
      );
    }, CALIBRATION_SAVE_INTERVAL_MS);

    // Best-effort save on graceful shutdown. Node may not always get
    // here (kill -9, OOM) but normal stop signals do.
    const flushAll = async () => {
      try {
        await Promise.all([
          saveCalibration(store),
          saveDevicePins(store),
          saveAuditState(),
        ]);
        console.log("[bootstrap] flushed state to disk on shutdown");
      } catch (err) {
        console.error("[bootstrap] shutdown flush failed", err);
      }
    };
    let shuttingDown = false;
    const onSignal = (signal: string) => async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[bootstrap] received ${signal}, flushing…`);
      await flushAll();
      process.exit(0);
    };
    process.on("SIGTERM", onSignal("SIGTERM"));
    process.on("SIGINT", onSignal("SIGINT"));
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      console.warn(`[bootstrap] ${err.message}`);
      store.setMqttStatus({ status: "error", error: err.message });
      return;
    }
    console.error("[bootstrap] failed", err);
    store.setMqttStatus({
      status: "error",
      error: (err as Error).message ?? "bootstrap failed",
    });
  }
}
