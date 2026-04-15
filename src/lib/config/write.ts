import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Document, isMap, isSeq, parseDocument } from "yaml";
import { resolveConfigPath } from "./load";
import { ConfigSchema, openToId, slugify } from "./schema";

/**
 * Round a coordinate to the precision the map tool can realistically produce.
 * 3 decimals = 1 mm, already finer than the pixel → meters conversion on a
 * typical floorplan. Keeps `config.yaml` legible — `5.500` instead of
 * `5.499930648803712` from rounding artifacts.
 */
function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build a YAML Node for an `open_to` array where each entry's `door`
 * tuple is written as an inline `[x, y]` flow sequence — matching the
 * style used elsewhere in `config.yaml` for polygon points and floor
 * bounds. Without this, the default serializer writes the 2-element
 * door as a block sequence spread over three lines, which is noisy.
 */
function buildOpenToNode(
  doc: Document,
  openTo: Array<string | { id: string; door?: [number, number]; width?: number }>,
): unknown {
  const node = doc.createNode(
    openTo.map((entry) => {
      if (typeof entry === "string") return entry;
      const obj: Record<string, unknown> = { id: entry.id };
      if (entry.door) {
        obj.door = [roundCoord(entry.door[0]), roundCoord(entry.door[1])];
      }
      if (entry.width != null && Number.isFinite(entry.width)) {
        obj.width = roundCoord(entry.width);
      }
      return obj;
    }),
  );
  // Walk the resulting sequence and flip the door child arrays to flow style.
  if (isSeq(node)) {
    for (const item of node.items) {
      if (!isMap(item)) continue;
      const doorItem = item.get("door", true);
      if (isSeq(doorItem)) doorItem.flow = true;
    }
  }
  return node;
}

/**
 * Round-trip-safe writer for `config.yaml`. Uses the `yaml` Document API so
 * comments and formatting survive an edit, validates the result with the
 * shared zod schema, and writes atomically (temp file + rename) so a partial
 * write can never corrupt the on-disk config.
 */

export class ConfigWriteError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not-found"
      | "parse-failed"
      | "node-not-found"
      | "invalid-after-edit"
      | "io-failed",
  ) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

/**
 * Multiply the X and Y components of every spatial coordinate in the config
 * (node points, floor bounds, room polygon vertices) by `factor`. Z is left
 * untouched — vertical mounting heights and ceiling heights are set
 * independently of horizontal map scale.
 *
 * Used by the ruler-based scale calibration: measure a wall, compare to
 * config, apply the resulting ratio to the whole map in one shot.
 */
export interface ScaleResult {
  scaledNodes: number;
  scaledRooms: number;
  scaledFloors: number;
}

