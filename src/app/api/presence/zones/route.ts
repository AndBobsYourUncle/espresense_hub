import { NextResponse } from "next/server";
import { reloadLiveConfig } from "@/lib/bootstrap";
import { ConfigWriteError, updatePresenceZones } from "@/lib/config/write";

export const dynamic = "force-dynamic";

interface PutBody {
  zones?: unknown;
}

/**
 * PUT /api/presence/zones
 *
 * Replace the full `presence.zones` array in config.yaml.
 * Used by the Presence Zones map tool to save zone membership edits.
 */
export async function PUT(request: Request): Promise<Response> {
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!Array.isArray(body.zones)) {
    return NextResponse.json(
      { error: "`zones` must be an array" },
      { status: 400 },
    );
  }

  try {
    await updatePresenceZones(body.zones);
    // Push the new config into the live holder so the MQTT handler
    // picks up the added/removed zones on the very next message.
    // Without this the zones live in config.yaml but the handler keeps
    // using its captured snapshot until the service restarts.
    await reloadLiveConfig();
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      const status =
        err.code === "not-found"
          ? 404
          : err.code === "parse-failed" || err.code === "invalid-after-edit"
            ? 400
            : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
