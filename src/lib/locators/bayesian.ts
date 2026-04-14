import { getCurrentConfigOrNull } from "@/lib/config/current";
import { OUTSIDE_ROOM_ID, openToDoor, openToId, openToWidth } from "@/lib/config/schema";
import type { Config, Room } from "@/lib/config";
import { getRoomGraph, type RoomGraph } from "@/lib/presence/room_graph";
import { pointInPolygon } from "./room_aware";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Default door width when `open_to[].width` isn't specified. Matches
 * the renderer's visual default and the "standard interior door ≈ 32 in"
 * convention.
 */
const DEFAULT_DOOR_WIDTH = 0.8;

/**
 * Transition-model tuning. Chosen to reproduce roughly the Phase 3b
 * stay-prob of ~0.85 when the device is in the middle of a room, while
 * giving wider / nearer doors proportionally more transition probability.
 */
const STAY_WEIGHT = 1.6; // ≈ 2× default door width
const TELEPORT_WEIGHT = 0.001; // small non-zero so stuck states can recover
const PROX_SIGMA = 1.5; // m — characteristic distance for door-proximity falloff
const PROX_FLOOR = 0.05; // minimum proximity factor (away from any door)

/** Per-edge door/width data, looked up during transition-matrix build. */
interface EdgeData {
  door?: readonly [number, number];
  width: number;
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
   * Edge data (door position + width) keyed by sorted-pair edge key, e.g.
   * `"bedroom|living"`. Populated from `open_to` entries in `syncConfig`;
   * graph edges with no entry (e.g. `floor_area` cliques, door-less
   * `open_to` strings) fall through to defaults in `edgeWeight`.
   */
  private edgeData: Map<string, EdgeData> = new Map();

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

    const topState = argmax(posterior);
    const constrained = this.constrainToRoom(raw, topState);
    return { ...constrained, algorithm: this.name };
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
          width: openToWidth(entry) ?? DEFAULT_DOOR_WIDTH,
        });
      }
    }

    // Topology changed — any old posteriors reference stale room ids.
    // Clearing them lets the next sighting re-seed cleanly.
    this.posteriors.clear();
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
   * Weight assignment before normalization:
   *
   *   - Stay (`from == to`): `STAY_WEIGHT` — roughly 2× a default door
   *     width, producing ~0.87 stay-prob when no doors are nearby.
   *   - Graph-adjacent with explicit door: `width × proximity(pos, door)`.
   *     The proximity factor is `max(ε, exp(−dist/σ))`, so the transition
   *     weight spikes when the device is near that specific door, while
   *     other adjacent transitions decay to their floor weight.
   *   - Graph-adjacent without door (floor_area cliques, or door-less
   *     open_to strings): `DEFAULT_WIDTH × 1.0` — we have no location
   *     information so the edge is always available at baseline weight.
   *   - Non-adjacent ("teleport"): `TELEPORT_WEIGHT` — tiny but non-zero
   *     so a badly-committed state can eventually recover with enough
   *     contrary evidence.
   */
  private buildTransitionRow(
    from: string,
    obsX: number,
    obsY: number,
  ): Map<string, number> {
    const row = new Map<string, number>();
    row.set(from, STAY_WEIGHT);
    const neighbors = this.graph.get(from) ?? new Set<string>();
    for (const to of this.states) {
      if (to === from) continue;
      if (neighbors.has(to)) {
        row.set(to, this.edgeWeight(from, to, obsX, obsY));
      } else {
        row.set(to, TELEPORT_WEIGHT);
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
    const width = edge?.width ?? DEFAULT_DOOR_WIDTH;
    if (!edge?.door) return width; // no door info → always available at baseline
    const dx = obsX - edge.door[0];
    const dy = obsY - edge.door[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    const prox = Math.max(PROX_FLOOR, Math.exp(-d / PROX_SIGMA));
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

  /**
   * If the raw position is outside the most-likely room's polygon, project
   * it to the nearest point on the polygon boundary. Keeps the visible dot
   * glued to legal interior geometry — the user never sees the Bayesian
   * tracker "ghost through a wall."
   */
  private constrainToRoom(raw: LocatorResult, roomId: string): LocatorResult {
    if (roomId === OUTSIDE_ROOM_ID) return raw;
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room?.points) return raw;
    if (pointInPolygon([raw.x, raw.y], room.points)) return raw;
    const [px, py] = closestPointOnPolygon(raw.x, raw.y, room.points);
    return { ...raw, x: px, y: py };
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
