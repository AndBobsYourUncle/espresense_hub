import { NextResponse } from "next/server";
import { getStore } from "@/lib/state/store";

// Read from the in-memory store on every request — never cache.
export const dynamic = "force-dynamic";

export function GET() {
  const store = getStore();
  return NextResponse.json({
    mqtt: store.mqtt,
    nodeCount: store.nodes.size,
    deviceCount: store.devices.size,
  });
}
