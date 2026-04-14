import { lookupBias, shrinkBias } from "@/lib/calibration/device_bias";
import type { Config } from "@/lib/config";
import type { Point3D } from "@/lib/map/geometry";
import { getStore, type DeviceState } from "@/lib/state/store";
import { BayesianLocator } from "./bayesian";
import { BFGSLocator } from "./bfgs";
import { MLELocator } from "./mle";
import { NadarayaWatsonLocator } from "./nadaraya_watson";
import { NearestNodeLocator } from "./nearest_node";
import { NelderMeadLocator } from "./nelder_mead";
import { OutlierRejectingLocator } from "./outlier";
import { RoomAwareLocator } from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

export type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Build the active locator from a Config.
 *
 * Default stack: PathAwareLocator wrapping IDW (Nadaraya-Watson). PathAware
 * iteratively refines positions using per-(listener, transmitter)
 * calibration data we collect from node-to-node observations. When that
 * data isn't available yet (fresh boot, before per-pair fits are computed)
 * it transparently falls back to the base locator's output.
 *
 * Base picker priority:
 *   1. Nadaraya-Watson (IDW) — robust to outliers, default
 *   2. Nelder-Mead — proper least-squares, opt-in via disabling NW in config
 *
 * Future: BFGS, MLE will plug in here as additional base options.
 */
export interface LocatorBundle {
  /** The user-facing locator (PathAware wrapping the picked base). */
  active: Locator;
  /**
   * Every base locator we want to compute side-by-side. Each runs on the
   * raw firmware distances (no PathAware wrap) so the user can see how
   * different algorithms perform on the same data, and compare them
   * against the active PathAware result.
   */
  alternatives: Locator[];
}

export function buildLocator(config: Config): LocatorBundle {
  // Construct every base locator unconditionally — they're cheap to keep
  // around and the comparison view needs them all. Every base is wrapped
  // in OutlierRejectingLocator so a single flaky node can't drag the
  // solution off into the wrong room; the wrapper preserves the inner's
  // `name` so downstream code still sees the original algorithm label.
  const idw = new OutlierRejectingLocator(new NadarayaWatsonLocator());
  const nm = new OutlierRejectingLocator(new NelderMeadLocator());
  const bfgs = new OutlierRejectingLocator(new BFGSLocator());
  const mle = new OutlierRejectingLocator(new MLELocator());
  // nearest_node is intentionally NOT outlier-wrapped — its whole point
  // as a baseline is "what does the trivial heuristic say", and outlier
  // rejection would defeat that comparison. Reports the room centroid of
  // the nearest-reporting node, which is the most honest single-point
  // summary of the only signal it actually has ("device is in this room").
  const allRooms = config.floors.flatMap((f) => f.rooms);
  const nearest = new NearestNodeLocator(allRooms, config.nodes);

  // Room-aware circle-overlap locator. Uses the room topology (where
  // walls are) to decide which measurements to trust. Same-room node
  // pairs have unobstructed BLE paths → their circle overlap centers
  // are accurate. Cross-wall pairs are distorted → down-weighted.
  // Finds the position from the weighted centroid of pairwise overlap
  // centers, iterating to refine which room the device is in.
  const roomAware = new RoomAwareLocator(allRooms, config.nodes);
  const active = roomAware;

  // Bayesian room tracker (Phase 3b/3c). Observes from the same RoomAware
  // locator that drives the active position — Bayesian's job is to apply
  // graph-aware smoothing *on top* of the best-available observation, not
  // to re-do trilateration. Maintains a per-device posterior over rooms ∪
  // {outside}, runs one forward-algorithm step per message, and emits a
  // position constrained to the most-likely room's polygon. Included in
  // alternatives so it renders as a side-by-side dot on the map for
  // comparison with raw RoomAware output.
  //
  // Gated on `config.bayesian.enabled` so users on low-powered hosts (or
  // users who just don't want the extra dot on the map) can skip the work.
  //
  // The RoomAware instance is shared: `active` and `bayesian.inner` are
  // the same object, so the second call in the alternatives pass hits a
  // stateless re-solve on the same fixes rather than a separate computation.
  const allBases: Locator[] = [idw, nm, bfgs, mle, nearest];
  if (config.bayesian.enabled) {
    allBases.push(new BayesianLocator(roomAware));
  }

  return { active, alternatives: allBases };
}

/**
 * Build a `nodeId → 3D point` lookup from config.nodes. Excludes nodes that
 * lack a position (we can't trilaterate against an unanchored receiver).
 */
export function buildNodeIndex(config: Config): Map<string, Point3D> {
  const m = new Map<string, Point3D>();
  for (const n of config.nodes) {
    if (n.id && n.point && n.enabled !== false) m.set(n.id, n.point);
  }
  return m;
}

/**
 * Pull live fixes off a device and run the locator. Returns null when there
 * aren't enough recent measurements to compute a position.
 *
 * `staleAfterMs` drops measurements that are older than the configured
 * device timeout, so a device that lost coverage from one node doesn't
 * carry the stale fix forever.
 */
export function computeDevicePosition(
  device: DeviceState,
  nodeIndex: Map<string, Point3D>,
  locator: Locator,
  staleAfterMs: number,
): LocatorResult | null {
  const cutoff = Date.now() - staleAfterMs;
  const fixes: NodeFix[] = [];

  // For per-device-per-node bias correction: use the device's previous
  // position estimate as the lookup point. Falls back to (0,0,0) on
  // first solve, but the IDW falloff makes confidence low there and
  // shrinkBias() collapses to no correction.
  const store = getStore();
  const lookupPos: readonly [number, number, number] = device.position
    ? [device.position.x, device.position.y, device.position.z]
    : [0, 0, 0];

  for (const m of device.measurements.values()) {
    // Feed the solver the smoothed per-node EMA instead of the raw
    // single-snapshot reading — drops the fit RMSE substantially for
    // stationary/slow-moving devices.
    let distance = m.smoothedDistance ?? m.distance;
    if (distance == null || !Number.isFinite(distance)) continue;
    if (m.lastSeen < cutoff) continue;
    const point = nodeIndex.get(m.nodeId);
    if (!point) continue;

    // Apply learned per-(device, node) bias correction. Captures
    // device-specific antenna/body effects that node-to-node calibration
    // can't see. Uses pins placed by the user. When no pins are nearby,
    // confidence is low and shrinkBias() collapses to bias=1.0 (no-op).
    const lookup = lookupBias(store, device.id, m.nodeId, lookupPos);
    const effectiveBias = shrinkBias(lookup);
    if (effectiveBias > 0.1) {
      distance = distance / effectiveBias;
    }

    fixes.push({
      nodeId: m.nodeId,
      point,
      distance,
      distanceVariance: m.distanceVariance,
    });
  }

  return locator.solve(fixes, device.id);
}
