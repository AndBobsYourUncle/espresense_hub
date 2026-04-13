import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getAutoApplyState,
  restoreAutoApplyState,
  type AutoApplyEvent,
} from "@/lib/calibration/auto_apply";
import { resolveConfigPath } from "@/lib/config/load";

/**
 * Persist the auto-apply audit log + per-node rate-limit timestamps
 * across restarts.
 *
 * Why both:
 *   - The audit log is the only forensic record of what the system has
 *     pushed to firmware. Losing it on every deploy means you can't
 *     answer "did something get pushed last week that broke things?"
 *   - The rate-limit map prevents auto-apply from re-pushing a node
 *     within `PER_NODE_RATE_LIMIT_MS` (10 min). Without persistence,
 *     a deploy that lands ~1 min after a push would let the system
 *     immediately re-push that node — which usually doesn't matter,
 *     but in a worst-case feedback loop could destabilize calibration.
 *
 * Stored as `audit.json` next to config.yaml, on the same 60 s cadence
 * as calibration.json.
 */

const FILE_NAME = "audit.json";

interface AuditFileV1 {
  version: 1;
  savedAt: number;
  auditLog: AutoApplyEvent[];
  /** nodeId → epoch ms of the most recent auto-apply for that node. */
  lastAutoApplyByNode: Record<string, number>;
}

function auditPath(): string {
  return path.join(path.dirname(resolveConfigPath()), FILE_NAME);
}

/**
 * Load the persisted audit + rate-limit state into the auto_apply module.
 * Called on bootstrap, before the first auto-apply cycle runs.
 */
export async function loadAuditState(): Promise<void> {
  const filePath = auditPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[audit-persist] no existing audit file at ${filePath}`);
      return;
    }
    throw err;
  }

  let parsed: AuditFileV1;
  try {
    parsed = JSON.parse(raw) as AuditFileV1;
  } catch (err) {
    console.error(
      `[audit-persist] failed to parse ${filePath}:`,
      (err as Error).message,
    );
    return;
  }

  if (parsed.version !== 1) {
    console.warn(
      `[audit-persist] ${filePath} has unknown version ${parsed.version}, ignoring`,
    );
    return;
  }

  restoreAutoApplyState({
    auditLog: Array.isArray(parsed.auditLog) ? parsed.auditLog : [],
    lastAutoApplyByNode: parsed.lastAutoApplyByNode ?? {},
  });

  console.log(
    `[audit-persist] loaded ${parsed.auditLog?.length ?? 0} audit events · ` +
      `${Object.keys(parsed.lastAutoApplyByNode ?? {}).length} rate-limit entries`,
  );
}

/**
 * Save the current audit + rate-limit state. Called on a 60 s timer and
 * from graceful-shutdown handlers. Atomic write (tmp + rename).
 */
export async function saveAuditState(): Promise<void> {
  const filePath = auditPath();
  const snap = getAutoApplyState();

  const data: AuditFileV1 = {
    version: 1,
    savedAt: Date.now(),
    auditLog: snap.auditLog,
    lastAutoApplyByNode: snap.lastAutoApplyByNode,
  };

  // Skip the write if there's nothing to persist (fresh boot, never
  // pushed anything). Avoids creating an empty/garbage file.
  if (
    data.auditLog.length === 0 &&
    Object.keys(data.lastAutoApplyByNode).length === 0
  ) {
    return;
  }

  const tmp = `${filePath}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    console.error(
      `[audit-persist] failed to save ${filePath}:`,
      (err as Error).message,
    );
  }
}
