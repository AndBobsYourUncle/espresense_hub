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
