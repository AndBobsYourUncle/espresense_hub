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
    enabled: z.boolean().default(true),
    optimizer: z
      .enum(["global_absorption", "per_node_absorption", "legacy"])
      .default("per_node_absorption"),
    interval_secs: z.number().int().default(3600),
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
    process_noise: z.number().default(0.01),
    measurement_noise: z.number().default(0.1),
    max_velocity: z.number().default(0.5),
    smoothing_weight: z.number().default(0.7),
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
