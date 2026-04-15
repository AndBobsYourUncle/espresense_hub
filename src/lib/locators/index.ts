import { lookupBias, shrinkBias } from "@/lib/calibration/device_bias";
import type { Config } from "@/lib/config";
import type { Point3D } from "@/lib/map/geometry";
import { getStore, type DeviceState } from "@/lib/state/store";
import { BayesianLocator } from "./bayesian";
import { BFGSLocator } from "./bfgs";
import { EnvironmentAwareLocator } from "./environment_aware";
import { MLELocator } from "./mle";
import { NadarayaWatsonLocator } from "./nadaraya_watson";
import { NearestNodeLocator } from "./nearest_node";
import { NelderMeadLocator } from "./nelder_mead";
import { OutlierRejectingLocator } from "./outlier";
import { PathAwareLocator } from "./path_aware";
import { RfRoomAwareLocator } from "./rf_room_aware";
import { RoomAwareLocator } from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

export type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Build the active locator from a Config.
 *
 * Active locator: **RoomAware**. Uses room-topology to weight pair
 * contributions (same-room pairs trusted, cross-wall pairs heavily
 * discounted) and finds position from the weighted centroid of the
 * pairwise circle-overlap centers. Doesn't consume per-pair calibration
 * fits — it operates on the firmware's reported distances directly,
 * with structural weighting on top.
 *
 * Side-by-side alternatives (for comparison view): IDW (Nadaraya-Watson),
 * Nelder-Mead, BFGS, MLE, NearestNode, PathAware (IDW + per-pair
 * distance correction), EnvironmentAware (BFGS with forward model
 * baked in), and optionally Bayesian when `bayesian.enabled` is set.
 *
 * PathAware and EnvironmentAware are the two fit-driven locators —
 * both consume per-pair `n_real` values and try to correct for path
 * attenuation. They're offered as alternatives rather than the active
 * locator because RoomAware's topology-based weighting has proven
 * more robust in practice (no fit bootstrap, no compounding errors
 * from bad n estimates). Including them here lets the comparison
 * view show how each approach lines up.
 */
export interface LocatorBundle {
  /** The user-facing locator (RoomAware). */
  active: Locator;
  /**
   * Every base locator we want to compute side-by-side on raw firmware
   * distances, so the UI can compare algorithms against the active
   * RoomAware result.
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
  // PathAware and EnvironmentAware consume per-pair calibration fits to
  // refine positions. Neither is the active locator — they're included
  // here so the side-by-side comparison view can show how each fit-
  // driven approach lines up against RoomAware's topology-only output.
  // PathAware wraps IDW and iteratively corrects distances; EnvAware
  // runs BFGS with the forward model baked in. Outlier wrapper applied
  // so flaky nodes don't drag either solver into the wrong room.
  const pathAware = new OutlierRejectingLocator(
    new PathAwareLocator(new NadarayaWatsonLocator()),
  );
  const envAware = new OutlierRejectingLocator(new EnvironmentAwareLocator());

  // RF-aware version of RoomAware. Uses the RF map's continuous
  // attenuation to weight cross-room circle overlaps instead of the
  // ternary 1.0/0.8/0.005. Compared side-by-side here so the user can
  // verify it before promoting it to the active locator.
  const rfRoomAware = new OutlierRejectingLocator(new RfRoomAwareLocator());

  const allBases: Locator[] = [
    idw,
    nm,
    bfgs,
    mle,
    nearest,
    pathAware,
    envAware,
    rfRoomAware,
  ];
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
