"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DeviceDetailDTO } from "@/app/api/devices/[id]/route";

interface DeviceSelectionContextValue {
  /** The currently selected device id, or null if nothing selected. */
  selectedId: string | null;
  /** Latest fetched detail for the selected device. */
  detail: DeviceDetailDTO | null;
  /** True while the first detail fetch for the current selection is in flight. */
  loading: boolean;
  /** Set or clear the selection (updates URL via shallow replace). */
  select: (id: string | null) => void;
}

const DeviceSelectionContext =
  createContext<DeviceSelectionContextValue | null>(null);

export function useDeviceSelection(): DeviceSelectionContextValue {
  const ctx = useContext(DeviceSelectionContext);
  if (!ctx) {
    throw new Error(
      "useDeviceSelection must be used inside <DeviceSelectionProvider>",
    );
  }
  return ctx;
}

const POLL_INTERVAL_MS = 1000;

export default function DeviceSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedId = params.get("device");

  const [detail, setDetail] = useState<DeviceDetailDTO | null>(null);
  const [loading, setLoading] = useState(false);

  // Clear stale detail when the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    setDetail(null);
    setLoading(true);
  }, [selectedId]);

  // Poll the detail endpoint while a device is selected.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/devices/${encodeURIComponent(selectedId)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (!res.ok) {
          setDetail(null);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as DeviceDetailDTO;
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      } catch {
        // swallow — next tick will retry
      }
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId]);

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id == null) {
        next.delete("device");
      } else {
        next.set("device", id);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [params, pathname, router],
  );

  // ESC to close.
  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, select]);

  return (
    <DeviceSelectionContext.Provider
      value={{ selectedId, detail, loading, select }}
    >
      {children}
    </DeviceSelectionContext.Provider>
  );
}
