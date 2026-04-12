import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { resolveConfigPath } from "./load";
import { ConfigSchema, slugify } from "./schema";

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
