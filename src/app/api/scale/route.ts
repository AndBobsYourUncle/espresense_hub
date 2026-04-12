import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { ConfigWriteError, scaleConfig } from "@/lib/config/write";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

interface PostBody {
  factor?: unknown;
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const factor = body.factor;
  if (
    typeof factor !== "number" ||
    !Number.isFinite(factor) ||
    factor <= 0
  ) {
    return NextResponse.json(
      { error: "factor must be a positive finite number" },
      { status: 400 },
    );
  }

  // Sanity guard: refuse extreme rescales. A real LiDAR scan is virtually
  // never off by more than ~30%, so anything outside this range is almost
  // certainly a typo or unit confusion.
  if (factor < 0.5 || factor > 2.0) {
    return NextResponse.json(
      { error: "factor must be between 0.5 and 2.0" },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await scaleConfig(factor);
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }

  // Repopulate the live nodeIndex from the rescaled config so the locator
  // uses new positions starting with the very next message.
  try {
    const config = await loadConfig();
    const store = getStore();
    store.nodeIndex.clear();
    for (const n of config.nodes) {
      if (n.id && n.point) store.nodeIndex.set(n.id, n.point);
    }
  } catch {
    // The file write succeeded; if reload fails the next bootstrap will
    // catch up. Don't fail the request.
  }

  return NextResponse.json({ ok: true, factor, ...result });
}
