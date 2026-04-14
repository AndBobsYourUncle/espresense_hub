import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { ConfigSchema } from "./config/schema";
import { resolveConfigPath } from "./config/load";

/**
 * Snapshot bundle — everything needed to clone an ESPresense Hub
 * deployment to another machine watching the same home. Writes into
 * `{config_dir}/config.yaml`, `calibration.json`, `devices.json`,
 * `audit.json`.
 *
 * Versioned envelope so the format can evolve — a v2 reader can
 * detect v1 snapshots and back-fill sensibly.
 */
export interface SnapshotV1 {
  version: 1;
  /** ISO timestamp of when this snapshot was created. */
  exportedAt: string;
  /** ESPresense Hub version that produced the snapshot. */
  hubVersion: string;
  /** Raw YAML text — kept as text (not parsed) to preserve comments. */
  config_yaml: string;
  /**
   * Contents of `calibration.json` (per-pair fits, GT samples, residual
   * aggregates). Untyped at this layer — consumed by the calibration
   * persistence loader which has its own schema.
   */
  calibration: unknown;
  /** Contents of `devices.json` (pins, per-device bias, locator stats). */
  devices: unknown;
  /** Contents of `audit.json` (auto-apply events, rate-limit state). */
  audit: unknown;
}

export type Snapshot = SnapshotV1;
export const CURRENT_SNAPSHOT_VERSION = 1 as const;

export class SnapshotError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "read-failed"
      | "parse-failed"
      | "validation-failed"
      | "write-failed"
      | "unsupported-version",
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

function configDir(): string {
  return path.dirname(resolveConfigPath());
}

/**
 * Read a sibling JSON file from the config directory. Returns `null`
 * when the file doesn't exist (first-run instance with nothing to
 * persist yet); throws on any other IO/parse failure so snapshot
 * failures are loud.
 */
async function readSiblingJson(filename: string): Promise<unknown | null> {
  const filePath = path.join(configDir(), filename);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SnapshotError(
      `Failed to read ${filename}: ${(err as Error).message}`,
      "read-failed",
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SnapshotError(
      `Failed to parse ${filename}: ${(err as Error).message}`,
      "parse-failed",
    );
  }
}

/**
 * Build a snapshot of the current on-disk state. Not inherently atomic
 * — if persistence files are mid-save when we read them, we could catch
 * a partial (though the save code uses temp + rename, so the files
 * themselves are never partial).
 */
export async function buildSnapshot(): Promise<Snapshot> {
  let configYaml: string;
  try {
    configYaml = await fs.readFile(resolveConfigPath(), "utf-8");
  } catch (err) {
    throw new SnapshotError(
      `Failed to read config.yaml: ${(err as Error).message}`,
      "read-failed",
    );
  }

  const calibration = (await readSiblingJson("calibration.json")) ?? {};
  const devices = (await readSiblingJson("devices.json")) ?? {};
  const audit = (await readSiblingJson("audit.json")) ?? {};

  return {
    version: CURRENT_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    hubVersion: process.env.npm_package_version ?? "unknown",
    config_yaml: configYaml,
    calibration,
    devices,
    audit,
  };
}

/**
 * Validate an unknown value as a well-formed Snapshot. Checks the
 * envelope shape, the config YAML's validity against the runtime
 * schema, and rejects unsupported versions. Does NOT deeply validate
 * the three persistence JSONs — they have their own version fields and
 * are defensively-parsed by their respective loaders, so a slightly-off
 * shape there gets handled at load time rather than rejected here.
 */
export function validateSnapshot(raw: unknown): Snapshot {
  if (!raw || typeof raw !== "object") {
    throw new SnapshotError("Snapshot is not an object", "validation-failed");
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== CURRENT_SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `Unsupported snapshot version: ${String(o.version)} (this hub reads version ${CURRENT_SNAPSHOT_VERSION})`,
      "unsupported-version",
    );
  }
  if (typeof o.config_yaml !== "string") {
    throw new SnapshotError(
      "Snapshot missing `config_yaml` string",
      "validation-failed",
    );
  }
  // Validate the YAML parses and passes our schema so we don't write a
  // config.yaml that would fail at runtime.
  const doc = parseDocument(o.config_yaml);
  if (doc.errors.length > 0) {
    throw new SnapshotError(
      `Snapshot's config.yaml has parse errors: ${doc.errors[0].message}`,
      "validation-failed",
    );
  }
  const check = ConfigSchema.safeParse(doc.toJS());
  if (!check.success) {
    const issue = check.error.issues[0];
    const p = issue?.path?.join(".") ?? "(root)";
    throw new SnapshotError(
      `Snapshot's config.yaml failed schema validation at ${p}: ${issue?.message ?? "unknown"}`,
      "validation-failed",
    );
  }
  return {
    version: CURRENT_SNAPSHOT_VERSION,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
    hubVersion: typeof o.hubVersion === "string" ? o.hubVersion : "unknown",
    config_yaml: o.config_yaml,
    calibration: o.calibration ?? {},
    devices: o.devices ?? {},
    audit: o.audit ?? {},
  };
}

/**
 * Atomically (well, per-file atomically — across all four files we
 * write+rename sequentially) replace the on-disk state with a snapshot's
 * contents. The caller is expected to trigger a service restart after
 * this returns, since the in-memory state doesn't get hot-reloaded.
 */
export async function writeSnapshot(snap: Snapshot): Promise<void> {
  const dir = configDir();
  const writes: Array<{ name: string; content: string }> = [
    { name: "config.yaml", content: snap.config_yaml },
    { name: "calibration.json", content: JSON.stringify(snap.calibration) },
    { name: "devices.json", content: JSON.stringify(snap.devices) },
    { name: "audit.json", content: JSON.stringify(snap.audit) },
  ];

  // Two-pass write: first populate all `.tmp-*` files (if any of these
  // fail, nothing on disk changed yet). Then rename each into place.
  // A failure partway through the rename phase leaves the target dir in
  // a mixed state — but a subsequent restart would still pick up a
  // consistent-enough set, since every loader tolerates missing files.
  const tmpPaths: string[] = [];
  try {
    for (const w of writes) {
      const target = path.join(dir, w.name);
      const tmp = `${target}.snapshot-tmp-${process.pid}`;
      await fs.writeFile(tmp, w.content, "utf-8");
      tmpPaths.push(tmp);
    }
    // All staged — now rename.
    for (let i = 0; i < writes.length; i++) {
      await fs.rename(tmpPaths[i], path.join(dir, writes[i].name));
    }
  } catch (err) {
    // Best-effort cleanup of any leftover tmp files.
    for (const p of tmpPaths) {
      try {
        await fs.unlink(p);
      } catch {
        // ignore — tmp may have been renamed already
      }
    }
    throw new SnapshotError(
      `Failed to write snapshot: ${(err as Error).message}`,
      "write-failed",
    );
  }
}
