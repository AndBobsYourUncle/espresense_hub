"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Map,
  Smartphone,
  Router,
  Target,
  Settings,
  Radio,
} from "lucide-react";
import { useUnits } from "./UnitsProvider";

const navItems = [
  { href: "/", label: "Map", icon: Map },
  { href: "/devices", label: "Devices", icon: Smartphone },
  { href: "/nodes", label: "Nodes", icon: Router },
  { href: "/calibration", label: "Calibration", icon: Target },
  { href: "/settings", label: "Settings", icon: Settings },
];

type MqttStatus = "disconnected" | "connecting" | "connected" | "error";

interface Status {
  mqtt: { status: MqttStatus; host?: string; error?: string };
  nodeCount: number;
  deviceCount: number;
}

const STATUS_STYLES: Record<
  MqttStatus,
  { dot: string; label: string; text: string }
> = {
  connected: {
    dot: "bg-emerald-500",
    label: "Connected",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  connecting: {
    dot: "bg-amber-500 animate-pulse",
    label: "Connecting",
    text: "text-amber-700 dark:text-amber-400",
  },
  disconnected: {
    dot: "bg-zinc-400",
    label: "Disconnected",
    text: "text-zinc-500",
  },
  error: {
    dot: "bg-red-500",
    label: "Error",
    text: "text-red-600 dark:text-red-400",
  },
};

function useStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Status;
        if (!cancelled) setStatus(data);
      } catch {
        // swallow — next tick will try again
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}

export default function Sidebar() {
  const pathname = usePathname();
  const status = useStatus();
  const { units, setUnits } = useUnits();

  const mqttStatus = status?.mqtt.status ?? "disconnected";
  const style = STATUS_STYLES[mqttStatus];
  const detail = status?.mqtt.host ?? status?.mqtt.error;

  return (
    <aside className="w-60 shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col bg-zinc-50/50 dark:bg-zinc-950/50">
      <div className="h-16 flex items-center gap-2 px-5 border-b border-zinc-200 dark:border-zinc-800">
        <Radio className="h-5 w-5 text-blue-500" />
        <span className="font-semibold tracking-tight">ESPresense Hub</span>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
        <div
          className="px-3 py-1 text-xs space-y-1"
          title={status?.mqtt.error ?? undefined}
        >
          <div className={`flex items-center gap-2 ${style.text}`}>
            <span className={`h-2 w-2 rounded-full ${style.dot}`} />
            <span className="font-medium">MQTT {style.label}</span>
          </div>
          {detail && (
            <div className="pl-4 text-zinc-400 dark:text-zinc-500 font-mono truncate">
              {detail}
            </div>
          )}
          {status && (
            <div className="pl-4 text-zinc-400 dark:text-zinc-500">
              {status.nodeCount} nodes · {status.deviceCount} devices
            </div>
          )}
        </div>
        <div className="px-3 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">
            units
          </span>
          <div
            className="inline-flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-[10px] font-medium"
            role="group"
            aria-label="Unit system"
          >
            <button
              type="button"
              onClick={() => setUnits("metric")}
              className={`px-2 py-0.5 transition-colors ${
                units === "metric"
                  ? "bg-blue-500 text-white"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
              aria-pressed={units === "metric"}
            >
              m
            </button>
            <button
              type="button"
              onClick={() => setUnits("imperial")}
              className={`px-2 py-0.5 transition-colors ${
                units === "imperial"
                  ? "bg-blue-500 text-white"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
              aria-pressed={units === "imperial"}
            >
              in
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
