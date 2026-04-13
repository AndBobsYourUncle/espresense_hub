import type { MqttClient } from "mqtt";
import { updatePairFitFromSample } from "@/lib/calibration/autofit";
import {
  accumulatePinSample,
  deactivatePin,
  getActivePin,
} from "@/lib/calibration/device_cal";
import type { Config } from "@/lib/config";
import { buildLocator, computeDevicePosition } from "@/lib/locators";
import { leaveOneOutResiduals } from "@/lib/locators/calibration";
import {
  getStore,
  recordGroundTruthResidual,
  recordGroundTruthSample,
  recordNodeResidual,
  recordNodeSetting,
} from "@/lib/state/store";

/**
 * Speed (m/s) below which the Kalman filter's velocity estimate is
 * considered "stationary". The filter typically reads ~0.02–0.05 m/s
 * for a truly motionless device and 0.5+ m/s for a walking person,
 * so 0.15 m/s is well inside the safe gap.
 */
const STATIONARY_SPEED_THRESHOLD = 0.15;

/**
 * Fallback per-node distance-variance threshold (m²), used only when
 * Kalman state isn't available yet (first few seconds after the
 * device shows up). 3.0 m² ≈ 1.7 m std dev — generous enough to
 * tolerate body-shadow micro-jitter from a stationary worn wearable
 * but small enough to catch actual walking.
 */
const STATIONARY_VARIANCE_THRESHOLD = 3.0;

/**
 * Decide whether the device is currently stationary near its active
 * pin (if any). Two signals, in priority order:
 *
 *   1. **Kalman velocity** — the filtered velocity component is the
 *      cleanest signal we have. If |v| < threshold, the device isn't
 *      moving regardless of how noisy individual node distances look.
 *      RSSI variance from body-shadow micro-movements doesn't fool it.
 *   2. **Per-node distance variance** — fallback for the brief window
 *      after a device first appears, before the Kalman has converged.
 *      Uses a generous threshold (3.0 m²) since stationary worn
 *      wearables routinely generate 1–2 m of distance jitter per node
 *      that has nothing to do with motion.
 */
function isDeviceStationary(
  device: { kalman?: { x: number[] }; measurements: Map<string, { distanceVariance?: number; lastSeen: number }> },
  cutoffMs: number,
): boolean {
  // Primary: Kalman speed. State [x, y, z, vx, vy, vz] — speed is the
  // 3D magnitude of the velocity components.
  if (device.kalman?.x && device.kalman.x.length >= 6) {
    const vx = device.kalman.x[3];
    const vy = device.kalman.x[4];
    const vz = device.kalman.x[5];
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    return speed < STATIONARY_SPEED_THRESHOLD;
  }

  // Fallback: variance, with a more lenient threshold than before.
  let count = 0;
  let sumVar = 0;
  for (const m of device.measurements.values()) {
    if (m.lastSeen < cutoffMs) continue;
    if (m.distanceVariance == null) continue;
    sumVar += m.distanceVariance;
    count += 1;
  }
  if (count < 3) return false;
  const meanVar = sumVar / count;
  return meanVar < STATIONARY_VARIANCE_THRESHOLD;
}
import {
  DeviceMessageSchema,
  NodeTelemetrySchema,
  normalizeDeviceMessage,
} from "./messages";
import { parseTopic, SUBSCRIPTIONS } from "./topics";
import { isDeviceTracked } from "./filter";

/**
 * Wire the MQTT client to the store. Subscribes to ESPresense topics and
 * routes each inbound message through the appropriate parser + filter.
 */
