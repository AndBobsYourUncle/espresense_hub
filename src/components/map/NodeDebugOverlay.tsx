"use client";

import { useEffect, useState } from "react";
import type {
  CalibrationResponse,
  NodeCalibrationDTO,
} from "@/app/api/calibration/route";
import type { FloorTransform } from "@/lib/map/geometry";
import { tx, ty } from "@/lib/map/geometry";
import { useMapTool } from "./MapToolProvider";
import type { NodeMarkerData } from "./NodeMarkers";

interface Props {
  transform: FloorTransform;
  nodes: readonly NodeMarkerData[];
}

interface Observation {
  listenerId: string;
  listenerPoint: readonly [number, number, number];
  measured: number;
  trueDist: number;
  samples: number;
}

const POLL_MS = 5000;

function residualClass(residual: number): string {
  const a = Math.abs(residual);
  if (a < 0.5) return "#10b981"; // emerald
  if (a < 1.5) return "#f59e0b"; // amber
  return "#ef4444"; // red
}

/**
 * When a node is selected via the inspect tool, draw a dotted circle
 * around every other node at the radius that node *measures* for the
 * inspected one.
 *
 * In a well-calibrated network, every circle should pass cleanly through
 * the inspected node's position. Where a circle is way off means that
 * specific listener has a calibration issue *for that path*.
 */
export default function NodeDebugOverlay({ transform, nodes }: Props) {
  const { inspectedNodeId } = useMapTool();
  const [calData, setCalData] = useState<NodeCalibrationDTO[] | null>(null);
  const selectedNodeId = inspectedNodeId;

  useEffect(() => {
    if (selectedNodeId == null) {
      setCalData(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/calibration", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as CalibrationResponse;
        if (!cancelled) setCalData(data.nodes);
      } catch {
        // swallow — next tick retries
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedNodeId]);

  if (selectedNodeId == null || !calData) return null;

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  if (!selectedNode) return null;

  // For each calibration row, look for a per-pair fit where the transmitter
  // is the selected node. That gives us "this listener's mean measurement
  // of the selected node".
  const observations: Observation[] = [];
  for (const cal of calData) {
    if (cal.nodeId === selectedNodeId) continue;
    const listenerNode = nodes.find((n) => n.id === cal.nodeId);
    if (!listenerNode) continue;
    const pair = cal.pairs.find((p) => p.transmitterId === selectedNodeId);
    if (!pair) continue;
    observations.push({
      listenerId: cal.nodeId,
      listenerPoint: listenerNode.point,
      measured: pair.meanMeasured,
      trueDist: pair.meanTrueDist,
      samples: pair.validSamples,
    });
  }

  return (
    <g className="fp-debug-overlay">
      {observations.map((obs) => {
        const cx = tx(transform, obs.listenerPoint[0]);
        const cy = ty(transform, obs.listenerPoint[1]);
        const residual = obs.measured - obs.trueDist;
        const color = residualClass(residual);
        return (
          <circle
            key={`node-obs-${obs.listenerId}`}
            cx={cx}
            cy={cy}
            r={obs.measured}
            fill="none"
            stroke={color}
            strokeWidth={0.04}
            strokeDasharray="0.18 0.12"
            strokeOpacity={0.75}
            className="fp-debug-circle"
          />
        );
      })}
    </g>
  );
}