export async function scaleConfig(factor: number): Promise<ScaleResult> {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new ConfigWriteError(
      "factor must be a positive finite number",
      "invalid-after-edit",
    );
  }

  const configPath = resolveConfigPath();

  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigWriteError(
      `Could not read config at ${configPath}`,
      "not-found",
    );
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new ConfigWriteError(
      `Existing config has parse errors: ${doc.errors[0].message}`,
      "parse-failed",
    );
  }

  const isFiniteNum = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);

  let scaledNodes = 0;
  let scaledRooms = 0;
  let scaledFloors = 0;

  // Scale node points (3D — preserve Z).
  const nodes = doc.get("nodes");
  if (isSeq(nodes)) {
    for (let i = 0; i < nodes.items.length; i++) {
      const point = doc.getIn(["nodes", i, "point"]) as unknown;
      if (
        Array.isArray(point) &&
        point.length === 3 &&
        point.every(isFiniteNum)
      ) {
        doc.setIn(
          ["nodes", i, "point"],
          [point[0] * factor, point[1] * factor, point[2]],
        );
        scaledNodes++;
      }
    }
  }

  // Scale floor bounds + room polygon vertices.
  const floors = doc.get("floors");
  if (isSeq(floors)) {
    for (let f = 0; f < floors.items.length; f++) {
      // bounds: array of 3D points; preserve Z.
      const bounds = doc.getIn(["floors", f, "bounds"]) as unknown;
      if (Array.isArray(bounds)) {
        const newBounds = bounds.map((b) => {
          if (Array.isArray(b) && b.length === 3 && b.every(isFiniteNum)) {
            return [b[0] * factor, b[1] * factor, b[2]];
          }
          return b;
        });
        doc.setIn(["floors", f, "bounds"], newBounds);
      }

      // rooms[].points: array of 2D points.
      const rooms = doc.getIn(["floors", f, "rooms"]) as unknown;
      if (Array.isArray(rooms)) {
        for (let r = 0; r < rooms.length; r++) {
          const points = doc.getIn([
            "floors",
            f,
            "rooms",
            r,
            "points",
          ]) as unknown;
          if (Array.isArray(points)) {
            const newPoints = points.map((p) => {
              if (Array.isArray(p) && p.length === 2 && p.every(isFiniteNum)) {
                return [p[0] * factor, p[1] * factor];
              }
              return p;
            });
            doc.setIn(
              ["floors", f, "rooms", r, "points"],
              newPoints,
            );
            scaledRooms++;
          }
        }
      }

      scaledFloors++;
    }
  }

  // Round-trip + revalidate before writing.
  const newYaml = doc.toString();
  const reparseDoc = parseDocument(newYaml);
  if (reparseDoc.errors.length > 0) {
    throw new ConfigWriteError(
      `Internal: scaled YAML failed to round-trip parse: ${reparseDoc.errors[0].message}`,
      "invalid-after-edit",
    );
  }
  const validation = ConfigSchema.safeParse(reparseDoc.toJS());
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "(root)";
    throw new ConfigWriteError(
      `Scaled config failed validation at ${issuePath}: ${issue?.message ?? "unknown"}`,
      "invalid-after-edit",
    );
  }

  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, newYaml, "utf8");
    await rename(tmpPath, configPath);
  } catch (err) {
    throw new ConfigWriteError(
      `Failed to write config: ${(err as Error).message}`,
      "io-failed",
    );
  }

  return { scaledNodes, scaledRooms, scaledFloors };
}

/**
 * Replace the entire config.yaml with `yamlText`. Validates the new content
 * with the shared zod schema before writing — invalid YAML is rejected with
 * a precise error pointing at the failing field, so the caller can show it
 * to the user and the on-disk file is never left in a broken state.
 */
export interface WriteRawResult {
  configPath: string;
  bytes: number;
}

export async function writeRawConfig(
  yamlText: string,
): Promise<WriteRawResult> {
  const configPath = resolveConfigPath();

  // Parse first — better to surface "your YAML doesn't parse" before the
  // schema check chases shadows.
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    throw new ConfigWriteError(
      `YAML parse error: ${e.message}`,
      "parse-failed",
    );
  }

  const validation = ConfigSchema.safeParse(doc.toJS());
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "(root)";
    throw new ConfigWriteError(
      `Validation failed at ${issuePath}: ${issue?.message ?? "unknown"}`,
      "invalid-after-edit",
    );
  }

  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, yamlText, "utf8");
    await rename(tmpPath, configPath);
  } catch (err) {
    throw new ConfigWriteError(
      `Failed to write config: ${(err as Error).message}`,
      "io-failed",
    );
  }

  return { configPath, bytes: Buffer.byteLength(yamlText, "utf8") };
}

/** Read the raw YAML text of config.yaml without parsing. */
export async function readRawConfig(): Promise<{
  configPath: string;
  yaml: string;
}> {
  const configPath = resolveConfigPath();
  let yaml: string;
  try {
    yaml = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigWriteError(
        `Config file does not exist at ${configPath}`,
        "not-found",
      );
    }
    throw new ConfigWriteError(
      `Could not read config at ${configPath}: ${(err as Error).message}`,
      "io-failed",
    );
  }
  return { configPath, yaml };
}

