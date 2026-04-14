import type { Config, Floor } from "@/lib/config";
import { openToId } from "@/lib/config/schema";

/**
 * A directed adjacency map keyed by room id. Symmetric by construction —
 * every edge (A, B) is mirrored as (B, A) — so `graph.get(a)?.has(b)` is a
 * constant-time "can a person walk from A directly to B" check.
 *
 * Edges come from two config sources, both treated as "human-passable":
 *
 *   1. `open_to` entries on a room — explicit door / open passage.
 *   2. `floor_area` groupings — every room sharing the same tag forms a
 *      fully-connected subgraph. Models open-plan layouts where
 *      kitchen/dining/living have no walls between them.
 *
 * Notably *excludes* the auto-detected "shared polygon edge" that
 * `RoomAwareLocator` uses for trust weighting. A shared wall is NOT a
 * walkable transition — the user explicitly declares doors via `open_to`.
 */
export type RoomGraph = Map<string, Set<string>>;

/** Build a fresh graph from all rooms across all floors. */
export function buildRoomGraph(floors: readonly Floor[]): RoomGraph {
  const graph: RoomGraph = new Map();
  const allRooms = floors.flatMap((f) => f.rooms);

  // Resolve an `open_to` reference (which may be id OR human name) to a
  // canonical room id.
  const idByLabel = new Map<string, string>();
  for (const r of allRooms) {
    if (!r.id) continue;
    idByLabel.set(r.id, r.id);
    if (r.name) idByLabel.set(r.name, r.id);
  }
  const resolve = (label: string): string | null => idByLabel.get(label) ?? null;

  const addEdge = (a: string, b: string): void => {
    if (a === b) return;
    let aNeighbors = graph.get(a);
    if (!aNeighbors) {
      aNeighbors = new Set();
      graph.set(a, aNeighbors);
    }
    aNeighbors.add(b);
    let bNeighbors = graph.get(b);
    if (!bNeighbors) {
      bNeighbors = new Set();
      graph.set(b, bNeighbors);
    }
    bNeighbors.add(a);
  };

  // open_to — explicit edges. Symmetric: "A open to B" implies both
  // directions even if B's config doesn't list A.
  for (const r of allRooms) {
    if (!r.id) continue;
    for (const entry of r.open_to) {
      const otherId = resolve(openToId(entry));
      if (otherId) addEdge(r.id, otherId);
    }
  }

  // floor_area — fully-connected subgraph per tag.
  const byTag = new Map<string, string[]>();
  for (const r of allRooms) {
    if (!r.id || !r.floor_area) continue;
    const list = byTag.get(r.floor_area) ?? [];
    list.push(r.id);
    byTag.set(r.floor_area, list);
  }
  for (const ids of byTag.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addEdge(ids[i], ids[j]);
      }
    }
  }

  return graph;
}

/** True iff `a` and `b` are distinct rooms connected by a direct edge. */
export function areAdjacent(graph: RoomGraph, a: string, b: string): boolean {
  if (a === b) return false; // same room — caller should special-case
  return graph.get(a)?.has(b) ?? false;
}

/**
 * Per-process cache keyed by Config reference. Because `setCurrentConfig`
 * replaces the live config object entirely on every save, identity-equality
 * on the config pointer is a valid cache invalidation signal — no hook into
 * the save path needed.
 */
const globalForGraph = globalThis as unknown as {
  __espresenseRoomGraphCache?: { config: Config; graph: RoomGraph };
};

/** Return a cached RoomGraph for `config`, rebuilding it on config change. */
export function getRoomGraph(config: Config): RoomGraph {
  const cached = globalForGraph.__espresenseRoomGraphCache;
  if (cached && cached.config === config) return cached.graph;
  const graph = buildRoomGraph(config.floors);
  globalForGraph.__espresenseRoomGraphCache = { config, graph };
  return graph;
}
