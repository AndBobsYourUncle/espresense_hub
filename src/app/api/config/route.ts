import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import {
  ConfigWriteError,
  readRawConfig,
  writeRawConfig,
} from "@/lib/config/write";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

/**
 * GET — return the raw YAML text of the live config.yaml.
 * The settings editor uses this to populate its textarea on mount.
 */
export async function GET(): Promise<Response> {
  try {
    const { configPath, yaml } = await readRawConfig();
    return NextResponse.json({ configPath, yaml });
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      const status = err.code === "not-found" ? 404 : 500;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }
}

interface PutBody {
  yaml?: unknown;
}

/**
 * PUT — replace config.yaml with the provided YAML text.
 *
 * Validates with the shared zod schema before touching disk. Writes
 * atomically. On success, refreshes the in-memory nodeIndex from the new
 * config so node positions take effect immediately. Other config changes
 * (mqtt host, locator weights baked in at boot) require a service restart.
 */
export async function PUT(request: Request): Promise<Response> {
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  if (typeof body.yaml !== "string") {
    return NextResponse.json(
      { error: "body must include a `yaml` string" },
      { status: 400 },
    );
  }

  if (body.yaml.length > 1_000_000) {
    return NextResponse.json(
      { error: "config too large (>1 MB)" },
      { status: 413 },
    );
  }

  let result;
  try {
    result = await writeRawConfig(body.yaml);
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      const status =
        err.code === "parse-failed" || err.code === "invalid-after-edit"
          ? 400
          : 500;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }

  // Refresh the in-memory nodeIndex so the locator picks up new node
  // positions starting with the very next message. Other things (MQTT
  // host, history DB) only re-read on bootstrap, so flag whether a
  // restart is recommended.
  let liveReloadOk = true;
  try {
    const config = await loadConfig();
    const store = getStore();
    store.nodeIndex.clear();
    for (const n of config.nodes) {
      if (n.id && n.point) store.nodeIndex.set(n.id, n.point);
    }
  } catch {
    liveReloadOk = false;
  }

  return NextResponse.json({
    ok: true,
    configPath: result.configPath,
    bytes: result.bytes,
    liveReloadOk,
    note: "Node positions and rooms apply immediately. MQTT and bootstrap-time settings need a service restart.",
  });
}
