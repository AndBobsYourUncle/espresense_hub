import PageHeader from "@/components/PageHeader";
import CompareLegend from "@/components/map/CompareLegend";
import DeviceDetailPanel from "@/components/map/DeviceDetailPanel";
import DeviceSelectionProvider from "@/components/map/DeviceSelectionProvider";
import FloorPlan from "@/components/map/FloorPlan";
import MapStage from "@/components/map/MapStage";
import MapToolbar from "@/components/map/MapToolbar";
import MapToolProvider from "@/components/map/MapToolProvider";
import NodeEditPanel from "@/components/map/NodeEditPanel";
import NodeEditProvider from "@/components/map/NodeEditProvider";
import NodeInspectionPanel from "@/components/map/NodeInspectionPanel";
import type { NodeMarkerData } from "@/components/map/NodeMarkers";
import PinHighlightProvider from "@/components/map/PinHighlightProvider";
import RulerPanel from "@/components/map/RulerPanel";
import RulerProvider from "@/components/map/RulerProvider";
import {
  ConfigNotFoundError,
  ConfigParseError,
  loadConfig,
  type Config,
} from "@/lib/config";
import { nodesForFloor } from "@/lib/map/geometry";

// Config is read from disk at request time — never statically prerender.
export const dynamic = "force-dynamic";

type LoadResult =
  | { ok: true; config: Config }
  | { ok: false; kind: "missing" | "invalid" | "unknown"; message: string };

async function tryLoadConfig(): Promise<LoadResult> {
  try {
    return { ok: true, config: await loadConfig() };
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      return {
        ok: false,
        kind: "missing",
        message: `No config.yaml found at ${err.configPath}. Copy config.example.yaml alongside it to get started.`,
      };
    }
    if (err instanceof ConfigParseError) {
      return { ok: false, kind: "invalid", message: err.message };
    }
    return {
      ok: false,
      kind: "unknown",
      message: (err as Error).message ?? "Failed to load config",
    };
  }
}

export default async function MapPage() {
  const result = await tryLoadConfig();

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Map" description="Live device positions" />
        <main className="flex-1 min-h-0 p-6">
          <div className="h-full rounded-xl border border-dashed border-red-300 dark:border-red-900/50 bg-red-50/40 dark:bg-red-950/20 flex items-center justify-center p-8 text-center">
            <div className="max-w-xl space-y-2">
              <h2 className="font-medium text-red-700 dark:text-red-400">
                {result.kind === "missing"
                  ? "Config file not found"
                  : "Config error"}
              </h2>
              <pre className="text-xs text-red-600/80 dark:text-red-400/80 whitespace-pre-wrap font-mono text-left">
                {result.message}
              </pre>
            </div>
          </div>
        </main>
      </>
    );
  }

  const { config } = result;
  const floor = config.floors[0];
  const summary =
    config.floors.length > 0
      ? `${config.floors.length} floor${config.floors.length === 1 ? "" : "s"} · ${config.nodes.length} node${config.nodes.length === 1 ? "" : "s"}`
      : "No floors defined";

  // Pre-compute the floor's nodes once so RulerPanel and FloorPlan agree.
  const floorNodes: NodeMarkerData[] = floor
    ? nodesForFloor(config.nodes, floor.id).map((n) => ({
        id: n.id,
        name: n.name,
        point: n.point!,
      }))
    : [];

  return (
    <>
      <PageHeader title="Map" description={summary} />
      <main className="flex-1 min-h-0 p-6 flex flex-col gap-3">
        {floor ? (
          <DeviceSelectionProvider>
            <RulerProvider>
              <NodeEditProvider>
                <MapToolProvider>
                  <PinHighlightProvider>
                    <MapToolbar />
                    <div className="flex-1 min-h-0">
                      <MapStage>
                        <FloorPlan config={config} floor={floor} />
                        <CompareLegend />
                        <DeviceDetailPanel />
                        <NodeInspectionPanel nodes={floorNodes} />
                        <RulerPanel nodes={floorNodes} />
                        <NodeEditPanel nodes={floorNodes} />
                      </MapStage>
                    </div>
                  </PinHighlightProvider>
                </MapToolProvider>
              </NodeEditProvider>
            </RulerProvider>
          </DeviceSelectionProvider>
        ) : (
          <div className="h-full rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800 flex items-center justify-center text-sm text-zinc-500">
            No floors defined in config.yaml
          </div>
        )}
      </main>
    </>
  );
}
