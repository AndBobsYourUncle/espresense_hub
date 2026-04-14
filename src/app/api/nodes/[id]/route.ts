import { NextResponse } from "next/server";
import { reloadLiveConfig } from "@/lib/bootstrap";
import { ConfigWriteError, updateNodePoint } from "@/lib/config/write";

export const dynamic = "force-dynamic";

interface PatchBody {
  point?: unknown;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const id = decodeURIComponent(rawId);

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const point = body.point;
  if (
    !Array.isArray(point) ||
    point.length !== 3 ||
    !point.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return NextResponse.json(
      { error: "point must be a 3-element number array [x, y, z]" },
      { status: 400 },
    );
  }
  const triple: [number, number, number] = [point[0], point[1], point[2]];

  try {
    await updateNodePoint(id, triple);
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      const status = err.code === "node-not-found" ? 404 : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }

  // Push the new config into the live holder so the locator + node index
  // pick up the new position on the very next message.
  await reloadLiveConfig();

  return NextResponse.json({ ok: true, id, point: triple });
}
