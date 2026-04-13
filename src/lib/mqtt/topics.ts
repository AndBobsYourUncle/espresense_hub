/**
 * ESPresense topic parsing.
 *
 * Upstream topic structure (all under the `espresense/` prefix):
 *   - espresense/rooms/{nodeId}/telemetry         → JSON telemetry blob
 *   - espresense/rooms/{nodeId}/status            → plain text ("online"/"offline")
 *   - espresense/rooms/{nodeId}/{setting}         → retained per-node setting (e.g. absorption, rx_adj_rssi)
 *   - espresense/rooms/{nodeId}/{setting}/set     → write-only, used by callers to push values (ignored on receive)
 *   - espresense/devices/{deviceId}/{nodeId}      → per-measurement JSON blob
 *   - espresense/settings/{deviceId}/config       → retained per-device config (rssi@1m, name, anchor, etc.)
 */

export const TOPIC_PREFIX = "espresense";

export type ParsedTopic =
  | { kind: "node-telemetry"; nodeId: string }
  | { kind: "node-status"; nodeId: string }
  | { kind: "node-setting"; nodeId: string; key: string }
  | { kind: "device-message"; deviceId: string; nodeId: string }
  | { kind: "device-config"; deviceId: string }
  | { kind: "companion-attributes"; deviceId: string };

export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/");
  if (parts.length < 3 || parts[0] !== TOPIC_PREFIX) return null;

  if (parts[1] === "rooms") {
    const nodeId = parts[2];
    if (!nodeId) return null;

    // espresense/rooms/{nodeId}/{leaf} — telemetry, status, or a setting.
    if (parts.length === 4) {
      const leaf = parts[3];
      if (leaf === "telemetry") return { kind: "node-telemetry", nodeId };
      if (leaf === "status") return { kind: "node-status", nodeId };
      return { kind: "node-setting", nodeId, key: leaf };
    }

    // Ignore deeper paths (e.g. .../absorption/set is the write-side mirror).
    return null;
  }

  if (parts[1] === "devices" && parts.length === 4) {
    const deviceId = parts[2];
    const nodeId = parts[3];
    if (!deviceId || !nodeId) return null;
    return { kind: "device-message", deviceId, nodeId };
  }

  // espresense/settings/{deviceId}/config — per-device config (retained).
  // The deviceId here is the original ID (often an IRK), not the alias.
  if (
    parts[1] === "settings" &&
    parts.length === 4 &&
    parts[3] === "config"
  ) {
    const deviceId = parts[2];
    if (!deviceId) return null;
    return { kind: "device-config", deviceId };
  }

  // espresense/companion/{deviceId}/attributes — published by the
  // upstream ESPresense-companion app (when running alongside us). Lets
  // the compare-mode UI render upstream's *live* position estimate as a
  // ghost marker for direct apples-to-apples comparison on the same
  // MQTT data. We ignore the leaf-only `espresense/companion/{deviceId}`
  // (room name) — the attributes payload contains everything we need.
  if (
    parts[1] === "companion" &&
    parts.length === 4 &&
    parts[3] === "attributes"
  ) {
    const deviceId = parts[2];
    if (!deviceId) return null;
    return { kind: "companion-attributes", deviceId };
  }

  return null;
}

/**
 * Topic filters we subscribe to at startup.
 *
 * `rooms/+/+` is broad enough to capture telemetry, status, and every
 * per-node setting (absorption, rx_adj_rssi, tx_ref_rssi, etc.) that the
 * node retains. The handler dispatches by parsed kind.
 */
export const SUBSCRIPTIONS = [
  `${TOPIC_PREFIX}/rooms/+/+`,
  `${TOPIC_PREFIX}/devices/+/+`,
  `${TOPIC_PREFIX}/settings/+/config`,
  // Optional — only sees traffic when upstream-companion is running on
  // the same broker. Payloads end up as compare-mode ghost markers.
  `${TOPIC_PREFIX}/companion/+/attributes`,
] as const;
