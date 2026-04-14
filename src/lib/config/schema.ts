import { z } from "zod";

/**
 * Zod schemas for ESPresense-companion compatible config.yaml.
 *
 * Keep field names and types aligned with the upstream C# config classes so
 * that existing config files parse verbatim. YAML uses snake_case throughout.
 */

// Slugify a human name into a stable id (matches upstream behavior: lowercase,
// non-alphanumerics collapsed to underscores, trimmed).
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------- MQTT ----------------

export const MqttSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().default(1883),
  ssl: z.boolean().default(false),
  username: z.string().optional(),
  password: z.string().optional(),
  client_id: z.string().default("espresense-hub"),
  discovery_topic: z.string().default("homeassistant"),
});


// ---------------- Map ----------------

export const MapSchema = z.object({
  flip_x: z.boolean().default(false),
  flip_y: z.boolean().default(true),
  wall_thickness: z.number().default(0.1),
  wall_color: z.string().nullable().optional(),
  wall_opacity: z.number().nullable().default(0.35),
});

// ---------------- Optimization ----------------

export const OptimizationSchema = z
  .object({
    /** Master switch for the auto-apply background loop. */
    enabled: z.boolean().default(true),
    /**
     * Which optimization pipeline runs.
     *
     *   streaming_per_pair (default) — our pipeline. Streaming
     *     sufficient stats per (listener, transmitter) pair, online
     *     decay, small frequent deltas pushed to firmware. Designed
     *     to converge continuously while you live in the house.
     *
     *   per_node_absorption / global_absorption / legacy — upstream
     *     companion's batch optimizers. Our code doesn't implement
     *     any of these, so picking one effectively disables the
     *     auto-apply loop (equivalent to `enabled: false`). Kept
     *     parseable so existing companion configs roll over without
     *     errors. Pick `streaming_per_pair` to actually use our
     *     pipeline.
     */
    optimizer: z
      .enum([
        "streaming_per_pair",
        "global_absorption",
        "per_node_absorption",
        "legacy",
      ])
      .default("streaming_per_pair"),
    /**
     * How often the auto-apply loop runs, in seconds. Default 300
     * (5 min) — much faster than the upstream companion's hourly
     * cadence because our streaming-stats approach favors many small
     * corrections over rare large ones. Per-node rate limit (10 min)
     * still applies, so cycle frequency caps how often a node *can*
     * be re-touched, not how often it actually is.
     */
    interval_secs: z.number().int().default(300),
    /**
     * Minimum |Δ| in path-loss exponent for the auto-apply loop to
     * publish an update to firmware. Changes smaller than this get
     * silently skipped — they don't meaningfully affect distance
     * estimates (a Δ of 0.05 in n shifts the estimate ~2–4 % at typical
     * ranges) and they churn NVS flash writes on the ESP32 for no gain.
     *
     * Default 0.10 — safely above the regression's own sampling noise
     * so the system only publishes when the fit has actually drifted,
     * not when the ring buffer rotated through slightly different
     * samples. Set lower (e.g. 0.05) if you want to track every tiny
     * drift in the audit log; higher (0.15–0.20) for quieter logs and
     * fewer flash writes at the cost of slower convergence.
     */
    min_delta: z.number().default(0.1),
  })
  .prefault({});


// ---------------- Filtering ----------------

export const FilteringSchema = z
  .object({
    /**
     * Which position filter to apply. Default `kalman` — tracks
     * position AND velocity so motion is followed without lag while
     * stationary devices still benefit from measurement averaging.
     * `ema` falls back to a simple time-weighted exponential moving
     * average. `none` passes raw locator output through unfiltered
     * (useful for diagnosing what the smoothing is doing).
     */
    position_filter: z.enum(["kalman", "ema", "none"]).default("kalman"),
    /**
     * Kalman process noise — std dev of acceleration in m/s². Higher
     * = more responsive to direction changes, jitter creeps back in.
     * 0.5 is reasonable for a human walking; 1.5+ for a phone being
     * waved around. Only applies when position_filter = kalman.
     */
    kalman_process_noise: z.number().default(0.5),
    /**
     * Kalman measurement noise — base std dev of locator output
     * position error, in meters. Scaled per-update by 1/confidence
     * so low-confidence fixes get less weight automatically. 0.5 m
     * works well with our locator stack. Only applies when
     * position_filter = kalman.
     */
    kalman_measurement_noise: z.number().default(0.5),
    /**
     * EMA smoothing weight, 0..1. Only applies when
     * position_filter = ema.
     *   0.0 → no smoothing
     *   0.4 → modest (good for moving wearables)
     *   0.7 → upstream companion default (heavier, more lag)
     *   1.0 → very heavy
     */
    smoothing_weight: z.number().default(0.4),
    /**
     * Room-hysteresis threshold, in milliseconds. When > 0, the HA presence
     * tracker requires a device to register in a new room for at least this
     * long before flipping the published state. Kills boundary flicker —
     * especially useful when a device is wobbling right at a wall edge and
     * the locator alternates between two rooms on consecutive ticks.
     *
     * Only affects HA publishing. The raw position shown on the map is
     * unaffected (so you can still see the wobble for diagnostic purposes).
     *
     * Default 0 (off) — opt in by setting to ~1500 for a balanced value.
     * Phase 1 of the graph-aware tracker work; will be superseded by the
     * Bayesian locator once implemented.
     */
    room_stability_ms: z.number().int().min(0).default(0),
  })
  .prefault({});


// ---------------- Floors / Rooms ----------------

// Upstream represents 2D points as [x, y] and 3D points as [x, y, z]. Accept
// tuples permissively (YAML gives us number[]).
const Point2DSchema = z.tuple([z.number(), z.number()]);
const Point3DSchema = z.tuple([z.number(), z.number(), z.number()]);

