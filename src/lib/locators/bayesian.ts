import { getCurrentConfigOrNull } from "@/lib/config/current";
import { OUTSIDE_ROOM_ID, openToDoor, openToId, openToWidth } from "@/lib/config/schema";
import type { Config, Room } from "@/lib/config";
import { getRoomGraph, type RoomGraph } from "@/lib/presence/room_graph";
import { pointInPolygon } from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

/** Per-edge door/width data, looked up during transition-matrix build. */
interface EdgeData {
  door?: readonly [number, number];
  width: number;
}

/**
 * Transition-model tuning, mirrored from `config.bayesian.*` on each
 * syncConfig call so the forward step can read them without hitting the
 * config object repeatedly. All values are live-reloadable via the
 * Settings UI.
 */
interface TuningParams {
  stayWeight: number;
  teleportWeight: number;
  outsideTeleportWeight: number;
  proximitySigmaM: number;
  proximityFloor: number;
  defaultDoorWidth: number;
  commitDwellMs: number;
  commitMargin: number;
  blendThreshold: number;
}

/**
 * Per-device committed-room state. The posterior's argmax is the
 * *candidate* room; the committed room is what the locator actually
 * emits. Requires the candidate to dominate for `commitDwellMs` OR
 * exceed the committed room's posterior by `commitMargin` before
 * promoting — filters out brief argmax spikes from RSSI noise as the
 * device walks past a room's door.
 */
interface CommitState {
  /** Currently-emitted room id (may be OUTSIDE_ROOM_ID). */
  committedRoom: string;
  /** Pending new argmax, or null if no pending change. */
  candidateRoom: string | null;
  /** When the current candidate first became argmax (ms). */
  candidateSince: number;
}

/**
 * Per-device posterior over the room state space. Keys are room ids plus
 * the well-known `OUTSIDE_ROOM_ID`; values sum to ~1.
 */
type Posterior = Map<string, number>;

/**
 * Graph-aware Bayesian room tracker — implemented as a locator so it slots
 * into the existing alternatives view on the map and can eventually become
 * the active locator without changing the rest of the pipeline.
 *
 * Algorithm:
 *
 *   1. Delegate to `inner.solve(fixes, deviceId)` to get an observation
 *      (a real-valued position estimate — typically the shared RoomAware
 *      locator instance that also drives the active map position). We
 *      treat whatever this returns as the *observation*; the Bayesian
 *      layer does NOT re-do trilateration.
 *   2. Maintain a per-device posterior `P(room | observations so far)` as
 *      a discrete distribution over rooms ∪ {outside}.
 *   3. On each solve, run one step of the forward algorithm:
 *         predicted[b] = Σ_a prior[a] × T[a][b]       // transition
 *         posterior[r] ∝ predicted[r] × L(obs | r)    // update
 *      where T is the graph-driven transition matrix and L is a simple
 *      point-in-polygon observation likelihood with exponential falloff
 *      outside the polygon.
 *   4. Pick the most-likely room, project the raw position into that
 *      room's polygon if it's drifted outside, and emit that as output.
 *
 * Key behavior this buys us:
 *
 *   - Graph-invalid "teleport" transitions (e.g. Master Bedroom → Office
 *     without crossing Hallway) get a vanishingly small transition prior,
 *     so a single noisy reading can't flip the room assignment.
 *   - The visible dot on the map stays glued to the most-likely room's
 *     polygon — the device never "ghosts through a wall" when raw RSSI
 *     wobbles.
 *   - `outside` is a first-class state: a device can only transition to
 *     outside through rooms that declare `- id: outside` as an `open_to`
 *     entry (i.e. exterior doors).
 *
 * Not yet (Phase 3c+): using door positions / widths as transition priors
 * (a wider door → higher transition weight through that edge); using raw
 * per-node RSSI as the observation (instead of the inner locator's output)
 * for better accuracy in sparse-node setups.
 */
export class BayesianLocator implements Locator {
  readonly name = "bayesian";

  private readonly inner: Locator;

  /**
   * Topology snapshot. Rebuilt when the live config reference changes
   * (which happens on every Settings UI save via `setCurrentConfig`).
   */
  private configRef: Config | null = null;
  private rooms: Room[] = [];
  private graph: RoomGraph = new Map();
  private states: string[] = []; // room ids + OUTSIDE_ROOM_ID
  private neighborCount: Map<string, number> = new Map();

  /** Per-device posterior (includes `outside`). Cleared on config topology changes. */
  private posteriors: Map<string, Posterior> = new Map();

