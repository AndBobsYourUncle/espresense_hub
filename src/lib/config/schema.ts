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

// ---------------- GPS ----------------

export const GpsSchema = z.object({
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  elevation: z.number().nullable().optional(),
  rotation: z.number().nullable().optional(),
  report: z.boolean().default(false),
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
    /**
     * Upstream-companion field — parsed for back-compat but ignored.
     * Our calibration UI shows live state, not historical snapshots.
     */
    keep_snapshot_mins: z.number().int().default(5),
    limits: z.record(z.string(), z.number()).default({}),
    weights: z.record(z.string(), z.number()).default({}),
  })
  .prefault({});

// ---------------- Locators ----------------

const WeightingSchema = z.object({
  algorithm: z
    .enum(["equal", "linear", "gaussian", "exponential"])
    .default("gaussian"),
  props: z.record(z.string(), z.number()).default({}),
});

const FlooredLocatorSchema = z.object({
  enabled: z.boolean().default(false),
  floors: z.array(z.string()).nullable().optional(),
});

export const LocatorsSchema = z
  .object({
    nadaraya_watson: FlooredLocatorSchema.extend({
      bandwidth: z.number().default(0.5),
      kernel: z.string().default("gaussian"),
    }).prefault({}),
    nelder_mead: FlooredLocatorSchema.extend({
      weighting: WeightingSchema.prefault({}),
    }).prefault({}),
    bfgs: FlooredLocatorSchema.extend({
      weighting: WeightingSchema.prefault({}),
    }).prefault({}),
    mle: FlooredLocatorSchema.extend({
      weighting: WeightingSchema.prefault({}),
    }).prefault({}),
    multi_floor: z
      .object({
        enabled: z.boolean().default(false),
        weighting: WeightingSchema.prefault({}),
      })
      .prefault({}),
    nearest_node: z
      .object({
        enabled: z.boolean().default(true),
        max_distance: z.number().nullable().optional(),
      })
      .prefault({}),
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
     *
     * Note: distinct from upstream companion's `process_noise` field
     * (which has different semantics — variance, not std dev).
     */
    kalman_process_noise: z.number().default(0.5),
    /**
     * Kalman measurement noise — base std dev of locator output
     * position error, in meters. Scaled per-update by 1/confidence
     * so low-confidence fixes get less weight automatically. 0.5 m
     * works well with our locator stack. Only applies when
     * position_filter = kalman.
     *
     * Note: distinct from upstream companion's `measurement_noise`.
     */
    kalman_measurement_noise: z.number().default(0.5),
    /**
     * Upstream-companion fields, parsed for back-compat but currently
     * unused by our pipeline. The companion's Kalman has different
     * semantics from ours — see kalman_process_noise above. Safe to
     * leave in your config; the locator will just ignore them.
     */
    process_noise: z.number().default(0.01),
    measurement_noise: z.number().default(0.1),
    max_velocity: z.number().default(0.5),
    /**
     * EMA smoothing weight, 0..1. Only applies when
     * position_filter = ema.
     *   0.0 → no smoothing
     *   0.4 → modest (good for moving wearables)
     *   0.7 → upstream companion default (heavier, more lag)
     *   1.0 → very heavy
     */
    smoothing_weight: z.number().default(0.4),
    motion_sigma: z.number().default(2.0),
  })
  .prefault({});

// ---------------- History ----------------

export const HistorySchema = z
  .object({
    enabled: z.boolean().default(false),
    db: z.string().default("sqlite:///espresense.db"),
    expire_after: z.string().default("24h"),
  })
  .prefault({});

// ---------------- Floors / Rooms ----------------

// Upstream represents 2D points as [x, y] and 3D points as [x, y, z]. Accept
// tuples permissively (YAML gives us number[]).
const Point2DSchema = z.tuple([z.number(), z.number()]);
const Point3DSchema = z.tuple([z.number(), z.number(), z.number()]);

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
     */
    open_to: z.array(z.string()).default([]),
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
 * the default room-level tracker. Each zone produces its own HA entity
 * with its own state string so automations can target coarser groupings
 * without needing helpers or complex OR conditions.
 *
 * type: "rooms" (default) — maps a named set of rooms to a single label.
 *   State = label when device is in any listed room, "not_home" otherwise.
 *
 * type: "bayesian" — future: probabilistic room model with hysteresis.
 *   Prevents flicker at room boundaries by requiring sustained evidence
 *   before committing a room transition.
 */
export const PresenceZoneSchema = z.object({
  /** Slug used in the MQTT topic and HA unique_id. */
  id: z.string(),
  /** Human-readable name for the HA entity. Defaults to id. */
  label: z.string().optional(),
  type: z.enum(["rooms", "bayesian"]).default("rooms"),
  /** For type "rooms": list of room ids/names that map to this zone. */
  rooms: z.array(z.string()).default([]),
  /** For type "bayesian": minimum posterior to commit a room transition. */
  transition_threshold: z.number().min(0).max(1).default(0.85),
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
  gps: GpsSchema.prefault({}),
  map: MapSchema.prefault({}),

  timeout: z.number().int().default(30),
  away_timeout: z.number().int().default(120),
  device_retention: z.string().default("30d"),

  optimization: OptimizationSchema,
  locators: LocatorsSchema,
  filtering: FilteringSchema,
  history: HistorySchema,
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
