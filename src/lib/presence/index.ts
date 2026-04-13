"use server";

import type { Config } from "@/lib/config";
import type { PresenceZone } from "@/lib/config/schema";
import { findRoom } from "@/lib/locators/room_aware";
import { publishRaw } from "@/lib/mqtt/client";

// ─── Runtime state ────────────────────────────────────────────────────────────

/**
 * Per-process singleton tracking last-published state per (device, tracker)
 * and which discovery messages have been sent. Keyed the same way as the MQTT
 * client — globalThis so HMR doesn't create duplicate instances.
 */
interface PresenceState {
  /** Last published state string, keyed by `${deviceId}::${trackerId}`. */
  lastState: Map<string, string>;
  /** Discovery messages already sent this session. */
  sentDiscovery: Set<string>;
}

const globalForPresence = globalThis as unknown as {
  __espresensePresenceState?: PresenceState;
};

function state(): PresenceState {
  if (!globalForPresence.__espresensePresenceState) {
    globalForPresence.__espresensePresenceState = {
      lastState: new Map(),
      sentDiscovery: new Set(),
    };
  }
  return globalForPresence.__espresensePresenceState;
}

// ─── Room / floor resolution ──────────────────────────────────────────────────

export interface ResolvedLocation {
  /** Slug id of the matched room, or null if between rooms. */
  roomId: string | null;
  /** Human-readable name of the matched room. */
  roomName: string | null;
  /** Slug id of the matched floor. */
  floorId: string | null;
  /** Human-readable name of the matched floor. */
  floorName: string | null;
}

/**
 * Determine which room and floor a position (x, y, z) falls in by checking
 * each floor's Z bounds then running a 2-D point-in-polygon test against its
 * room polygons. Returns null fields when no match is found.
 */
export function resolveLocation(
  pos: { x: number; y: number; z: number },
  config: Config,
): ResolvedLocation {
  for (const floor of config.floors) {
    // Z-range check — skip floors whose bounds clearly exclude this Z.
    if (floor.bounds) {
      const [, [, , maxZ]] = floor.bounds;
      const [[, , minZ]] = floor.bounds;
      if (pos.z < minZ || pos.z > maxZ) continue;
    }

    const roomId = findRoom(floor.rooms, [pos.x, pos.y]);
    if (roomId != null) {
      // findRoom returns id or name depending on what's set — look up
      // the room to get both fields cleanly.
      const room = floor.rooms.find(
        (r) => r.id === roomId || r.name === roomId,
      );
      return {
        roomId: room?.id ?? roomId,
        roomName: room?.name ?? roomId,
        floorId: floor.id ?? null,
        floorName: floor.name ?? null,
      };
    }
  }
  return { roomId: null, roomName: null, floorId: null, floorName: null };
}

// ─── Zone state computation ───────────────────────────────────────────────────

/**
 * Given a resolved location and a zone definition, compute the state string
 * to publish. For "rooms" zones: the zone label when the device is in one of
 * the listed rooms, otherwise "not_home". For "bayesian": placeholder — will
 * be implemented when the Bayesian layer is added.
 */
function zoneState(
  loc: ResolvedLocation,
  zone: PresenceZone,
): string {
  if (zone.type === "bayesian") {
    // Bayesian tracker — not yet implemented. Falls back to room-level
    // until the probabilistic layer is added.
    return defaultState(loc);
  }

  // type: "rooms" — match against the list of room ids/names.
  if (loc.roomId != null) {
    const inZone = zone.rooms.some(
      (r) =>
        r === loc.roomId ||
        r === loc.roomName ||
        r.toLowerCase() === loc.roomId?.toLowerCase() ||
        r.toLowerCase() === loc.roomName?.toLowerCase(),
    );
    if (inZone) return zone.label ?? zone.id;
  }
  return "not_home";
}

/**
 * State string for the default (1:1 room-level) tracker: room id → floor id
 * → "not_home". Mirrors the upstream companion's behavior.
 */
function defaultState(loc: ResolvedLocation): string {
  if (loc.roomId) return loc.roomId;
  if (loc.floorId) return loc.floorId;
  return "not_home";
}

// ─── MQTT topic helpers ───────────────────────────────────────────────────────

/**
 * All MQTT topics are under `espresense/hub/` to avoid colliding with the
 * upstream companion's `espresense/companion/` namespace. Running both
 * side-by-side is safe.
 */
function stateTopic(deviceId: string, zoneId?: string): string {
  return zoneId
    ? `espresense/hub/${deviceId}/${zoneId}`
    : `espresense/hub/${deviceId}`;
}

function attributesTopic(deviceId: string): string {
  // All trackers for a device share one attributes topic — they all represent
  // the same physical position, just presented at different granularities.
  return `espresense/hub/${deviceId}/attributes`;
}