  /**
   * Per-device committed-room state, tracked alongside posterior.
   * Decouples "what room is the argmax right now" (transient) from
   * "what room are we reporting" (dwell-filtered).
   */
  private commitStates: Map<string, CommitState> = new Map();

  /**
   * Edge data (door position + width) keyed by sorted-pair edge key, e.g.
   * `"bedroom|living"`. Populated from `open_to` entries in `syncConfig`;
   * graph edges with no entry (e.g. `floor_area` cliques, door-less
   * `open_to` strings) fall through to defaults in `edgeWeight`.
   */
  private edgeData: Map<string, EdgeData> = new Map();

  /** Live tuning params (from `config.bayesian.*`). Refreshed on config change. */
  private tuning: TuningParams = {
    stayWeight: 1.6,
    teleportWeight: 0.001,
    outsideTeleportWeight: 0.001,
    proximitySigmaM: 1.5,
    proximityFloor: 0.05,
    defaultDoorWidth: 0.8,
    commitDwellMs: 2000,
    commitMargin: 0.15,
    blendThreshold: 0.05,
  };

  /**
   * All-pairs shortest graph distance in hops. `shortestPaths[a].get(b)`
   * is the number of open_to / floor_area edges between `a` and `b`, or
   * `undefined` when there's no path at all. Recomputed via BFS on each
   * topology change; for home-sized graphs (≤100 rooms) this is a
   * handful of milliseconds per reload.
   *
   * Used to scale the teleport weight by how many intermediate rooms
   * would have had to be missed for this transition to be plausible.
   * Adjacent rooms (distance 1) don't use teleport — they use edgeWeight.
   * Distance 2 = full teleport; distance k>2 falls off as (k−1)⁻² by
   * default.
   */
  private shortestPaths: Map<string, Map<string, number>> = new Map();

  constructor(inner: Locator) {
    this.inner = inner;
  }

  solve(fixes: readonly NodeFix[], deviceId?: string): LocatorResult | null {
    this.syncConfig();

    const raw = this.inner.solve(fixes, deviceId);
    if (!raw) return null;

    // Without a deviceId we can't track state — pass inner's result
    // through, just tagged with our name for the alternatives view.
    if (!deviceId || this.states.length === 0) {
      return { ...raw, algorithm: this.name };
    }

    const posterior = this.forwardStep(
      this.posteriors.get(deviceId),
      raw.x,
      raw.y,
    );
    this.posteriors.set(deviceId, posterior);

    // Apply committed-room hysteresis to the argmax — the *output* room
    // only flips after the candidate has dwelt OR has decisively pulled
    // ahead of the currently-committed room.
    const committedRoom = this.updateCommit(deviceId, posterior);

    // Posterior-weighted blended position — smoothly interpolates as
    // the posterior shifts across a door boundary instead of snapping
    // when the argmax flips.
    const blended = this.blendedPosition(raw, posterior);

    return {
      ...raw,
      x: blended.x,
      y: blended.y,
      algorithm: this.name,
      roomId: committedRoom,
    };
  }

  /**
   * Update the per-device committed room based on the posterior's
   * argmax. Implements two complementary gates:
   *
   *   1. Dwell: a new argmax must remain top for `commit_dwell_ms`
   *      before it flips the committed room. Filters out brief
   *      posterior spikes.
   *   2. Margin: if the new argmax's probability exceeds the committed
   *      room's probability by `commit_margin`, it flips immediately.
   *      Lets genuine decisive transitions commit fast.
   *
   * Returns the committed room id (may be OUTSIDE_ROOM_ID).
   */
  private updateCommit(deviceId: string, posterior: Posterior): string {
    const topRoom = argmax(posterior);
    const now = Date.now();
    const existing = this.commitStates.get(deviceId);

    // First sighting — commit immediately to the initial argmax.
    if (!existing) {
      this.commitStates.set(deviceId, {
        committedRoom: topRoom,
        candidateRoom: null,
        candidateSince: 0,
      });
      return topRoom;
    }

    // Argmax matches committed — no candidate to track.
    if (topRoom === existing.committedRoom) {
      existing.candidateRoom = null;
      existing.candidateSince = 0;
      return existing.committedRoom;
    }

    // Argmax differs from committed. Start or continue tracking a
    // candidate, and check both commit gates.
    if (existing.candidateRoom !== topRoom) {
      existing.candidateRoom = topRoom;
      existing.candidateSince = now;
    }

    const committedProb = posterior.get(existing.committedRoom) ?? 0;
    const candidateProb = posterior.get(topRoom) ?? 0;
    const marginMet =
      candidateProb - committedProb >= this.tuning.commitMargin;
    const dwellMet =
      now - existing.candidateSince >= this.tuning.commitDwellMs;

    if (marginMet || dwellMet) {
      existing.committedRoom = topRoom;
      existing.candidateRoom = null;
      existing.candidateSince = 0;
    }
    return existing.committedRoom;
  }

