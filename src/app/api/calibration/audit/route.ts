import { NextResponse } from "next/server";
import {
  AUTO_APPLY_INTERVAL_MS,
  getAutoApplyAuditLog,
  getAutoApplyState,
  PER_NODE_RATE_LIMIT_MS,
  type AutoApplyEvent,
} from "@/lib/calibration/auto_apply";

export const dynamic = "force-dynamic";

export interface AutoApplyAuditResponse {
  /** How often the auto-apply cycle runs, in ms. */
  cycleIntervalMs: number;
  /** Per-node rate limit window, in ms (no node can be re-pushed within this). */
  rateLimitMs: number;
  /** Recent auto-apply events, newest first. Bounded to 200 entries. */
  events: AutoApplyEvent[];
  /**
   * nodeId → epoch ms of the most recent auto-apply for that node.
   * Used by the UI to show "next push allowed in X" countdowns.
   */
  lastAutoApplyByNode: Record<string, number>;
  serverTime: number;
}

/** GET — surface the in-memory auto-apply audit log + cycle timing. */
export function GET(): Response {
  const state = getAutoApplyState();
  const body: AutoApplyAuditResponse = {
    cycleIntervalMs: AUTO_APPLY_INTERVAL_MS,
    rateLimitMs: PER_NODE_RATE_LIMIT_MS,
    events: getAutoApplyAuditLog().slice(),
    lastAutoApplyByNode: state.lastAutoApplyByNode,
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
