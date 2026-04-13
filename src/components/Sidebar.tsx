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
import { useMobileNav } from "./MobileNavProvider";
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
    text: "text-zinc-500 dark:text-zinc-400",
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
  const { open, close } = useMobileNav();

  const mqttStatus = status?.mqtt.status ?? "disconnected";
  const style = STATUS_STYLES[mqttStatus];
  const detail = status?.mqtt.host ?? status?.mqtt.error;

  // Shared unit toggle JSX — used both in the mobile-landscape compact
  // status row and in the standalone units row at other breakpoints.
  const unitToggle = (
    <div
      className="inline-flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-xs font-medium shrink-0"
      role="group"
      aria-label="Unit system"
    >
      <button
        type="button"
        onClick={() => setUnits("metric")}
        className={`px-2 py-0.5 transition-colors ${
          units === "metric"
            ? "bg-blue-500 text-white"
            : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
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
            : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
        }`}
        aria-pressed={units === "imperial"}
      >
        in
      </button>
    </div>
  );

  return (
    <>
      {/* Backdrop — only renders when the mobile drawer is open. Click to
          close. Hidden when the sidebar is always-visible chrome — that
          happens at md+ portrait OR lg+ landscape (mobile landscape
          often exceeds 768 px width but height is still constrained,
          so we hold the sidebar back to lg there). */}
      <button
        type="button"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={close}
        className={`md:portrait:hidden lg:landscape:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity ${
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
      />
      <aside
        className={`
          flex flex-col bg-zinc-50/50 dark:bg-zinc-950/50
          border-r border-zinc-200 dark:border-zinc-800
          fixed inset-y-0 left-0 z-50 w-60
          transition-transform duration-200 ease-out
          md:portrait:static md:portrait:translate-x-0 md:portrait:shrink-0
          lg:landscape:static lg:landscape:translate-x-0 lg:landscape:shrink-0
          ${open ? "translate-x-0 shadow-2xl md:portrait:shadow-none lg:landscape:shadow-none" : "-translate-x-full md:portrait:translate-x-0 lg:landscape:translate-x-0"}
        `}
        onClick={(e) => {
          // Close drawer when a nav link is clicked. The link's own
          // navigation still fires (we don't preventDefault).
          if (
            e.target instanceof HTMLElement &&
            e.target.closest("a[href]")
          ) {
            close();
          }
        }}
      >
      <div className="h-16 max-lg:landscape:h-11 shrink-0 flex items-center gap-2 px-5 max-lg:landscape:px-3 border-b border-zinc-200 dark:border-zinc-800">
        <Radio className="h-5 w-5 max-lg:landscape:h-4 max-lg:landscape:w-4 text-blue-500 shrink-0" />
        <span className="font-semibold tracking-tight max-lg:landscape:text-sm truncate">
          ESPresense Hub
        </span>
      </div>
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
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
      <div className="shrink-0 p-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
        <div
          className="px-3 py-1 text-xs space-y-1"
          title={
            // Shove the host detail into the tooltip when it's hidden
            // from the inline view (mobile landscape) so it remains
            // discoverable on hover/long-press.
            status?.mqtt.error ?? status?.mqtt.host ?? undefined
          }
        >
          {/* Mobile-landscape compact: dot + count on the left, unit
              toggle on the right. The "MQTT [Connected]" label is
              implicit (the colored dot conveys it) and the host detail
              is in the tooltip. Saves an entire row of vertical space. */}
          <div className="hidden max-lg:landscape:flex items-center gap-2 justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
              {status && (
                <span className="text-zinc-500 dark:text-zinc-400 truncate">
                  {status.nodeCount} nodes · {status.deviceCount} devices
                </span>
              )}
            </div>
            {unitToggle}
          </div>

          {/* Default view: full status text + host + count. */}
          <div className="max-lg:landscape:hidden space-y-1">
            <div className={`flex items-center gap-2 ${style.text}`}>
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`}
              />
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
        </div>
        <div className="px-3 flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-400">
            units
          </span>
          <div
            className="inline-flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-xs font-medium"
            role="group"
            aria-label="Unit system"
          >
            <button
              type="button"
              onClick={() => setUnits("metric")}
              className={`px-2 py-0.5 transition-colors ${
                units === "metric"
                  ? "bg-blue-500 text-white"
                  : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
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
                  : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
              aria-pressed={units === "imperial"}
            >
              in
            </button>
          </div>
        </div>
      </div>
    </aside>
    </>
  );
}