  /**
   * Posterior-weighted blended position. For each room whose posterior
   * is above `blend_threshold`, project the raw observation into that
   * room's polygon (or, for OUTSIDE, use raw as-is), then take the
   * weighted average.
   *
   * In practice the posterior is dominated by one or two rooms, so the
   * blend is almost always between adjacent rooms. As the posterior
   * shifts across a door, the blended position slides continuously
   * across the doorway instead of snapping when the argmax flips.
   *
   * Threshold filters out a long tail of tiny posteriors (≤ 5% each by
   * default) that would otherwise drag the output toward distant rooms.
   */
  private blendedPosition(
    raw: { x: number; y: number },
    posterior: Posterior,
  ): { x: number; y: number } {
    let wx = 0;
    let wy = 0;
    let total = 0;
    for (const [roomId, prob] of posterior) {
      if (prob < this.tuning.blendThreshold) continue;
      if (roomId === OUTSIDE_ROOM_ID) {
        // No polygon for outside — contribute the raw position as-is.
        wx += prob * raw.x;
        wy += prob * raw.y;
        total += prob;
        continue;
      }
      const room = this.rooms.find((r) => r.id === roomId);
      if (!room?.points) continue;
      const inside = pointInPolygon([raw.x, raw.y], room.points);
      const [px, py] = inside
        ? [raw.x, raw.y]
        : closestPointOnPolygon(raw.x, raw.y, room.points);
      wx += prob * px;
      wy += prob * py;
      total += prob;
    }
    if (total <= 0) return { x: raw.x, y: raw.y };
    return { x: wx / total, y: wy / total };
  }

  /** Clear all per-device posterior state. Currently unused externally. */
  clearState(): void {
    this.posteriors.clear();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private syncConfig(): void {
    const current = getCurrentConfigOrNull();
    if (!current || current === this.configRef) return;
    this.configRef = current;
    // Keep only rooms with an id and a usable polygon — the rest can't
    // participate in point-in-polygon tests or serve as states.
    this.rooms = current.floors
      .flatMap((f) => f.rooms)
      .filter((r) => Boolean(r.id && r.points && r.points.length >= 3));
    this.graph = getRoomGraph(current);
    // `r.id` is guaranteed by the filter above; the schema type still
    // lists it as optional so the assertion is necessary.
    this.states = [...this.rooms.map((r) => r.id as string), OUTSIDE_ROOM_ID];
    this.neighborCount.clear();
    for (const s of this.states) {
      this.neighborCount.set(s, this.graph.get(s)?.size ?? 0);
    }

    // Live-reloaded tuning params — mirror them here so the hot per-solve
    // path doesn't hit `config.bayesian.*` on every row build.
    this.tuning = {
      stayWeight: current.bayesian.stay_weight,
      teleportWeight: current.bayesian.teleport_weight,
      outsideTeleportWeight: current.bayesian.outside_teleport_weight,
      proximitySigmaM: current.bayesian.proximity_sigma_m,
      proximityFloor: current.bayesian.proximity_floor,
      defaultDoorWidth: current.bayesian.default_door_width_m,
      commitDwellMs: current.bayesian.commit_dwell_ms,
      commitMargin: current.bayesian.commit_margin,
      blendThreshold: current.bayesian.blend_threshold,
    };

    // Populate per-edge door/width data from every room's `open_to`. Edges
    // implied by `floor_area` (clique adjacency) are intentionally omitted
    // — they have no specific door location or width; `edgeWeight` uses
    // defaults (always-available, standard width) for any edge not found here.
    this.edgeData.clear();
    const idByLabel = new Map<string, string>();
    for (const r of this.rooms) {
      if (!r.id) continue;
      idByLabel.set(r.id, r.id);
      if (r.name) idByLabel.set(r.name, r.id);
    }
    for (const r of this.rooms) {
      const aId = r.id;
      if (!aId) continue;
      for (const entry of r.open_to) {
        const rawId = openToId(entry);
        const bId = rawId === OUTSIDE_ROOM_ID ? OUTSIDE_ROOM_ID : idByLabel.get(rawId);
        if (!bId || bId === aId) continue;
        this.edgeData.set(edgeKey(aId, bId), {
          door: openToDoor(entry),
          width: openToWidth(entry) ?? this.tuning.defaultDoorWidth,
        });
      }
    }

    // All-pairs shortest path via BFS. O(N*(N+E)); trivially fast for
    // home-sized graphs. Consumed by `buildTransitionRow` to scale the
    // teleport weight by hop distance — rooms physically far apart in
    // the graph get proportionally smaller non-adjacent probabilities,
    // eliminating the "Kitchen → Office in one tick" bug where flat
    // teleport weight treated all non-adjacent transitions as equally
    // plausible.
    this.shortestPaths.clear();
    for (const start of this.states) {
      const dist = new Map<string, number>();
      dist.set(start, 0);
      const queue: string[] = [start];
      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        const currDist = dist.get(curr) ?? 0;
        const neighbors = this.graph.get(curr) ?? new Set<string>();
        for (const next of neighbors) {
          if (!dist.has(next)) {
            dist.set(next, currDist + 1);
            queue.push(next);
          }
        }
      }
      this.shortestPaths.set(start, dist);
    }

    // Topology changed — any old posteriors reference stale room ids.
    // Clearing them lets the next sighting re-seed cleanly.
    this.posteriors.clear();
    this.commitStates.clear();
  }

