import { NextResponse } from "next/server";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

export interface AlternativePositionDTO {
  x: number;
  y: number;
  z: number;
  algorithm: string;
}

export interface DevicePositionDTO {
  id: string;
  name?: string;
  x: number;
  y: number;
  z: number;
  confidence: number;
  fixes: number;
  algorithm: string;
  lastSeen: number;
  computedAt: number;
  /** Per-locator alternative positions for side-by-side comparison. */
  alternatives?: AlternativePositionDTO[];
  /**
   * Raw locator output that's currently being overridden by a pin
   * lock. Only present when `algorithm === "pin_anchored"`. Lets the
   * map render a "convergence target" ghost marker so the user can
   * watch the underlying estimate migrate toward the pin as biases
   * accumulate.
   */
  rawPosition?: { x: number; y: number; z: number };
  /**
   * Position currently published by upstream ESPresense-companion
   * (when running alongside us). Lets the compare view render an
   * apples-to-apples ghost marker — same MQTT data, different
   * pipeline. Direct visual measurement of how much our pipeline
   * improves over upstream's.
   */
  upstreamPosition?: {
    x: number;
    y: number;
    z?: number;
    confidence: number;
    fixes: number;
    scenario?: string;
    lastSeen: number;
  };
  /**
   * Running distance stats from each comparison locator to our active
   * position, per locator algorithm. Empty/undefined when nothing has
   * been compared yet. The compare legend uses the mean to surface a
   * "this locator was N meters off from us, on average" number.
   */
  locatorDeltas?: Record<
    string,
    { mean: number; stddev: number; count: number; lastUpdatedMs: number }
  >;
}

export interface DevicePositionsResponse {
  devices: DevicePositionDTO[];
  serverTime: number;
}

export function GET() {
  const store = getStore();
  const devices: DevicePositionDTO[] = [];
  for (const d of store.devices.values()) {
    if (!d.position) continue;
    devices.push({
      id: d.id,
      name: d.name,
      x: d.position.x,
      y: d.position.y,
      z: d.position.z,
      confidence: d.position.confidence,
      fixes: d.position.fixes,
      algorithm: d.position.algorithm,
      lastSeen: d.lastSeen,
      computedAt: d.position.computedAt,
      alternatives: d.position.alternatives,
      rawPosition: d.position.rawPosition,
      upstreamPosition: d.upstreamPosition
        ? {
            x: d.upstreamPosition.x,
            y: d.upstreamPosition.y,
            z: d.upstreamPosition.z,
            confidence: d.upstreamPosition.confidence,
            fixes: d.upstreamPosition.fixes,
            scenario: d.upstreamPosition.scenario,
            lastSeen: d.upstreamPosition.lastSeen,
          }
        : undefined,
      locatorDeltas: d.locatorComparisons
        ? Object.fromEntries(
            [...d.locatorComparisons.entries()].map(([algo, s]) => {
              const mean = s.count > 0 ? s.sum / s.count : 0;
              const variance =
                s.count > 0 ? Math.max(0, s.sumSq / s.count - mean * mean) : 0;
              return [
                algo,
                {
                  mean,
                  stddev: Math.sqrt(variance),
                  count: Math.round(s.count),
                  lastUpdatedMs: s.lastUpdatedMs,
                },
              ];
            }),
          )
        : undefined,
    });
  }
  const body: DevicePositionsResponse = {
    devices,
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
