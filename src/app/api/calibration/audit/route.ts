import { NextResponse } from "next/server";
import {
  AUTO_APPLY_INTERVAL_MS,
  getAutoApplyAuditLog,
  type AutoApplyEvent,
} from "@/lib/calibration/auto_apply";

export const dynamic = "force-dynamic";

export interface AutoApplyAuditResponse {
  /** How often the auto-apply cycle runs, in ms. */
  cycleIntervalMs: number;
  /** Recent auto-apply events, newest first. Bounded to 200 entries. */
  events: AutoApplyEvent[];
  serverTime: number;
}

/** GET — surface the in-memory auto-apply audit log + cycle timing. */
export function GET(): Response {
  const body: AutoApplyAuditResponse = {
    cycleIntervalMs: AUTO_APPLY_INTERVAL_MS,
    events: [...getAutoApplyAuditLog()],
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