  private forwardStep(
    prior: Posterior | undefined,
    obsX: number,
    obsY: number,
  ): Posterior {
    // Predict: predicted[b] = Σ_a prior[a] × T[a][b]. The transition
    // matrix row for each state `a` is computed fresh each tick, because
    // it depends on the observation's proximity to each outbound door.
    const predicted = new Map<string, number>();
    if (!prior) {
      // Uniform prior on first sighting.
      const uniform = 1 / this.states.length;
      for (const s of this.states) predicted.set(s, uniform);
    } else {
      for (const from of this.states) {
        const prev = prior.get(from);
        if (!prev) continue;
        const row = this.buildTransitionRow(from, obsX, obsY);
        for (const [to, t] of row) {
          predicted.set(to, (predicted.get(to) ?? 0) + prev * t);
        }
      }
    }

    // Update: posterior[r] ∝ predicted[r] × likelihood(obs | r), then
    // normalize to sum to 1.
    const posterior = new Map<string, number>();
    let Z = 0;
    for (const s of this.states) {
      const l = this.observationLikelihood(obsX, obsY, s);
      const p = (predicted.get(s) ?? 0) * l;
      posterior.set(s, p);
      Z += p;
    }
    if (Z > 0) {
      for (const [k, v] of posterior) posterior.set(k, v / Z);
    } else {
      // Degenerate — no state has any support. Shouldn't happen with
      // the floor `outside` likelihood, but fall back to uniform so we
      // recover on the next tick.
      const uniform = 1 / this.states.length;
      for (const s of this.states) posterior.set(s, uniform);
    }
    return posterior;
  }

  /**
   * Build the row of the transition matrix from `from` to every state,
   * conditioned on the current observation position. Weights are then
   * normalized so the row sums to 1.
   *
   * Weight assignment before normalization (all constants are
   * live-reloadable via `config.bayesian.*`):
   *
   *   - Stay (`from == to`): `stay_weight` — roughly 2× default door
   *     width, producing ~0.87 stay-prob when no doors are nearby.
   *   - Graph-adjacent with explicit door: `width × proximity(pos, door)`.
   *     The proximity factor is `max(proximity_floor, exp(−d/σ))` with
   *     σ = `proximity_sigma_m`, so the transition weight spikes when
   *     the device is near that specific door.
   *   - Graph-adjacent without door (floor_area cliques, or door-less
   *     open_to strings): `default_door_width_m × 1.0` — no location
   *     information so the edge is always available at baseline weight.
   *   - Non-adjacent ("teleport"): `(base / (hops − 1)²)` where
   *     `hops` is the shortest graph distance from `from` to `to`. A
   *     2-hop transition (one intermediate room plausibly unobserved)
   *     gets the full weight; 3 hops → ¼; 4 hops → 1/9; unreachable
   *     pairs → 0. Matches the physical intuition that missing ONE
   *     room is plausible but missing four is not. `base` is
   *     `teleport_weight` for interior-to-interior transitions, or
   *     `outside_teleport_weight` when either side is the `outside`
   *     state. Both default to 0.001 for consistency; set
   *     `outside_teleport_weight` to 0 once exterior doors are fully
   *     mapped to strictly require declared doors for outside
   *     transitions.
   */
  private buildTransitionRow(
    from: string,
    obsX: number,
    obsY: number,
  ): Map<string, number> {
    const row = new Map<string, number>();
    row.set(from, this.tuning.stayWeight);
    const neighbors = this.graph.get(from) ?? new Set<string>();
    const fromOutside = from === OUTSIDE_ROOM_ID;
    const distances = this.shortestPaths.get(from);
    for (const to of this.states) {
      if (to === from) continue;
      if (neighbors.has(to)) {
        row.set(to, this.edgeWeight(from, to, obsX, obsY));
        continue;
      }
      // Non-adjacent transition. Two different tuning knobs apply
      // depending on whether outside is involved — interior-only
      // non-adjacency uses `teleport_weight`; anything touching the
      // outside state uses `outside_teleport_weight` (default 0 =
      // strict: only reachable via declared exterior doors).
      const involvesOutside = fromOutside || to === OUTSIDE_ROOM_ID;
      const baseWeight = involvesOutside
        ? this.tuning.outsideTeleportWeight
        : this.tuning.teleportWeight;
      if (baseWeight <= 0) {
        row.set(to, 0);
        continue;
      }
      // Graph-distance-scaled teleport. `hops` ≥ 2 here (hops=1 would
      // be an adjacent neighbor, handled above); hops=undefined means
      // no path exists (disconnected graph component) → zero weight.
      const hops = distances?.get(to);
      if (hops == null || hops < 2) {
        row.set(to, 0);
      } else {
        const falloff = (hops - 1) * (hops - 1);
        row.set(to, baseWeight / falloff);
      }
    }

    // Normalize.
    let Z = 0;
    for (const v of row.values()) Z += v;
    if (Z > 0) {
      for (const [k, v] of row) row.set(k, v / Z);
    }
    return row;
  }

