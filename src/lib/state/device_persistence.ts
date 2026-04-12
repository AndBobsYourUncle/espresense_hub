import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "@/lib/config/load";
import type { DeviceGroundTruthPin, Store } from "@/lib/state/store";

/**
 * Persist per-device ground-truth pin data across app restarts.
 *
 * Pins capture (device, position) ground truth that we use to learn
 * how each node "sees" each device — including device-specific
 * antenna/body biases that node-to-node calibration can't measure.
 *
 * Stored alongside config.yaml as `devices.json`. Only pins are
 * persisted — derived data (per-node biases, spatial interpolation)
 * is rebuilt from pins at runtime, so the file stays small and
 * forward-compatible.
 */

const DEVICES_FILENAME = "devices.json";

interface DeviceFileV1 {
  version: 1;
  devices: Record<
    string,
    {
      lastSeen: number;
      pins: Array<{
        position: [number, number, number];
        timestamp: number;
        measurements: Record<string, number>;
        /** v1.1: per-node accumulated bias stats (optional for back-compat). */
        nodeBias?: Record<
          string,
          {
            sampleCount: number;
            sumBias: number;
            sumBias2: number;
            lastUpdateMs: number;
          }
        >;
      }>;
    }
  >;
}

function devicesPath(): string {
  return path.join(path.dirname(resolveConfigPath()), DEVICES_FILENAME);
}

/**
 * Load persisted device pins into the store. Called on bootstrap.
 * Silently no-ops if the file doesn't exist (first run).
 */
export async function loadDevicePins(store: Store): Promise<void> {
  const filePath = devicesPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[device-persist] no existing devices file at ${filePath}`);
      return;
    }
    throw err;
  }

  let parsed: DeviceFileV1;
  try {
    parsed = JSON.parse(raw) as DeviceFileV1;
  } catch (err) {
    console.error(
      `[device-persist] failed to parse ${filePath}:`,
      (err as Error).message,
    );
    return;
  }

  if (parsed.version !== 1 || !parsed.devices) {
    console.warn(`[device-persist] ${filePath} has unknown version, ignoring`);
    return;
  }

  let totalPins = 0;
  for (const [deviceId, data] of Object.entries(parsed.devices)) {
    if (!Array.isArray(data.pins)) continue;
    for (const p of data.pins) {
      if (
        !Array.isArray(p.position) ||
        p.position.length !== 3 ||
        typeof p.timestamp !== "number" ||
        !p.measurements
      ) {
        continue;
      }
      const nodeBias = new Map<string, import("@/lib/state/store").PinNodeBiasStats>();
      if (p.nodeBias) {
        for (const [nodeId, s] of Object.entries(p.nodeBias)) {
          if (
            typeof s.sampleCount === "number" &&
            typeof s.sumBias === "number" &&
            typeof s.sumBias2 === "number"
          ) {
            nodeBias.set(nodeId, {
              sampleCount: s.sampleCount,
              sumBias: s.sumBias,
              sumBias2: s.sumBias2,
              lastUpdateMs: s.lastUpdateMs ?? 0,
            });
          }
        }
      }
      const pin: DeviceGroundTruthPin = {
        deviceId,
        position: p.position as [number, number, number],
        measurements: new Map(Object.entries(p.measurements)),
        nodeBias,
        timestamp: p.timestamp,
        // Pins always load as inactive — the user must re-click to
        // activate accumulation after a restart, since we can't
        // reliably know if the device is still there.
        activeUntilMs: 0,
      };
      let existing = store.devicePins.get(deviceId);
      if (!existing) {
        existing = [];
        store.devicePins.set(deviceId, existing);
      }
      existing.push(pin);
      totalPins += 1;
    }
  }

  console.log(
    `[device-persist] loaded ${totalPins} pins across ${Object.keys(parsed.devices).length} devices from ${filePath}`,
  );
}

/**
 * Save the current device pin state to disk. Called after every pin
 * mutation (add/delete). Atomic: writes to .tmp then renames.
 */
export async function saveDevicePins(store: Store): Promise<void> {
  const filePath = devicesPath();
  const data: DeviceFileV1 = { version: 1, devices: {} };

  for (const [deviceId, pins] of store.devicePins) {
    if (pins.length === 0) continue;
    data.devices[deviceId] = {
      lastSeen: Math.max(...pins.map((p) => p.timestamp)),
      pins: pins.map((p) => {
        const measurements: Record<string, number> = {};
        for (const [k, v] of p.measurements) measurements[k] = v;
        const nodeBias: Record<string, {
          sampleCount: number;
          sumBias: number;
          sumBias2: number;
          lastUpdateMs: number;
        }> = {};
        for (const [k, v] of p.nodeBias) {
          nodeBias[k] = {
            sampleCount: v.sampleCount,
            sumBias: v.sumBias,
            sumBias2: v.sumBias2,
            lastUpdateMs: v.lastUpdateMs,
          };
        }
        return {
          position: [p.position[0], p.position[1], p.position[2]],
          timestamp: p.timestamp,
          measurements,
          nodeBias,
        };
      }),
    };
  }

  const tmp = `${filePath}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    console.error(
      `[device-persist] failed to save ${filePath}:`,
      (err as Error).message,
    );
  }
}