function discoveryTopic(
  discoveryPrefix: string,
  deviceId: string,
  zoneId?: string,
): string {
  const entityId = zoneId
    ? `espresense-hub-${deviceId}-${zoneId}`
    : `espresense-hub-${deviceId}`;
  return `${discoveryPrefix}/device_tracker/${entityId}/config`;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

async function ensureDiscovery(
  deviceId: string,
  deviceName: string,
  discoveryPrefix: string,
  zoneId?: string,
  zoneLabel?: string,
): Promise<void> {
  const key = `${deviceId}::${zoneId ?? "__default__"}`;
  const s = state();
  if (s.sentDiscovery.has(key)) return;
  s.sentDiscovery.add(key);

  // HA forms the entity_id as "{device_name}_{entity_name}" when a device
  // block is present, so the entity name should describe the tracker type,
  // not repeat the device name. Default tracker = "Location";
  // zone trackers = the zone label (e.g. "Master Suite").
  const name = zoneLabel ?? (zoneId ? zoneId : "Location");

  const uniqueId = zoneId
    ? `espresense-hub-${deviceId}-${zoneId}`
    : `espresense-hub-${deviceId}`;

  const payload = {
    name,
    unique_id: uniqueId,
    state_topic: stateTopic(deviceId, zoneId),
    json_attributes_topic: attributesTopic(deviceId),
    status_topic: "espresense/hub/status",
    source_type: "bluetooth",
    device: {
      name: deviceName,
      manufacturer: "ESPresense",
      model: "Hub",
      identifiers: [`espresense-hub-${deviceId}`],
    },
    origin: { name: "ESPresense Hub" },
  };

  await publishRaw(
    discoveryTopic(discoveryPrefix, deviceId, zoneId),
    JSON.stringify(payload),
    { retain: true, qos: 1 },
  );
}

// ─── Main publish entry point ─────────────────────────────────────────────────

export interface PresencePublishInput {
  deviceId: string;
  deviceName: string;
  position: { x: number; y: number; z: number; confidence: number; fixes: number; algorithm: string };
  config: Config;
}

/**
 * Publish HA MQTT presence for a device whose position just updated.
 *
 * - Sends a retained discovery message the first time each (device, tracker)
 *   is seen — HA picks it up and creates the entity automatically.
 * - Publishes the state string (room id / zone label / "not_home") only when
 *   it has changed — avoids unnecessary MQTT churn.
 * - Always publishes the attributes payload with full x/y/z/confidence/room
 *   so HA has the latest position even when the room didn't change.
 *
 * Called fire-and-forget from the MQTT handler hot path — errors are logged
 * but not propagated.
 */
export async function publishPresence({
  deviceId,
  deviceName,
  position,
  config,
}: PresencePublishInput): Promise<void> {
  const discoveryPrefix = config.mqtt.discovery_topic ?? "homeassistant";
  const loc = resolveLocation(position, config);
  const s = state();

  // ── Attributes (always publish — position may have moved within a room) ──
  const attrs = {
    source_type: "espresense",
    x: position.x,
    y: position.y,
    z: position.z,
    confidence: Math.round(position.confidence * 100),
    fixes: position.fixes,
    algorithm: position.algorithm,
    room: loc.roomName,
    floor: loc.floorName,
    last_seen: new Date().toISOString(),
  };
  await publishRaw(attributesTopic(deviceId), JSON.stringify(attrs), {
    retain: true,
    qos: 1,
  });

  // ── Default tracker (1:1 room → floor → not_home) ────────────────────────
  const defState = defaultState(loc);
  const defKey = `${deviceId}::__default__`;
  if (s.lastState.get(defKey) !== defState) {
    s.lastState.set(defKey, defState);
    await ensureDiscovery(deviceId, deviceName, discoveryPrefix);
    await publishRaw(stateTopic(deviceId), defState, { retain: false, qos: 1 });
  } else {
    // Discovery may not have been sent yet even if state hasn't changed
    // (e.g. after a server restart). Ensure it's out.
    await ensureDiscovery(deviceId, deviceName, discoveryPrefix);
  }

  // ── Zone trackers ─────────────────────────────────────────────────────────
  for (const zone of config.presence.zones) {
    const zState = zoneState(loc, zone);
    const zKey = `${deviceId}::${zone.id}`;
    await ensureDiscovery(
      deviceId,
      deviceName,
      discoveryPrefix,
      zone.id,
      zone.label,
    );
    if (s.lastState.get(zKey) !== zState) {
      s.lastState.set(zKey, zState);
      await publishRaw(stateTopic(deviceId, zone.id), zState, {
        retain: false,
        qos: 1,
      });
    }
  }
}
