import type { Point3D } from "@/lib/map/geometry";
import type { DeviceState } from "@/lib/state/store";
import type { Locator, NodeFix } from "./types";

/**
 * Compute leave-one-out residuals for a device measurement set.
 *
 * For each node N reporting on the device, recompute the device's position
 * using ALL OTHER nodes (excluding N), then measure the geometric distance
 * from that position to N.point. The residual is `measured − expected`.
 *
 * Why leave-one-out: a single biased node has a strong pull on the locator
 * (especially with IDW where weight ∝ 1/d²), so its own residual against
 * the inclusive position is artificially small. Excluding it gives the
 * "best guess from everyone else" against which to compare its claim.
 *
 * Convention:
 *   residual > 0  → node reports distance LARGER than reality (over-distance)
 *   residual < 0  → node reports distance SMALLER than reality
 *
 * Returns an empty map when there aren't enough fixes (need ≥3 so each
 * leave-one-out still has ≥2 to solve with).
 */
export function leaveOneOutResiduals(
  device: DeviceState,
  nodeIndex: Map<string, Point3D>,
  locator: Locator,
  staleAfterMs: number,
): Map<string, number> {
  const cutoff = Date.now() - staleAfterMs;
  const allFixes: NodeFix[] = [];
  for (const m of device.measurements.values()) {
    if (m.distance == null || !Number.isFinite(m.distance)) continue;
    if (m.lastSeen < cutoff) continue;
    const point = nodeIndex.get(m.nodeId);
    if (!point) continue;
    allFixes.push({ nodeId: m.nodeId, point, distance: m.distance });
  }

  if (allFixes.length < 3) return new Map();

  const residuals = new Map<string, number>();
  for (const target of allFixes) {
    const others = allFixes.filter((f) => f.nodeId !== target.nodeId);
    const result = locator.solve(others);
    if (!result) continue;
    const dx = result.x - target.point[0];
    const dy = result.y - target.point[1];
    const dz = result.z - target.point[2];
    const expected = Math.sqrt(dx * dx + dy * dy + dz * dz);
    residuals.set(target.nodeId, target.distance - expected);
  }
  return residuals;
}