  /**
   * Unnormalized weight for a specific graph-adjacent transition, factoring
   * in door width and proximity to the observation position.
   */
  private edgeWeight(
    from: string,
    to: string,
    obsX: number,
    obsY: number,
  ): number {
    const edge = this.edgeData.get(edgeKey(from, to));
    const width = edge?.width ?? this.tuning.defaultDoorWidth;
    if (!edge?.door) return width; // no door info → always available at baseline
    const dx = obsX - edge.door[0];
    const dy = obsY - edge.door[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    const prox = Math.max(
      this.tuning.proximityFloor,
      Math.exp(-d / this.tuning.proximitySigmaM),
    );
    return width * prox;
  }

  /**
   * P(observation position | current room = r). Simple model for Phase 3b:
   *
   *   - Real room: likelihood 1.0 when position is inside its polygon,
   *     exponential decay with distance to the nearest polygon edge when
   *     outside. The decay characteristic length is 1 m.
   *
   *   - OUTSIDE: likelihood is high (0.5) when the position is outside
   *     every polygon, and low (0.01) when it's inside some polygon.
   *     Intentionally lower than a well-matched real room's likelihood so
   *     the posterior prefers "in this room" over "outside" when the
   *     evidence is ambiguous — outside should require *sustained*
   *     evidence of being off-plan.
   */
  private observationLikelihood(
    obsX: number,
    obsY: number,
    roomId: string,
  ): number {
    if (roomId === OUTSIDE_ROOM_ID) {
      for (const room of this.rooms) {
        if (pointInPolygon([obsX, obsY], room.points!)) return 0.01;
      }
      return 0.5;
    }
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room?.points) return 0.001;
    if (pointInPolygon([obsX, obsY], room.points)) return 1.0;
    const d = distanceToPolygon(obsX, obsY, room.points);
    return Math.exp(-d);
  }

}

// ─── Geometry helpers ─────────────────────────────────────────────────────

function distanceToPolygon(
  px: number,
  py: number,
  polygon: ReadonlyArray<readonly [number, number]>,
): number {
  let bestSq = Infinity;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const dSq = distanceToSegmentSq(px, py, polygon[i], polygon[j]);
    if (dSq < bestSq) bestSq = dSq;
  }
  return Math.sqrt(bestSq);
}

function closestPointOnPolygon(
  px: number,
  py: number,
  polygon: ReadonlyArray<readonly [number, number]>,
): [number, number] {
  let bestSq = Infinity;
  let best: [number, number] = [px, py];
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = closestPointOnSegment(px, py, polygon[i], polygon[j]);
    const dx = p[0] - px;
    const dy = p[1] - py;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      best = p;
    }
  }
  return best;
}

function distanceToSegmentSq(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const [cx, cy] = closestPointOnSegment(px, py, a, b);
  const dx = cx - px;
  const dy = cy - py;
  return dx * dx + dy * dy;
}

function closestPointOnSegment(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return [a[0], a[1]];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Edge key: sorted alphabetically so A→B and B→A share the same entry. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function argmax(posterior: Posterior): string {
  let best = "";
  let bestP = -Infinity;
  for (const [s, p] of posterior) {
    if (p > bestP) {
      best = s;
      bestP = p;
    }
  }
  return best;
}