/**
 * Update the `open_to` and optionally `floor_area` of a room.
 *
 * `removeFromRooms` is an optional list of OTHER room ids in the same floor
 * whose `open_to` should have `roomId` removed. Used for bidirectional
 * cleanup: when the user unchecks a connection that was stored in the OTHER
 * room's open_to (a reverse reference), this ensures the full edge is removed
 * rather than just the editing room's side.
 */
export async function updateRoomRelations(
  floorId: string,
  roomId: string,
  openTo: Array<string | { id: string; door?: [number, number]; width?: number }>,
  floorArea: string | null | undefined,
  removeFromRooms: string[] = [],
): Promise<void> {
  const configPath = resolveConfigPath();
  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigWriteError(
      `Could not read config at ${configPath}`,
      "not-found",
    );
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new ConfigWriteError(
      `Existing config has parse errors: ${doc.errors[0].message}`,
      "parse-failed",
    );
  }

  const floors = doc.get("floors");
  if (!isSeq(floors)) {
    throw new ConfigWriteError("Config has no `floors` sequence", "node-not-found");
  }

  let floorIdx = -1;
  for (let f = 0; f < floors.items.length; f++) {
    const item = floors.items[f];
    if (!isMap(item)) continue;
    const id = item.get("id");
    const name = item.get("name");
    const eid =
      typeof id === "string" && id.length > 0
        ? id
        : typeof name === "string"
          ? slugify(name)
          : null;
    if (eid === floorId) {
      floorIdx = f;
      break;
    }
  }
  if (floorIdx === -1) {
    throw new ConfigWriteError(`Floor "${floorId}" not found in config`, "node-not-found");
  }

  const rooms = doc.getIn(["floors", floorIdx, "rooms"]);
  if (!isSeq(rooms)) {
    throw new ConfigWriteError(
      `Floor "${floorId}" has no rooms sequence`,
      "node-not-found",
    );
  }

  let roomIdx = -1;
  for (let r = 0; r < rooms.items.length; r++) {
    const item = rooms.items[r];
    if (!isMap(item)) continue;
    const id = item.get("id");
    const name = item.get("name");
    const eid =
      typeof id === "string" && id.length > 0
        ? id
        : typeof name === "string"
          ? slugify(name)
          : null;
    if (eid === roomId) {
      roomIdx = r;
      break;
    }
  }
  if (roomIdx === -1) {
    throw new ConfigWriteError(
      `Room "${roomId}" not found in floor "${floorId}"`,
      "node-not-found",
    );
  }

  doc.setIn(
    ["floors", floorIdx, "rooms", roomIdx, "open_to"],
    buildOpenToNode(doc, openTo),
  );

  const roomNode = doc.getIn(["floors", floorIdx, "rooms", roomIdx]);
  if (isMap(roomNode)) {
    if (floorArea != null && floorArea.trim().length > 0) {
      roomNode.set("floor_area", floorArea.trim());
    } else {
      roomNode.delete("floor_area");
    }
  }

  // Remove `roomId` from any other rooms' open_to (reverse-ref cleanup).
  if (removeFromRooms.length > 0) {
    const removeSet = new Set(removeFromRooms);
    for (let r = 0; r < rooms.items.length; r++) {
      const item = rooms.items[r];
      if (!isMap(item)) continue;
      const id = item.get("id");
      const name = item.get("name");
      const eid =
        typeof id === "string" && id.length > 0
          ? id
          : typeof name === "string"
            ? slugify(name)
            : null;
      if (!eid || !removeSet.has(eid)) continue;
      const otherOpenTo = doc.getIn(["floors", floorIdx, "rooms", r, "open_to"]);
      if (!Array.isArray(otherOpenTo)) continue;
      // Filter out any entry whose id resolves to the editing roomId.
      // Entries may be strings or {id, door?} objects (mixed is fine).
      const filtered = (otherOpenTo as Array<string | { id: string; door?: [number, number]; width?: number }>).filter(
        (entry) => openToId(entry) !== roomId,
      );
      doc.setIn(
        ["floors", floorIdx, "rooms", r, "open_to"],
        buildOpenToNode(doc, filtered),
      );
    }
  }

  const newYaml = doc.toString();
  const reparseDoc = parseDocument(newYaml);
  if (reparseDoc.errors.length > 0) {
    throw new ConfigWriteError(
      `Internal: edited YAML failed to round-trip parse: ${reparseDoc.errors[0].message}`,
      "invalid-after-edit",
    );
  }
  const validation = ConfigSchema.safeParse(reparseDoc.toJS());
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "(root)";
    throw new ConfigWriteError(
      `Edited config failed validation at ${issuePath}: ${issue?.message ?? "unknown"}`,
      "invalid-after-edit",
    );
  }

  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, newYaml, "utf8");
    await rename(tmpPath, configPath);
  } catch (err) {
    throw new ConfigWriteError(
      `Failed to write config: ${(err as Error).message}`,
      "io-failed",
    );
  }
}