/**
 * A single entry in a room's `open_to` list. Either a plain id/name string
 * (back-compat) or an object that also carries an optional doorway position.
 */
export const OpenToEntrySchema = z.union([
  z.string(),
  z.object({
    id: z.string(),
    /** Doorway centre in config-space metres, for the Bayesian room tracker. */
    door: z.tuple([z.number(), z.number()]).optional(),
  }),
]);

export type OpenToEntry = z.infer<typeof OpenToEntrySchema>;

/** Extract the room id/name from an open_to entry (string or object). */
export function openToId(entry: OpenToEntry): string {
  return typeof entry === "string" ? entry : entry.id;
}

/** Extract the door position from an open_to entry, or undefined. */
export function openToDoor(entry: OpenToEntry): [number, number] | undefined {
  return typeof entry === "string" ? undefined : entry.door;
}

export const RoomSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    color: z.string().nullable().optional(),
    points: z.array(Point2DSchema).optional(),
    /**
     * Other rooms (by id or name) that this room is open to — no wall
     * or door between them. Used by the room-aware locator to treat
     * connected spaces as one zone for trust weighting. Symmetric:
     * if A lists B, B is treated as open to A even if it doesn't list A.
     *
     * Entries may be plain strings (back-compat) or objects carrying an
     * optional `door` [x, y] coordinate for the Bayesian room tracker.
     */
    open_to: z.array(OpenToEntrySchema).default([]),
    /**
     * Tag for an open-floor-plan zone. Every room sharing the same
     * `floor_area` value is treated as mutually adjacent in the room
     * graph (cleaner than declaring N×(N-1) `open_to` pairs by hand).
     * Use for kitchen/dining/living combos, lofts, studio layouts, etc.
     */
    floor_area: z.string().optional(),
  })
  .transform((room) => ({
    ...room,
    id: room.id ?? (room.name ? slugify(room.name) : undefined),
  }));

export const FloorSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    bounds: z.tuple([Point3DSchema, Point3DSchema]).optional(),
    rooms: z.array(RoomSchema).default([]),
  })
  .transform((floor) => ({
    ...floor,
    id: floor.id ?? (floor.name ? slugify(floor.name) : undefined),
  }));

// ---------------- Nodes ----------------

export const NodeSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    point: Point3DSchema.optional(),
    floors: z.array(z.string()).nullable().optional(),
    enabled: z.boolean().default(true),
    stationary: z.boolean().default(true),
    /**
     * Explicit room assignment (by id or name). Overrides the
     * point-in-polygon detection — useful when a node is mounted right
     * on a room boundary and the geometric test picks the wrong side.
     */
    room: z.string().optional(),
  })
  .transform((node) => ({
    ...node,
    id: node.id ?? (node.name ? slugify(node.name) : undefined),
  }));

// ---------------- Devices ----------------

// Upstream is very permissive here — both `devices` and `exclude_devices` are
// glob-style match rules with optional id/name.
export const DeviceMatchSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
});

// ---------------- Presence ----------------

/**
 * A "zone" is a derived Home Assistant device_tracker published alongside
 * the default room-level tracker. Each zone maps a named set of rooms to a
 * single label — state is the label when the device is in any listed room,
 * "not_home" otherwise. Each zone produces its own HA entity with its own
 * state string so automations can target coarser groupings without needing
 * helpers or complex OR conditions.
 *
 * Probabilistic room models are a separate concern handled via the planned
 * top-level `bayesian:` block (not a zone type), so this schema only covers
 * rooms-list aggregation.
 */
export const PresenceZoneSchema = z.object({
  /** Slug used in the MQTT topic and HA unique_id. */
  id: z.string(),
  /** Human-readable name for the HA entity. Defaults to id. */
  label: z.string().optional(),
  /** List of room ids/names that map to this zone. */
  rooms: z.array(z.string()).default([]),
});

export type PresenceZone = z.infer<typeof PresenceZoneSchema>;

export const PresenceSchema = z
  .object({
    zones: z.array(PresenceZoneSchema).default([]),
  })
  .prefault({});

// ---------------- Root ----------------

export const ConfigSchema = z.object({
  mqtt: MqttSchema.prefault({}),
  /** Passthrough — GPS integration is not yet implemented. Preserved as-is. */
  gps: z.unknown().optional(),
  map: MapSchema.prefault({}),

  timeout: z.number().int().default(30),
  away_timeout: z.number().int().default(120),
  device_retention: z.string().default("30d"),
  /**
   * When false, the hub skips all outbound MQTT presence publishing (state
   * topics, attributes, HA discovery). Everything else — solving, calibration,
   * the local UI — keeps running normally. Useful for running a local dev
   * instance alongside a production homelab hub without the two fighting over
   * the same HA entities. Default true (publishing on).
   */
  publish_presence: z.boolean().default(true),

  optimization: OptimizationSchema,
  /** Passthrough — locator config is not consumed at runtime. Preserved as-is. */
  locators: z.unknown().optional(),
  filtering: FilteringSchema,
  /** Passthrough — history/DB integration is not yet implemented. Preserved as-is. */
  history: z.unknown().optional(),
  presence: PresenceSchema,

  floors: z.array(FloorSchema).default([]),
  nodes: z.array(NodeSchema).default([]),
  devices: z.array(DeviceMatchSchema).default([]),
  exclude_devices: z.array(DeviceMatchSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Floor = z.infer<typeof FloorSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Node = z.infer<typeof NodeSchema>;
export type DeviceMatch = z.infer<typeof DeviceMatchSchema>;
