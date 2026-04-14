import type { MqttClient } from "mqtt";
import { updatePairFitFromSample } from "@/lib/calibration/autofit";
import {
  accumulatePinSample,
  deactivatePin,
  getActivePin,
} from "@/lib/calibration/device_cal";
import { getCurrentConfig } from "@/lib/config/current";
import { buildLocator, computeDevicePosition } from "@/lib/locators";
import { leaveOneOutResiduals } from "@/lib/locators/calibration";
import { publishPresence } from "@/lib/presence";
import {
  getStore,
  recordGroundTruthResidual,
  recordGroundTruthSample,
  recordNodeResidual,
  recordNodeSetting,
} from "@/lib/state/store";

/**
 * Maximum distance (meters, 2D) between the *raw* locator output and
 * the active pin's anchor before we consider the device to have
 * walked away.
 *
 * Generous (8 m) because the raw locator output during pin learning
 * is intentionally noisy — bias hasn't converged yet, and the whole
 * point of the pin is to absorb that noise into accumulated bias.
 * 8 m is comfortably bigger than typical room-scale uncertainty plus
 * pin-placement slop, but small enough to detect "user crossed the
 * house with the device on them".
 *
 * NB: this checks the raw locator output, NOT the Kalman state. The
 * Kalman state is locked to the pin while active (see
 * `Store.setDevicePosition`), so it would always pass the test.
 */
const PIN_FAR_AWAY_THRESHOLD_M = 8;

/**
 * Is the raw locator output close enough to the pin's anchor to
 * credibly be the source of these samples? Compares the locator
 * result (pre-Kalman, pre-pin-lock) to the pin's stored position
 * in 2D.
 *
 * Returns true if there's no locator result yet — we trust the
 * user's pin placement until we have evidence otherwise.
 */
function isNearPin(
  rawPosition: { x: number; y: number } | null | undefined,
  pin: { position: readonly [number, number, number] },
): boolean {
  if (!rawPosition) return true;
  const dx = rawPosition.x - pin.position[0];
  const dy = rawPosition.y - pin.position[1];
  return Math.sqrt(dx * dx + dy * dy) <= PIN_FAR_AWAY_THRESHOLD_M;
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
 *
 * Reads `config` fresh from `getCurrentConfig()` on each message rather than
 * closing over a captured value, so changes saved via the Settings UI take
 * effect immediately without a service restart.
 */
export function attachHandlers(client: MqttClient): void {
  const store = getStore();
  // Locator/alt-locators are built once — their configuration comes from
  // config at bootstrap time. Locator config isn't actually read from
  // `config.locators` at runtime (that section is a passthrough), so
  // rebuilding on save wouldn't do anything useful.
  const bootstrapConfig = getCurrentConfig();
  const { active: locator, alternatives: altLocators } = buildLocator(bootstrapConfig);

  client.on("connect", () => {
    const config = getCurrentConfig();
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
    // Read config fresh per message so Settings UI saves take effect on the
    // next inbound message rather than waiting for a service restart.
    const config = getCurrentConfig();
    const staleAfterMs = config.timeout * 1000;

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

    if (match.kind === "companion-attributes") {
      // Position published by upstream ESPresense-companion (when
      // running alongside us on the same broker). We just record it
      // — it doesn't drive any of our solving, just gets surfaced as
      // a compare-mode ghost marker. Tolerant parser: companion's
      // payload format has varied across versions.
      const a = json as Record<string, unknown>;
      const x = typeof a.x === "number" ? a.x : null;
      const y = typeof a.y === "number" ? a.y : null;
      if (x === null || y === null) return;
      const z = typeof a.z === "number" ? a.z : undefined;
      // Companion confidence is 0–100; normalize to our 0–1 scale.
      const confRaw = typeof a.confidence === "number" ? a.confidence : 0;
      const confidence = Math.max(0, Math.min(1, confRaw / 100));
      const fixes = typeof a.fixes === "number" ? Math.round(a.fixes) : 0;
      const scenario =
        typeof a.best_scenario === "string" ? a.best_scenario : undefined;
      let lastSeen = Date.now();
      if (typeof a.last_seen === "string") {
        const parsed = Date.parse(a.last_seen);
        if (Number.isFinite(parsed)) lastSeen = parsed;
      }
      // Skip stale retained messages (more than a day old). Companion
      // retains positions for devices it tracked weeks ago; we don't
      // want those polluting the live compare view.
      if (Date.now() - lastSeen > 24 * 60 * 60 * 1000) return;
      store.setDeviceUpstreamPosition(match.deviceId, {
        x,
        y,
        z,
        confidence,
        fixes,
        scenario,
        lastSeen,
        receivedAt: Date.now(),
      });
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

      // Recompute position from the latest set of fixes. Cheap for typical
      // home setups (a dozen nodes) so we just do it inline on every message.
      const result = computeDevicePosition(
        device,
        store.nodeIndex,
        locator,
        staleAfterMs,
      );

      // Pin gating happens AFTER computeDevicePosition (so we have the
      // raw locator output to compare against the pin) but BEFORE
      // setDevicePosition (which locks position to the pin if active,
      // making the post-lock position useless for proximity checks).
      const activePin = getActivePin(store, device.id);
      if (activePin && normalized.distance != null) {
        if (isNearPin(result, activePin)) {
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
          // Raw locator clearly puts the device elsewhere — user has
          // walked away with it. Deactivate.
          deactivatePin(store, device.id, activePin.timestamp);
          console.log(
            `[pin] auto-deactivated ${device.id}'s active pin (left proximity)`,
          );
        }
      }
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

        // Publish HA MQTT presence — fire and forget so MQTT latency
        // doesn't block the solve loop. Skipped when publish_presence is off
        // (local dev / dry-run mode).
        if (config.publish_presence) {
          publishPresence({
            deviceId: device.id,
            deviceName: device.name ?? device.id,
            position: result,
            config,
          }).catch((err) => {
            console.error("[presence] publish failed:", (err as Error).message);
          });
        }

        // Update per-locator comparison stats: distance from each
        // alternative's output to ours (after our active position has
        // been written). Cheap — a sqrt per alt.
        const stored = store.devices.get(device.id);
        if (stored?.position) {
          for (const alt of alternatives) {
            const dx = alt.x - stored.position.x;
            const dy = alt.y - stored.position.y;
            store.recordLocatorComparison(
              stored,
              alt.algorithm,
              Math.sqrt(dx * dx + dy * dy),
            );
          }
        }
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
