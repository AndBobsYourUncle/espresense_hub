import { NextResponse } from "next/server";
import { publishNodeSetting } from "@/lib/mqtt/client";
import { getStore, resetNodeResiduals } from "@/lib/state/store";

export const dynamic = "force-dynamic";

interface ApplyUpdate {
  nodeId: string;
  absorption?: number;
  rxAdjRssi?: number;
  txRefRssi?: number;
}

interface ApplyBody {
  updates?: ApplyUpdate[];
  /** When true, clear residual stats so the next sample window is post-apply. */
  resetStats?: boolean;
}

export interface ApplyResponse {
  ok: boolean;
  pushed: number;
  failed: Array<{ nodeId: string; error: string }>;
}

export async function POST(request: Request) {
  let body: ApplyBody;
  try {
    body = (await request.json()) as ApplyBody;
  } catch {
    return NextResponse.json(
      { error: "invalid json body" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.updates)) {
    return NextResponse.json(
      { error: "expected { updates: [...] }" },
      { status: 400 },
    );
  }

  let pushed = 0;
  const failed: Array<{ nodeId: string; error: string }> = [];

  for (const u of body.updates) {
    if (!u.nodeId || typeof u.nodeId !== "string") continue;
    const tasks: Array<Promise<void>> = [];
    if (u.absorption != null && Number.isFinite(u.absorption)) {
      tasks.push(
        publishNodeSetting(u.nodeId, "absorption", u.absorption.toFixed(2)),
      );
    }
    if (u.rxAdjRssi != null && Number.isFinite(u.rxAdjRssi)) {
      tasks.push(
        publishNodeSetting(
          u.nodeId,
          "rx_adj_rssi",
          Math.round(u.rxAdjRssi).toString(),
        ),
      );
    }
    if (u.txRefRssi != null && Number.isFinite(u.txRefRssi)) {
      tasks.push(
        publishNodeSetting(
          u.nodeId,
          "tx_ref_rssi",
          Math.round(u.txRefRssi).toString(),
        ),
      );
    }
    if (tasks.length === 0) continue;

    try {
      await Promise.all(tasks);
      pushed += 1;
    } catch (err) {
      failed.push({
        nodeId: u.nodeId,
        error: (err as Error).message ?? "publish failed",
      });
    }
  }

  if (body.resetStats !== false) {
    // Default: clear stats so the next round of measurements reflects the
    // post-apply state without being polluted by pre-apply data.
    resetNodeResiduals(getStore());
  }

  const response: ApplyResponse = {
    ok: failed.length === 0,
    pushed,
    failed,
  };
  return NextResponse.json(response);
}
