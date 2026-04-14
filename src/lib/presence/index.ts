import type { Config } from "@/lib/config";
import type { PresenceZone } from "@/lib/config/schema";
import { findRoom } from "@/lib/locators/room_aware";
import { publishRaw } from "@/lib/mqtt/client";
import { areAdjacent, getRoomGraph } from "./room_graph";

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
  /**
   * Per-device room hysteresis. `committed` is the currently-published
   * location for the device; `candidate` is a pending new location we've
   * started seeing but haven't yet committed to (must accumulate
   * `room_stability_ms` worth of consistent readings before promotion).
   */
  roomHysteresis: Map<
    string,
    {
      committed: ResolvedLocation;
      candidate: { loc: ResolvedLocation; since: number } | null;
    }
  >;
}

const globalForPresence = globalThis as unknown as {
  __espresensePresenceState?: PresenceState;
};

function state(): PresenceState {
  if (!globalForPresence.__espresensePresenceState) {
    globalForPresence.__espresensePresenceState = {
      lastState: new Map(),
      sentDiscovery: new Set(),
      roomHysteresis: new Map(),
    };
  }
  // Back-compat: older singletons may exist without the hysteresis map.
  if (!globalForPresence.__espresensePresenceState.roomHysteresis) {
    globalForPresence.__espresensePresenceState.roomHysteresis = new Map();
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
  // The first floor whose Z-bounds pass is kept as a fallback so that a device
  // detected between rooms still publishes the floor name instead of "not_home".
  let floorFallback: { floorId: string | null; floorName: string | null } | null = null;

  for (const floor of config.floors) {
    // Z-range check — skip floors whose bounds clearly exclude this Z.
    if (floor.bounds) {
      const [, [, , maxZ]] = floor.bounds;
      const [[, , minZ]] = floor.bounds;
      if (pos.z < minZ || pos.z > maxZ) continue;
    }

    // This floor's Z-range passed — record it as a fallback.
    if (!floorFallback) {
      floorFallback = { floorId: floor.id ?? null, floorName: floor.name ?? null };
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

  // No room matched — but if a floor's Z-range matched we still know which
  // floor the device is on. defaultState() will publish the floor id rather
  // than "not_home".
  return {
    roomId: null,
    roomName: null,
    floorId: floorFallback?.floorId ?? null,
    floorName: floorFallback?.floorName ?? null,
  };
}

/**
 * Room-hysteresis-aware wrapper over `resolveLocation`. Requires a device to
 * register in a new room for at least a configurable dwell window before the
 * returned location flips — wobbles inside that window hold the previous
 * committed room instead.
 *
 * Two thresholds are consulted:
 *
 *   - `filtering.room_stability_ms` — used for transitions to rooms adjacent
 *     to the committed one (via `open_to` or shared `floor_area`). Standard
 *     boundary-flicker suppression.
 *
 *   - `filtering.room_teleport_stability_ms` (Phase 2) — used when the
 *     candidate room isn't graph-adjacent. A person can't walk through a
 *     wall, so this demands much stronger evidence (typically 5–10×
 *     longer). Set to 0 to disable the distinction — non-adjacent
 *     transitions then use the regular threshold.
 *
 * When both thresholds are 0, behavior is identical to `resolveLocation`.
 * Per-device state is stored in the module-level singleton and cleared via
 * `clearDeviceHysteresis` when a device goes away.
 */
function resolveLocationWithHysteresis(
  deviceId: string,
  pos: { x: number; y: number; z: number },
  config: Config,
): ResolvedLocation {
  const raw = resolveLocation(pos, config);
  const adjacentThreshold = config.filtering.room_stability_ms ?? 0;
  const teleportThreshold = config.filtering.room_teleport_stability_ms ?? 0;
  // If both are zero, hysteresis is fully off. No state to track.
  if (adjacentThreshold <= 0 && teleportThreshold <= 0) return raw;

  const s = state();
  const existing = s.roomHysteresis.get(deviceId);
  const now = Date.now();

  // First sighting — commit immediately. Nothing to smooth.
  if (!existing) {
    s.roomHysteresis.set(deviceId, { committed: raw, candidate: null });
    return raw;
  }

  // Same room as committed — clear any candidate; refresh floor info in case
  // the device crossed a floor boundary without changing roomId (unlikely but
  // cheap to handle).
  if (raw.roomId === existing.committed.roomId) {
    existing.candidate = null;
    existing.committed = raw;
    return raw;
  }

  // Different room than committed. Either start a new candidate or keep
  // accumulating dwell time on the existing one.
  if (existing.candidate === null || existing.candidate.loc.roomId !== raw.roomId) {
    existing.candidate = { loc: raw, since: now };
    return existing.committed;
  }

  // Same candidate as last tick — has it dwelled long enough to promote?
  // Threshold depends on whether the transition is graph-adjacent.
  const committedRoomId = existing.committed.roomId;
  const candidateRoomId = raw.roomId;
  let threshold = adjacentThreshold;
  if (
    teleportThreshold > 0 &&
    committedRoomId != null &&
    candidateRoomId != null
  ) {
    const graph = getRoomGraph(config);
    if (!areAdjacent(graph, committedRoomId, candidateRoomId)) {
      // Non-adjacent transitions use the longer "teleport" threshold. If
      // `adjacentThreshold` is 0 (disabled) but teleport is set, the
      // teleport threshold still gates these — more conservative, not less.
      threshold = Math.max(adjacentThreshold, teleportThreshold);
    }
  }
  if (threshold <= 0) {
    // Adjacent transition with `room_stability_ms` disabled — commit now.
    existing.committed = raw;
    existing.candidate = null;
    return raw;
  }
  if (now - existing.candidate.since >= threshold) {
    existing.committed = raw;
    existing.candidate = null;
    return raw;
  }

  // Still within the hold window — keep publishing committed.
  return existing.committed;
}

/** Clear hysteresis state for a device (called when a device goes away). */
function clearDeviceHysteresis(deviceId: string): void {
  state().roomHysteresis.delete(deviceId);
}

// ─── Zone state computation ───────────────────────────────────────────────────

/** Zone state: `on` when the device is inside the zone, `off` otherwise. */
const ZONE_PAYLOAD_ON = "on";
const ZONE_PAYLOAD_OFF = "off";

/**
 * True iff the resolved location matches any of the zone's listed rooms,
 * by id or name (case-insensitive). `loc.roomId == null` (device between
 * rooms / outside all polygons) is always "not in zone."
 */
function isDeviceInZone(
  loc: ResolvedLocation,
  zone: PresenceZone,
): boolean {
  if (loc.roomId == null) return false;
  return zone.rooms.some(
    (r) =>
      r === loc.roomId ||
      r === loc.roomName ||
      r.toLowerCase() === loc.roomId?.toLowerCase() ||
      r.toLowerCase() === loc.roomName?.toLowerCase(),
  );
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
  // Raw + zone trackers share one attributes topic — they all represent
  // the same physical position, just presented at different granularities.
  return `espresense/hub/${deviceId}/attributes`;
}

function discoveryTopic(discoveryPrefix: string, deviceId: string): string {
  return `${discoveryPrefix}/device_tracker/espresense-hub-${deviceId}/config`;
}

/**
 * Zone entities live under the `binary_sensor` component (not
 * `device_tracker`) — a zone is semantically "is this device in this
 * area?" which reads better as an on/off binary sensor than as a
 * string-valued tracker. Automations get the clean
 * `binary_sensor.nick_master_suite is on` form instead of
 * `device_tracker.nick_master_suite.state == 'Master Suite'`.
 */
function zoneDiscoveryTopic(
  discoveryPrefix: string,
  deviceId: string,
  zoneId: string,
): string {
  return `${discoveryPrefix}/binary_sensor/espresense-hub-${deviceId}-${zoneId}/config`;
}

// ─── Smart (Bayesian) tracker topics ──────────────────────────────────────

/**
 * Topic slug segment for the Bayesian ("smart") tracker. Lives under the
 * device's topic tree alongside zones, but with a leading underscore to
 * reserve it from colliding with user-chosen zone ids.
 */
const SMART_SLUG = "_smart";

function smartStateTopic(deviceId: string): string {
  return `espresense/hub/${deviceId}/${SMART_SLUG}`;
}

function smartAttributesTopic(deviceId: string): string {
  return `espresense/hub/${deviceId}/${SMART_SLUG}/attributes`;
}

function smartDiscoveryTopic(discoveryPrefix: string, deviceId: string): string {
  return `${discoveryPrefix}/device_tracker/espresense-hub-${deviceId}-smart/config`;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Publish the HA discovery config for the default per-device room tracker
 * (device_tracker entity whose state is "room id / floor id / not_home").
 * Idempotent per process: dedup by device, publish once.
 */
async function ensureDiscovery(
  deviceId: string,
  deviceName: string,
  discoveryPrefix: string,
): Promise<void> {
  const key = `${deviceId}::__default__`;
  const s = state();
  if (s.sentDiscovery.has(key)) return;

  const payload = {
    name: "Location",
    unique_id: `espresense-hub-${deviceId}`,
    state_topic: stateTopic(deviceId),
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
    discoveryTopic(discoveryPrefix, deviceId),
    JSON.stringify(payload),
    { retain: true, qos: 1 },
  );
  // Mark sent only AFTER a successful publish — otherwise a transient
  // failure silently poisons this key for the rest of the process
  // lifetime and the entity never appears in HA.
  s.sentDiscovery.add(key);
}

/**
 * Publish HA discovery for a zone as a `binary_sensor` entity with
 * `device_class: occupancy`. State topic stays at the same path zones
 * have always used, but the payloads are `"on"` / `"off"`.
 *
 * Historical note: earlier versions published zones as `device_tracker`
 * entities. The migration-to-binary_sensor release included a one-shot
 * empty-retained publish to the old discovery topics to delete the
 * orphans. That cleanup was removed after the first successful deploy
 * — those retained topics are already empty on the broker.
 */
async function ensureZoneDiscovery(
  deviceId: string,
  deviceName: string,
  discoveryPrefix: string,
  zoneId: string,
  zoneLabel: string | undefined,
): Promise<void> {
  const key = `${deviceId}::zone::${zoneId}`;
  const s = state();
  if (s.sentDiscovery.has(key)) return;

  const payload = {
    name: zoneLabel ?? zoneId,
    unique_id: `espresense-hub-${deviceId}-${zoneId}`,
    state_topic: stateTopic(deviceId, zoneId),
    payload_on: ZONE_PAYLOAD_ON,
    payload_off: ZONE_PAYLOAD_OFF,
    device_class: "occupancy",
    device: {
      name: deviceName,
      manufacturer: "ESPresense",
      model: "Hub",
      identifiers: [`espresense-hub-${deviceId}`],
    },
    origin: { name: "ESPresense Hub" },
  };

  await publishRaw(
    zoneDiscoveryTopic(discoveryPrefix, deviceId, zoneId),
    JSON.stringify(payload),
    { retain: true, qos: 1 },
  );
  s.sentDiscovery.add(key);
}

/**
 * Register the Bayesian-smoothed "smart" tracker as a second HA
 * device_tracker entity on the same underlying device. Runs alongside
 * the raw location tracker so users can compare the two side-by-side
 * in HA history and wire their own automations to whichever they trust.
 *
 * The smart entity has its own state + attribute topics under the
 * device's `_smart` subpath, distinct from the raw topic and from zones.
 */
async function ensureSmartDiscovery(
  deviceId: string,
  deviceName: string,
  discoveryPrefix: string,
): Promise<void> {
  const key = `${deviceId}::__smart__`;
  const s = state();
  if (s.sentDiscovery.has(key)) return;

  const payload = {
    name: "Smart Location",
    unique_id: `espresense-hub-${deviceId}-smart`,
    state_topic: smartStateTopic(deviceId),
    json_attributes_topic: smartAttributesTopic(deviceId),
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
    smartDiscoveryTopic(discoveryPrefix, deviceId),
    JSON.stringify(payload),
    { retain: true, qos: 1 },
  );
  s.sentDiscovery.add(key);
}

// ─── Away publishing ──────────────────────────────────────────────────────────

/**
 * Publish "not_home" to all presence trackers for a device that has gone away
 * (away_timeout elapsed). Only publishes when state actually changed so we
 * don't churn the broker on every cleanup tick.
 */
export async function publishDeviceAway({
  deviceId,
  deviceName,
  config,
}: {
  deviceId: string;
  deviceName: string;
  config: Config;
}): Promise<void> {
  const discoveryPrefix = config.mqtt.discovery_topic ?? "homeassistant";
  const s = state();

  // The device is gone — clear hysteresis so the next sighting commits
  // immediately rather than holding a stale "committed" room over the gap.
  clearDeviceHysteresis(deviceId);

  const defKey = `${deviceId}::__default__`;
  if (s.lastState.get(defKey) !== "not_home") {
    s.lastState.set(defKey, "not_home");
    await ensureDiscovery(deviceId, deviceName, discoveryPrefix);
    await publishRaw(stateTopic(deviceId), "not_home", {
      retain: false,
      qos: 1,
    });
  }

  // Smart tracker — cleared whenever it was ever published. Gated by
  // `bayesian.enabled` so we don't spam HA with discovery messages for a
  // disabled feature.
  if (config.bayesian.enabled) {
    const smartKey = `${deviceId}::__smart__`;
    if (s.lastState.get(smartKey) !== "not_home") {
      s.lastState.set(smartKey, "not_home");
      await ensureSmartDiscovery(deviceId, deviceName, discoveryPrefix);
      await publishRaw(smartStateTopic(deviceId), "not_home", {
        retain: false,
        qos: 1,
      });
    }
  }

  for (const zone of config.presence.zones) {
    const zKey = `${deviceId}::${zone.id}`;
    if (s.lastState.get(zKey) !== ZONE_PAYLOAD_OFF) {
      s.lastState.set(zKey, ZONE_PAYLOAD_OFF);
      await ensureZoneDiscovery(
        deviceId,
        deviceName,
        discoveryPrefix,
        zone.id,
        zone.label,
      );
      await publishRaw(stateTopic(deviceId, zone.id), ZONE_PAYLOAD_OFF, {
        retain: false,
        qos: 1,
      });
    }
  }
}

// ─── Main publish entry point ─────────────────────────────────────────────────

interface PositionSample {
  x: number;
  y: number;
  z: number;
  confidence: number;
  fixes: number;
  algorithm: string;
}

export interface PresencePublishInput {
  deviceId: string;
  deviceName: string;
  /** Raw active-locator position — drives the default `device_tracker.{id}_location` entity. */
  position: PositionSample;
  /**
   * Bayesian-smoothed position from the BayesianLocator. When present
   * AND `config.bayesian.enabled`, a parallel "smart" tracker is
   * published to HA and zones aggregate over the Bayesian room
   * assignment instead of the raw one.
   */
  bayesianPosition?: PositionSample;
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
  bayesianPosition,
  config,
}: PresencePublishInput): Promise<void> {
  const discoveryPrefix = config.mqtt.discovery_topic ?? "homeassistant";
  const rawLoc = resolveLocationWithHysteresis(deviceId, position, config);
  const s = state();

  // Smart tracker runs when the Bayesian locator is enabled and actually
  // produced a position this tick. Skipping hysteresis on bayesianLoc —
  // the Bayesian forward algorithm already provides heavy smoothing, and
  // running the discrete room-hysteresis on top would just double-smooth.
  const useBayesian = Boolean(bayesianPosition && config.bayesian.enabled);
  const bayesianLoc =
    useBayesian && bayesianPosition ? resolveLocation(bayesianPosition, config) : null;

  // Zones auto-upgrade to the Bayesian room assignment when available —
  // there's never a reason to aggregate over the known-noisier signal.
  const zoneLoc = bayesianLoc ?? rawLoc;

  // ── Raw attrs (always publish — position may have moved within a room) ──
  const attrs = {
    source_type: "espresense",
    x: position.x,
    y: position.y,
    z: position.z,
    confidence: Math.round(position.confidence * 100),
    fixes: position.fixes,
    algorithm: position.algorithm,
    room: rawLoc.roomName,
    floor: rawLoc.floorName,
    last_seen: new Date().toISOString(),
  };
  await publishRaw(attributesTopic(deviceId), JSON.stringify(attrs), {
    retain: true,
    qos: 1,
  });

  // ── Default tracker (raw): room id → floor id → "not_home" ───────────────
  const defState = defaultState(rawLoc);
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

  // ── Smart tracker (Bayesian-smoothed): separate entity, separate attrs ───
  if (useBayesian && bayesianLoc && bayesianPosition) {
    const smartAttrs = {
      source_type: "espresense",
      x: bayesianPosition.x,
      y: bayesianPosition.y,
      z: bayesianPosition.z,
      confidence: Math.round(bayesianPosition.confidence * 100),
      fixes: bayesianPosition.fixes,
      algorithm: bayesianPosition.algorithm,
      room: bayesianLoc.roomName,
      floor: bayesianLoc.floorName,
      last_seen: new Date().toISOString(),
    };
    await publishRaw(
      smartAttributesTopic(deviceId),
      JSON.stringify(smartAttrs),
      { retain: true, qos: 1 },
    );
    const smartState = defaultState(bayesianLoc);
    const smartKey = `${deviceId}::__smart__`;
    if (s.lastState.get(smartKey) !== smartState) {
      s.lastState.set(smartKey, smartState);
      await ensureSmartDiscovery(deviceId, deviceName, discoveryPrefix);
      await publishRaw(smartStateTopic(deviceId), smartState, {
        retain: false,
        qos: 1,
      });
    } else {
      await ensureSmartDiscovery(deviceId, deviceName, discoveryPrefix);
    }
  }

  // ── Zone binary sensors ──────────────────────────────────────────────────
  // Each zone is published as a binary_sensor with device_class:occupancy.
  // `on` = device is in one of the zone's rooms; `off` = it isn't. The
  // underlying room assignment comes from `zoneLoc`, which auto-upgrades
  // to the Bayesian room when that tracker is enabled.
  for (const zone of config.presence.zones) {
    const zState = isDeviceInZone(zoneLoc, zone)
      ? ZONE_PAYLOAD_ON
      : ZONE_PAYLOAD_OFF;
    const zKey = `${deviceId}::${zone.id}`;
    await ensureZoneDiscovery(
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
