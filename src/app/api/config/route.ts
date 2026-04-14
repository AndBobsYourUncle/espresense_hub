import { NextResponse } from "next/server";
import { applyRuntimeConfig } from "@/lib/bootstrap";
import { loadConfig } from "@/lib/config";
import { setCurrentConfig } from "@/lib/config/current";
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

  // Re-parse the freshly-written YAML and push it into the live-config
  // holder so the MQTT handler, presence publisher, device cleanup, and
  // stateful filter singletons all pick up the new values on the next tick.
  // Node positions are also refreshed in the shared nodeIndex so the
  // locator reflects them immediately.
  //
  // What still requires a restart: MQTT connection settings (broker host,
  // credentials) — the client is constructed once. Also the auto-apply
  // setInterval cadence: changing `optimization.interval_secs` updates the
  // value the next cycle uses, but the setInterval's own timer was wired
  // with the old cadence at bootstrap.
  let liveReloadOk = true;
  try {
    const config = await loadConfig();
    setCurrentConfig(config);
    applyRuntimeConfig(config);
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
    note: "Most changes apply live. MQTT broker connection changes need a service restart.",
  });
}
