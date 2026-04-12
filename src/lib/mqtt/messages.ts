import { z } from "zod";

/**
 * Incoming MQTT payload shapes. Kept permissive on purpose — different
 * firmware versions of ESPresense emit slightly different fields, and we'd
 * rather accept unknown extras than reject the whole message.
 */

// Upstream node telemetry is camelCase JSON.
export const NodeTelemetrySchema = z.looseObject({
  uptime: z.number().optional(),
  rssi: z.number().optional(),
  freeHeap: z.number().optional(),
  maxAllocHeap: z.number().optional(),
  memoryFragmentation: z.number().optional(),
  count: z.number().optional(),
  adverts: z.number().optional(),
  seen: z.number().optional(),
  reported: z.number().optional(),
  scanHighWater: z.number().optional(),
  ip: z.string().optional(),
  firmware: z.string().optional(),
  version: z.string().optional(),
});

export type NodeTelemetry = z.infer<typeof NodeTelemetrySchema>;

// Per-measurement device message. Some firmwares emit snake_case, others
// camelCase — normalize both.
export const DeviceMessageSchema = z.looseObject({
  distance: z.number().optional(),
  rssi: z.number().optional(),
  ref_rssi: z.number().optional(),
  refRssi: z.number().optional(),
  name: z.string().optional(),
  dist_var: z.number().optional(),
  distVar: z.number().optional(),
  rssi_var: z.number().optional(),
  rssiVar: z.number().optional(),
});

export type DeviceMessage = z.infer<typeof DeviceMessageSchema>;

/** Canonicalize a DeviceMessage: prefer camelCase, fall back to snake_case. */
export interface NormalizedMeasurement {
  distance?: number;
  rssi?: number;
  refRssi?: number;
  name?: string;
  distVar?: number;
  rssiVar?: number;
}

export function normalizeDeviceMessage(
  m: DeviceMessage,
): NormalizedMeasurement {
  return {
    distance: m.distance,
    rssi: m.rssi,
    refRssi: m.refRssi ?? m.ref_rssi,
    name: m.name,
    distVar: m.distVar ?? m.dist_var,
    rssiVar: m.rssiVar ?? m.rssi_var,
  };
}
