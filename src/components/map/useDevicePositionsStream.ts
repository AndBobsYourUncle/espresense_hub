"use client";

import { useEffect, useRef, useState } from "react";
import type {
  DevicePositionDTO,
  DevicePositionsResponse,
} from "@/app/api/devices/positions/route";

/**
 * Live device-positions hook backed by Server-Sent Events.
 *
 * Why SSE instead of polling: the underlying server recomputes
 * positions on every MQTT message — typically 5–10 Hz per active
 * device. Polling at 1 Hz misses 80%+ of state transitions, which is
 * fine for "where is this device" but terrible for diagnosing locator
 * behavior (jumpy/stable, when each algorithm disagrees, etc.).
 *
 * Connection lifecycle:
 *   1. Open EventSource on mount.
 *   2. Server sends initial `event: snapshot` with all current
 *      positions; we replace the local map.
 *   3. Server sends `event: position` per-device on each update; we
 *      merge into the local map.
 *   4. Server sends `: heartbeat` comments every 20 s so proxies
 *      don't idle-close the connection. EventSource ignores comments.
 *   5. On disconnect, EventSource auto-reconnects with exponential
 *      backoff (built-in browser behavior) — no fallback polling
 *      needed because the spec already handles this.
 *   6. On unmount, close the EventSource (browser stops auto-
 *      reconnecting).
 *
 * Returns:
 *   - `devices` — the current full list, freshly merged from the
 *     latest stream events. Stable identity within a render so
 *     consumers can map() over it without unnecessary re-renders.
 *   - `snapping` — true for one render after a tab refocus, telling
 *     the marker CSS to skip the transform transition for the
 *     catch-up render. Without this, the dot would slide across
 *     the map after returning to a backgrounded tab.
 */
export function useDevicePositionsStream(): {
  devices: DevicePositionDTO[];
  snapping: boolean;
} {
  const [devices, setDevices] = useState<DevicePositionDTO[]>([]);
  const [snapping, setSnapping] = useState(false);
  // Map keyed by device id for O(1) merge on per-device updates.
  // Held in a ref to avoid re-creating the map on every render.
  const byId = useRef<Map<string, DevicePositionDTO>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const es = new EventSource("/api/devices/positions/stream");

    const publish = (): void => {
      if (cancelled) return;
      // Convert map → array for the consumer. Sort by id so render
      // order is stable across updates (otherwise React's keyed list
      // reconciliation works correctly but it's nicer for debugging
      // to have predictable order).
      const arr = [...byId.current.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      setDevices(arr);
    };

    es.addEventListener("snapshot", (e) => {
      try {
        const data = JSON.parse(
          (e as MessageEvent<string>).data,
        ) as DevicePositionsResponse;
        byId.current = new Map(data.devices.map((d) => [d.id, d]));
        publish();
      } catch {
        // Bad payload, ignore
      }
    });

    es.addEventListener("position", (e) => {
      try {
        const dto = JSON.parse(
          (e as MessageEvent<string>).data,
        ) as DevicePositionDTO;
        byId.current.set(dto.id, dto);
        publish();
      } catch {
        // Bad payload, ignore
      }
    });

    // EventSource auto-reconnects on its own — readyState toggles
    // between OPEN and CONNECTING. We don't need to do anything here
    // beyond letting the spec do its job. Logging the error helps
    // debug network/proxy issues.
    es.onerror = () => {
      // The browser will retry. If you see this fire repeatedly with
      // no recovery, check that the stream endpoint is reachable and
      // that no proxy is buffering text/event-stream responses.
      // Intentionally don't tear down here — readyState=2 (CLOSED) is
      // the only true terminal state, and that only happens if the
      // server returns a non-2xx response, which we treat as a hard
      // failure to be diagnosed manually.
    };

    // Tab refocus: snap (no-animation) the next render so the
    // marker doesn't slide across the map after a long background.
    // SSE keeps the data fresh while the tab is hidden, but the
    // map's CSS transitions still want to interpolate visually
    // when the tab comes back.
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      setSnapping(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSnapping(false));
      });
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      es.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { devices, snapping };
}