/** Replace the `presence.zones` array in config.yaml. */
export async function updatePresenceZones(zones: unknown[]): Promise<void> {
  const configPath = resolveConfigPath();
  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigWriteError(
      `Could not read config at ${configPath}`,
      "not-found",
    );
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new ConfigWriteError(
      `Existing config has parse errors: ${doc.errors[0].message}`,
      "parse-failed",
    );
  }

  // Ensure the `presence` mapping exists before setting a sub-key.
  if (!isMap(doc.get("presence"))) {
    doc.set("presence", doc.createNode({}));
  }
  doc.setIn(["presence", "zones"], zones);

  const newYaml = doc.toString();
  const reparseDoc = parseDocument(newYaml);
  if (reparseDoc.errors.length > 0) {
    throw new ConfigWriteError(
      `Internal: edited YAML failed to round-trip parse: ${reparseDoc.errors[0].message}`,
      "invalid-after-edit",
    );
  }
  const validation = ConfigSchema.safeParse(reparseDoc.toJS());
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "(root)";
    throw new ConfigWriteError(
      `Edited config failed validation at ${issuePath}: ${issue?.message ?? "unknown"}`,
      "invalid-after-edit",
    );
  }

  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, newYaml, "utf8");
    await rename(tmpPath, configPath);
  } catch (err) {
    throw new ConfigWriteError(
      `Failed to write config: ${(err as Error).message}`,
      "io-failed",
    );
  }
}

/**
 * Update the `rf:` block (or any subset of it) in config.yaml. Used by
 * the RF parameter fit's apply step — the user reviews fitted vs
 * configured values in the calibration UI and applies the ones they
 * trust. We surgically merge into the existing `rf:` mapping so
 * unchanged keys (e.g. `path_loss_exponent` if only walls were applied)
 * keep their existing comments and ordering.
 */