export function attachHandlers(client: MqttClient, config: Config): void {
  const store = getStore();
  const { active: locator, alternatives: altLocators } = buildLocator(config);
  // Read positions from the shared nodeIndex on every solve so live edits
  // from the node editor are picked up immediately.
  const staleAfterMs = config.timeout * 1000;

  client.on("connect", () => {
    store.setMqttStatus({
      status: "connected",
      host: config.mqtt.host,
      lastConnectedAt: Date.now(),
      error: undefined,
    });
    console.log(`[mqtt] connected to ${config.mqtt.host}:${config.mqtt.port}`);

    client.subscribe([...SUBSCRIPTIONS], (err, granted) => {
      if (err) {
        console.error("[mqtt] subscribe failed", err.message);
        return;
      }
      console.log(
        `[mqtt] subscribed: ${granted?.map((g) => g.topic).join(", ")}`,
      );
    });
  });

  client.on("reconnect", () => {
    store.setMqttStatus({ status: "connecting" });
  });

  client.on("offline", () => {
    store.setMqttStatus({ status: "disconnected" });
  });

  client.on("error", (err) => {
    store.setMqttStatus({ status: "error", error: err.message });
    console.error("[mqtt] error", err.message);
  });

  client.on("message", (topic, payload) => {
    store.noteMqttMessage();

    const match = parseTopic(topic);
    if (!match) return;

    if (match.kind === "node-status") {
      // Plain-text payload.
      store.updateNodeStatus(match.nodeId, payload.toString().trim());
      return;
    }

    if (match.kind === "node-setting") {
      // Per-node retained settings published by ESPresense firmware. Plain
      // text values (numbers, booleans, etc.) — kept as-is.
      recordNodeSetting(
        store,
        match.nodeId,
        match.key,
        payload.toString().trim(),
      );
      return;
    }

    // All other topics are JSON.
    let json: unknown;
    try {
      json = JSON.parse(payload.toString());
    } catch {
      return;
    }

    if (match.kind === "node-telemetry") {
      const parsed = NodeTelemetrySchema.safeParse(json);
      if (parsed.success) {
        store.updateNodeTelemetry(match.nodeId, parsed.data);
      }
      return;
    }

    if (match.kind === "device-config") {
      // Per-device config from `espresense/settings/{originalId}/config`.
      // The topic's deviceId is the original ID (IRK); the payload's `id`
      // field is the user-assigned alias. Store both so we can look up
      // the original ID when we need to publish back.
      const cfg = json as Record<string, unknown>;
      const settings = {
        originalId: match.deviceId,
        id: typeof cfg.id === "string" ? cfg.id : undefined,
        name: typeof cfg.name === "string" ? cfg.name : undefined,
        refRssi:
          typeof cfg["rssi@1m"] === "number" ? cfg["rssi@1m"] : undefined,
      };
      store.deviceSettingsById.set(match.deviceId, settings);
      if (settings.id) {
        store.deviceSettingsByAlias.set(settings.id, settings);
      }
      return;
    }

    if (match.kind === "device-message") {
      const parsed = DeviceMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const normalized = normalizeDeviceMessage(parsed.data);

      // Ground-truth calibration: when one node observes another node's
      // BLE broadcast, both endpoints have known config positions, so the
      // true distance is exact. Bypass the user's exclude filter for these
      // — the measurement counts for calibration even if the user doesn't
      // want to track nodes as devices in their device list.
      if (normalized.distance != null) {
        const colonIdx = match.deviceId.indexOf(":");
        if (colonIdx > 0) {
          const targetId = match.deviceId.slice(colonIdx + 1);
          if (targetId !== match.nodeId) {
            const targetPoint = store.nodeIndex.get(targetId);
            const sourcePoint = store.nodeIndex.get(match.nodeId);
            if (targetPoint && sourcePoint) {
              const dx = sourcePoint[0] - targetPoint[0];
              const dy = sourcePoint[1] - targetPoint[1];
              const dz = sourcePoint[2] - targetPoint[2];
              const trueDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              recordGroundTruthResidual(
                store,
                match.nodeId,
                normalized.distance - trueDist,
                {
                  deviceId: match.deviceId,
                  measured: normalized.distance,
                  trueDist,
                },
              );
              // Also record the raw sample so the auto-fit code has access
              // to individual data points (needed for the log-log
              // regression). Same defensive parse as in path_aware:
              // reject 0 / negative / non-numeric, default to 2.7 —
              // otherwise samples recorded while a node had no
              // absorption setting pollute the regression with
              // `y = 0 × log(d_measured) = 0`, dragging the fit toward
              // a flat line.
              const absRaw = store.nodeSettings
                .get(match.nodeId)
                ?.get("absorption");
              const parsedAbs = absRaw != null ? parseFloat(absRaw) : NaN;
              const absorptionAtTime =
                Number.isFinite(parsedAbs) && parsedAbs > 0.1 ? parsedAbs : 2.7;
              const gtSample = {
                transmitterId: targetId,
                measured: normalized.distance,
                trueDist,
                absorptionAtTime,
                timestamp: Date.now(),
              };
              recordGroundTruthSample(store, match.nodeId, gtSample);
              // Online per-pair fit update: propagate this single
              // sample into the streaming sufficient statistics so
              // PathAware's correction reflects it within one MQTT
              // message round-trip, not the next 30 s batch cycle.
              updatePairFitFromSample(store, match.nodeId, gtSample);
              // Don't fall through to device tracking — the user has these
              // excluded for a reason (they're not real devices to track).
              return;
            }
          }
        }
      }

      if (
        !isDeviceTracked(
          match.deviceId,
          normalized.name,
          config.devices,
          config.exclude_devices,
        )
      ) {
        return;
      }
      const device = store.updateDeviceMeasurement(
        match.deviceId,
        match.nodeId,
        normalized,
      );

      // If the user has marked a pin "active" for this device AND the
      // device is currently stationary, accumulate this measurement
      // into the pin's per-node bias statistics. Over time this
      // produces a much tighter bias estimate than any single snapshot.
      const activePin = getActivePin(store, device.id);
      if (activePin && normalized.distance != null) {
        const cutoff = Date.now() - staleAfterMs;
        if (isDeviceStationary(device, cutoff)) {
          accumulatePinSample(
            store,
            activePin,
            match.nodeId,
            // Use the smoothed value so we get the EMA's noise reduction
            // baked in, not raw single-sample variance.
            device.measurements.get(match.nodeId)?.smoothedDistance ??
              normalized.distance,
          );
        } else {
          // Motion detected — auto-deactivate the pin. The user can
          // re-click the pin (or place a new one) when stationary again.
          deactivatePin(store, device.id, activePin.timestamp);
          console.log(
            `[pin] auto-deactivated ${device.id}'s active pin (motion detected)`,
          );
        }
      }

      // Recompute position from the latest set of fixes. Cheap for typical
      // home setups (a dozen nodes) so we just do it inline on every message.
      const result = computeDevicePosition(
        device,
        store.nodeIndex,
        locator,
        staleAfterMs,
      );
      if (result) {
        // Compute every alternative locator's result so the comparison
        // view can show all of them as ghost markers. Each alt is a
        // single-pass solve over the same fixes — cheap.
        const alternatives = [];
        for (const alt of altLocators) {
          const r = computeDevicePosition(
            device,
            store.nodeIndex,
            alt,
            staleAfterMs,
          );
          if (r) {
            alternatives.push({
              x: r.x,
              y: r.y,
              z: r.z,
              algorithm: r.algorithm,
            });
          }
        }
        store.setDevicePosition(device.id, {
          ...result,
          computedAt: Date.now(),
          alternatives,
        });
      }

      // Calibration diagnostic: leave-one-out residual per reporting node.
      // Cheap (12² ≈ 144 ops per device update for typical setups) and
      // surfaces per-node distance bias on the calibration page.
      const residuals = leaveOneOutResiduals(
        device,
        store.nodeIndex,
        locator,
        staleAfterMs,
      );
      for (const [nodeId, residual] of residuals) {
        recordNodeResidual(store, nodeId, residual);
      }
    }
  });
}
