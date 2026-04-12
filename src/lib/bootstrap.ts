import {
  AUTO_APPLY_INITIAL_DELAY_MS,
  AUTO_APPLY_INTERVAL_MS,
  runAutoApplyCycle,
} from "@/lib/calibration/auto_apply";
import { refreshNodePairFits } from "@/lib/calibration/autofit";
import {
  CALIBRATION_SAVE_INTERVAL_MS,
  loadCalibration,
  saveCalibration,
} from "@/lib/state/calibration_persistence";
import { loadConfig, ConfigNotFoundError } from "@/lib/config";
import { connectMqtt } from "@/lib/mqtt/client";
import { attachHandlers } from "@/lib/mqtt/handler";
import { loadDevicePins, saveDevicePins } from "@/lib/state/device_persistence";
import { getStore } from "@/lib/state/store";

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

    // Online absorption auto-apply: every 5 min, push small drift
    // corrections to firmware so calibration converges automatically.
    // First run delayed 1 min so the streaming stats have time to
    // accumulate after a fresh restart.
    setTimeout(() => {
      runAutoApplyCycle().catch((err) =>
        console.error("[bootstrap] initial auto-apply failed", err),
      );
      setInterval(() => {
        runAutoApplyCycle().catch((err) =>
          console.error("[bootstrap] auto-apply cycle failed", err),
        );
      }, AUTO_APPLY_INTERVAL_MS);
    }, AUTO_APPLY_INITIAL_DELAY_MS);

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

    // Best-effort save on graceful shutdown. Node may not always get
    // here (kill -9, OOM) but normal stop signals do.
    const flushAll = async () => {
      try {
        await Promise.all([saveCalibration(store), saveDevicePins(store)]);
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
