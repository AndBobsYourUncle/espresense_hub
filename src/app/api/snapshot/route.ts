import { NextResponse } from "next/server";
import {
  SnapshotError,
  buildSnapshot,
  validateSnapshot,
  writeSnapshot,
} from "@/lib/snapshot";

export const dynamic = "force-dynamic";

function errorStatus(code: SnapshotError["code"]): number {
  switch (code) {
    case "read-failed":
    case "write-failed":
      return 500;
    case "parse-failed":
    case "validation-failed":
    case "unsupported-version":
      return 400;
    default:
      return 500;
  }
}

/**
 * GET /api/snapshot
 *
 * Bundle config.yaml + the three persistence JSONs into a single
 * versioned envelope. Served as a downloadable JSON file — the
 * browser's default handling of `Content-Disposition: attachment`
 * triggers a save dialog.
 *
 * The bundle contains MQTT credentials (from config.yaml) and all
 * learned calibration data. Treat it like a secret.
 */
export async function GET(): Promise<Response> {
  try {
    const snap = await buildSnapshot();
    const timestamp = snap.exportedAt.replace(/[:]/g, "-").replace(/\..+$/, "");
    const filename = `espresense-hub-snapshot-${timestamp}.json`;
    return new Response(JSON.stringify(snap), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof SnapshotError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: errorStatus(err.code) },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/snapshot
 *
 * Accept a previously-exported snapshot and overwrite the on-disk state
 * with its contents. Validates the envelope + the embedded config.yaml
 * against the runtime schema before touching anything — a malformed
 * upload is rejected, never partially applied.
 *
 * Does NOT hot-reload state; a service restart is required and flagged
 * in the response so the UI can prompt for one.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  try {
    const snap = validateSnapshot(body);
    await writeSnapshot(snap);
    return NextResponse.json({
      ok: true,
      restartRequired: true,
      exportedAt: snap.exportedAt,
      hubVersion: snap.hubVersion,
    });
  } catch (err) {
    if (err instanceof SnapshotError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: errorStatus(err.code) },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }
}
