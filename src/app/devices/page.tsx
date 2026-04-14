import AutoRefresh from "@/components/AutoRefresh";
import PageHeader from "@/components/PageHeader";
import { getStore, type DeviceState } from "@/lib/state/store";

export const dynamic = "force-dynamic";

function formatRelative(ms: number | undefined): string {
  if (ms == null) return "—";
  const delta = Date.now() - ms;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

interface Row {
  device: DeviceState;
  fixes: number;
  closestNode?: string;
  closestDistance?: number;
  strongestRssi?: number;
}

function deriveRow(device: DeviceState): Row {
  let closestNode: string | undefined;
  let closestDistance: number | undefined;
  let strongestRssi: number | undefined;

  for (const m of device.measurements.values()) {
    if (m.distance != null) {
      if (closestDistance == null || m.distance < closestDistance) {
        closestDistance = m.distance;
        closestNode = m.nodeId;
      }
    }
    if (m.rssi != null) {
      if (strongestRssi == null || m.rssi > strongestRssi) {
        strongestRssi = m.rssi;
      }
    }
  }

  return {
    device,
    fixes: device.measurements.size,
    closestNode,
    closestDistance,
    strongestRssi,
  };
}

export default async function DevicesPage() {
  const store = getStore();
  const rows = Array.from(store.devices.values())
    .map(deriveRow)
    .sort((a, b) => b.device.lastSeen - a.device.lastSeen);

  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <PageHeader title="Devices" description={`${rows.length} tracked`} />
      <main className="flex-1 min-h-0 p-6 overflow-auto">
        {rows.length === 0 ? (
          <div className="h-full rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800 flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
            No devices discovered yet
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr>
                  <Th>Device</Th>
                  <Th className="text-right">Fixes</Th>
                  <Th>Closest node</Th>
                  <Th className="text-right">Distance</Th>
                  <Th className="text-right">RSSI</Th>
                  <Th className="text-right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.device.id}
                    className="border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-900/30"
                  >
                    <Td>
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {row.device.name ?? row.device.id}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                        {row.device.id}
                      </div>
                    </Td>
                    <Td className="text-right font-mono text-xs">
                      {row.fixes}
                    </Td>
                    <Td className="font-mono text-xs">
                      {row.closestNode ?? "—"}
                    </Td>
                    <Td className="text-right font-mono text-xs">
                      {row.closestDistance != null
                        ? `${row.closestDistance.toFixed(2)} m`
                        : "—"}
                    </Td>
                    <Td className="text-right font-mono text-xs">
                      {row.strongestRssi != null
                        ? `${row.strongestRssi} dBm`
                        : "—"}
                    </Td>
                    <Td className="text-right text-xs text-zinc-500 dark:text-zinc-400">
                      {formatRelative(row.device.lastSeen)}
                    </Td>
                  </tr>
                ))}
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
