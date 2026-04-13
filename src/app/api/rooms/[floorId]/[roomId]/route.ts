import { NextResponse } from "next/server";
import { ConfigWriteError, updateRoomRelations } from "@/lib/config/write";

export const dynamic = "force-dynamic";

interface PatchBody {
  open_to?: unknown;
  floor_area?: unknown;
}

/**
 * PATCH /api/rooms/[floorId]/[roomId]
 *
 * Update the `open_to` connections and `floor_area` tag of a room.
 * Used by the Room Relations map tool to save edits without touching
 * the full config YAML.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ floorId: string; roomId: string }> },
): Promise<Response> {
  const { floorId, roomId } = await params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!Array.isArray(body.open_to) || !body.open_to.every((v) => typeof v === "string")) {
    return NextResponse.json(
      { error: "`open_to` must be an array of strings" },
      { status: 400 },
    );
  }

  if (
    body.floor_area !== undefined &&
    body.floor_area !== null &&
    typeof body.floor_area !== "string"
  ) {
    return NextResponse.json(
      { error: "`floor_area` must be a string or null" },
      { status: 400 },
    );
  }

  try {
    await updateRoomRelations(
      floorId,
      roomId,
      body.open_to as string[],
      body.floor_area as string | null | undefined,
    );
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      const status =
        err.code === "not-found"
          ? 404
          : err.code === "node-not-found"
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
