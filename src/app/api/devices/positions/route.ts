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
    });
  }
  const body: DevicePositionsResponse = {
    devices,
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
