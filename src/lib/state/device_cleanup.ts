import type { Config } from "@/lib/config";
import { publishDeviceAway } from "@/lib/presence";
import type { Store } from "@/lib/state/store";

/**
 * Parse a duration string into milliseconds.
 *   "30d"  → 30 days
 *   "12h"  → 12 hours
 *   "2w"   → 2 weeks
 *   "30m"  → 30 minutes
 *   "3600" → 3600 seconds (bare number)
 */
export function parseDurationMs(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([dhwm]?)$/i.exec(s.trim());
  if (!m) return 30 * 24 * 60 * 60 * 1000; // unrecognised → 30 d
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "m": return n * 60 * 1000;
    default:  return n * 1000; // bare number = seconds
  }
}

/**
 * One cleanup pass over all known devices:
 *
 * 1. Device retention: if `lastSeen` is older than `device_retention`,
 *    delete it from the store entirely.
 * 2. Away timeout: if `lastSeen` is older than `away_timeout` seconds and
 *    the device still has a position, clear the position and publish
 *    "not_home" to all HA presence trackers.
 *
 * Called on a ~30 s interval from bootstrap. Fire-and-forget errors are
 * logged but don't crash the loop.
 */
export async function runDeviceCleanup(
  store: Store,
  config: Config,
): Promise<void> {
  const now = Date.now();
  const awayMs = config.away_timeout * 1000;
  const retentionMs = parseDurationMs(config.device_retention);
  const toDelete: string[] = [];

  for (const [deviceId, device] of store.devices) {
    const age = now - device.lastSeen;

    if (age > retentionMs) {
      toDelete.push(deviceId);
      continue;
    }

    if (age > awayMs && device.position != null) {
      store.setDevicePosition(deviceId, null);
      await publishDeviceAway({
        deviceId,
        deviceName: device.name ?? deviceId,
        config,
      }).catch((err) => {
        console.error(
          `[cleanup] away publish failed for ${deviceId}:`,
          (err as Error).message,
        );
      });
    }
  }

  for (const id of toDelete) {
    store.devices.delete(id);
    console.log(`[cleanup] removed expired device: ${id}`);
  }
}
