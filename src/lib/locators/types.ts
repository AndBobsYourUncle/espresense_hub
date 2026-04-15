import type { Point3D } from "@/lib/map/geometry";

/** A single node's measurement of the target device. */
export interface NodeFix {
  nodeId: string;
  point: Point3D;
  distance: number;
  /**
   * Running variance of this node's distance readings for this device.
   * High variance = unreliable (body-shadow, multipath). Used by the
   * solver to down-weight noisy nodes. Undefined means "no variance
   * data yet" — treat as average reliability.
   */
  distanceVariance?: number;
  /**
   * Raw RSSI in dBm as reported by firmware (before its absorption-
   * based distance conversion). Optional because legacy paths /
   * tests construct fixes without it; locators that need RSSI
   * should fall back when undefined. Most locators use `distance`
   * (the firmware-converted value) instead — RSSI is for locators
   * that want to bypass firmware's conversion (e.g. RfPhysics) and
   * apply their own propagation model directly.
   */
  rssi?: number;
}

/** Output of a locator algorithm. */
export interface LocatorResult {
  x: number;
  y: number;
  z: number;
  /** Heuristic 0..1 — higher means more nodes / lower residuals. */
  confidence: number;
  /** Number of nodes that participated in the fit. */
  fixes: number;
  /** Identifier of the algorithm that produced the result. */
  algorithm: string;
  /**
   * Optional explicit room assignment from locators that track room state
   * (e.g. the Bayesian room tracker). Downstream consumers (presence
   * publisher) use this when present instead of deriving the room from
   * (x, y) via point-in-polygon.
   *
   * Convention:
   *   - `undefined` — locator doesn't track rooms; caller should do
   *     point-in-polygon on (x, y) as usual.
   *   - `null` — locator explicitly says "not in any room" (between
   *     polygons or on the floor's periphery).
   *   - `"outside"` — the well-known outside state (imported as
   *     `OUTSIDE_ROOM_ID` from the config schema).
   *   - any other string — a specific room id.
   */
  roomId?: string | null;
}

/** Common locator interface — all algorithms accept a list of fixes. */
export interface Locator {
  readonly name: string;
  /**
   * Solve for the device position given its current fixes.
   *
   * `deviceId` is optional and provided by callers that know the owning
   * device. Stateless locators ignore it; stateful ones (e.g. the Bayesian
   * room tracker) key their per-device posterior state on it. Existing
   * implementations declaring `solve(fixes)` (no second parameter) still
   * satisfy this interface — TypeScript allows fewer parameters at the
   * implementation than the interface declares.
   */
  solve(fixes: readonly NodeFix[], deviceId?: string): LocatorResult | null;
}
