import { NextResponse } from "next/server";
import { fitAllNodes, type NodeFit } from "@/lib/calibration/autofit";
import { getStore } from "@/lib/state/store";

export const dynamic = "force-dynamic";

export interface AutofitResponse {
  fits: NodeFit[];
  serverTime: number;
}

export function POST() {
  const store = getStore();
  const fits = fitAllNodes(store);
  const body: AutofitResponse = {
    fits,
    serverTime: Date.now(),
  };
  return NextResponse.json(body);
}