export async function updateRfParameters(
  params: Partial<{
    pathLossExponent: number;
    referenceRssi1m: number;
    wallAttenuationDb: number;
    exteriorWallAttenuationDb: number;
    doorAttenuationDb: number;
  }>,
): Promise<void> {
  const configPath = resolveConfigPath();
  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigWriteError(
      `Could not read config at ${configPath}`,
      "not-found",
    );
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new ConfigWriteError(
      `Existing config has parse errors: ${doc.errors[0].message}`,
      "parse-failed",
    );
  }

  if (!isMap(doc.get("rf"))) {
    doc.set("rf", doc.createNode({}));
  }
  const round = (n: number): number => Math.round(n * 100) / 100;
  if (params.pathLossExponent != null) {
    doc.setIn(["rf", "path_loss_exponent"], round(params.pathLossExponent));
  }
  if (params.referenceRssi1m != null) {
    doc.setIn(["rf", "reference_rssi_1m"], round(params.referenceRssi1m));
  }
  if (params.wallAttenuationDb != null) {
    doc.setIn(["rf", "wall_attenuation_db"], round(params.wallAttenuationDb));
  }
  if (params.exteriorWallAttenuationDb != null) {
    doc.setIn(
      ["rf", "exterior_wall_attenuation_db"],
      round(params.exteriorWallAttenuationDb),
    );
  }
  if (params.doorAttenuationDb != null) {
    doc.setIn(["rf", "door_attenuation_db"], round(params.doorAttenuationDb));
  }

  const newYaml = doc.toString();
  const reparseDoc = parseDocument(newYaml);
  if (reparseDoc.errors.length > 0) {
    throw new ConfigWriteError(
      `Internal: edited YAML failed to round-trip parse: ${reparseDoc.errors[0].message}`,
      "invalid-after-edit",
    );
  }
  const validation = ConfigSchema.safeParse(reparseDoc.toJS());
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "(root)";
    throw new ConfigWriteError(
      `Edited config failed validation at ${issuePath}: ${issue?.message ?? "unknown"}`,
      "invalid-after-edit",
    );
  }

  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, newYaml, "utf8");
    await rename(tmpPath, configPath);
  } catch (err) {
    throw new ConfigWriteError(
      `Failed to write config: ${(err as Error).message}`,
      "io-failed",
    );
  }
}

/** Update the `point` field of a node identified by `nodeId`. */
export async function updateNodePoint(
  nodeId: string,
  point: readonly [number, number, number],
): Promise<void> {
  const configPath = resolveConfigPath();

  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigWriteError(
      `Could not read config at ${configPath}`,
      "not-found",
    );
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new ConfigWriteError(
      `Existing config has parse errors: ${doc.errors[0].message}`,
      "parse-failed",
    );
  }

  const nodes = doc.get("nodes");
  if (!isSeq(nodes)) {
    throw new ConfigWriteError(
      "Config has no `nodes` sequence",
      "node-not-found",
    );
  }

  let found = false;
  for (const item of nodes.items) {
    if (!isMap(item)) continue;
    const id = item.get("id");
    const name = item.get("name");
    const effectiveId =
      typeof id === "string" && id.length > 0
        ? id
        : typeof name === "string"
          ? slugify(name)
          : null;
    if (effectiveId === nodeId) {
      // Replace the existing point. Setting an array as a plain JS value
      // produces an inline (flow) sequence in YAML, which matches the
      // existing style in the user's config.
      item.set("point", [point[0], point[1], point[2]]);
      found = true;
      break;
    }
  }

  if (!found) {
    throw new ConfigWriteError(
      `Node "${nodeId}" not found in config`,
      "node-not-found",
    );
  }

  const newYaml = doc.toString();

  // Re-parse + revalidate before writing — never write something we can't
  // load back.
  const reparseDoc = parseDocument(newYaml);
  if (reparseDoc.errors.length > 0) {
    throw new ConfigWriteError(
      `Internal: edited YAML failed to round-trip parse: ${reparseDoc.errors[0].message}`,
      "invalid-after-edit",
    );
  }
  const validation = ConfigSchema.safeParse(reparseDoc.toJS());
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const path = issue?.path?.join(".") ?? "(root)";
    throw new ConfigWriteError(
      `Edited config failed validation at ${path}: ${issue?.message ?? "unknown"}`,
      "invalid-after-edit",
    );
  }

  // Atomic write: write to a sibling temp file, then rename over the target.
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, newYaml, "utf8");
    await rename(tmpPath, configPath);
  } catch (err) {
    throw new ConfigWriteError(
      `Failed to write config: ${(err as Error).message}`,
      "io-failed",
    );
  }
}
