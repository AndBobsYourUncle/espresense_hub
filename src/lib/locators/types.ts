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
  solve(fixes: readonly NodeFix[]): LocatorResult | null;
}
