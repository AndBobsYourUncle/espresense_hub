import AutoRefresh from "@/components/AutoRefresh";
import PageHeader from "@/components/PageHeader";
import {
  ConfigNotFoundError,
  ConfigParseError,
  loadConfig,
  type Node as ConfigNode,
} from "@/lib/config";
import { getStore, type NodeState } from "@/lib/state/store";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  name: string;
  configured: boolean;
  point?: readonly [number, number, number];
  floors?: readonly string[];
  state?: NodeState;
}

function formatRelative(ms: number | undefined): string {
  if (ms == null) return "—";
  const delta = Date.now() - ms;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function formatUptime(ms: number | undefined): string {
  if (ms == null) return "—";
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(b: number | undefined): string {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default async function NodesPage() {
  let configError: string | null = null;
  let configNodes: readonly ConfigNode[] = [];
  try {
    const config = await loadConfig();
    configNodes = config.nodes;
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      configError = `Config not found at ${err.configPath}`;
    } else if (err instanceof ConfigParseError) {
      configError = err.message;
    } else {
      configError = (err as Error).message ?? "Failed to load config";
    }
  }

  const store = getStore();

  // Merge: configured nodes first (in their config order), then any nodes
  // that MQTT has reported but we don't have in config.
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const n of configNodes) {
    if (!n.id) continue;
    seen.add(n.id);
    rows.push({
      id: n.id,
      name: n.name ?? n.id,
      configured: true,
      point: n.point,
      floors: n.floors ?? undefined,
      state: store.nodes.get(n.id),
    });
  }
  for (const state of store.nodes.values()) {
    if (seen.has(state.id)) continue;
    // Only surface unconfigured nodes when they're currently online — this
    // preserves the discovery affordance (a newly-flashed ESPresense on the
    // mesh shows up as "unconfigured" so the user can add it to config) while
    // hiding retained-LWT zombies from nodes that have since been removed or
    // renamed and are just lingering on the broker as offline tombstones.
    if (!state.online) continue;
    rows.push({
      id: state.id,
      name: state.id,
      configured: false,
      state,
    });
  }

  const onlineCount = rows.filter((r) => r.state?.online).length;

  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <PageHeader
        title="Nodes"
        description={`${onlineCount} / ${rows.length} online`}
      />
      <main className="flex-1 min-h-0 p-6 overflow-auto">
        {configError && (
          <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            {configError}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="h-full rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800 flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
            No nodes configured or discovered yet
          </div>
        ) : (
          <div className="@container rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th className="hidden @md:table-cell">IP</Th>
                  <Th className="hidden @xl:table-cell">Firmware</Th>
                  <Th className="text-right hidden @3xl:table-cell">Uptime</Th>
                  <Th className="text-right hidden @4xl:table-cell">Free heap</Th>
                  <Th className="text-right hidden @2xl:table-cell">Seen</Th>
                  <Th className="text-right hidden @5xl:table-cell">Position</Th>
                  <Th className="text-right hidden @lg:table-cell">
                    Last telemetry
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const t = row.state?.telemetry;
                  const online = row.state?.online ?? false;
                  return (
                    <tr
                      key={row.id}
                      className="border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-900/30"
                    >
                      <Td>
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {row.name}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                          {row.id}
                          {!row.configured && (
                            <span className="ml-2 text-amber-600 dark:text-amber-500">
                              (unconfigured)
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              online ? "bg-emerald-500" : "bg-zinc-400"
                            }`}
                          />
                          <span
                            className={
                              online
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-zinc-500 dark:text-zinc-400"
                            }
                          >
                            {online ? "online" : "offline"}
                          </span>
                        </span>
                      </Td>
                      <Td className="font-mono text-xs hidden @md:table-cell">
                        {t?.ip ?? "—"}
                      </Td>
                      <Td className="font-mono text-xs hidden @xl:table-cell">
                        {t?.version ?? t?.firmware ?? "—"}
                      </Td>
                      <Td className="text-right font-mono text-xs hidden @3xl:table-cell">
                        {formatUptime(t?.uptime)}
                      </Td>
                      <Td className="text-right font-mono text-xs hidden @4xl:table-cell">
                        {formatBytes(t?.freeHeap)}
                      </Td>
                      <Td className="text-right font-mono text-xs hidden @2xl:table-cell">
                        {t?.seen ?? "—"}
                      </Td>
                      <Td className="text-right font-mono text-xs text-zinc-500 dark:text-zinc-400 hidden @5xl:table-cell">
                        {row.point
                          ? `${row.point[0]}, ${row.point[1]}, ${row.point[2]}`
                          : "—"}
                      </Td>
                      <Td className="text-right text-xs text-zinc-500 dark:text-zinc-400 hidden @lg:table-cell">
                        {formatRelative(row.state?.telemetryAt)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-4 py-2.5 text-left font-medium ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 ${className ?? ""}`}>{children}</td>;
}
