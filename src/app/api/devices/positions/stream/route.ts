import { positionEvents } from "@/lib/state/events";
import { getStore } from "@/lib/state/store";
import { buildDevicePositionDTO } from "../route";

export const dynamic = "force-dynamic";
// Streams forever; never let Next try to cache or pre-render.
export const runtime = "nodejs";

/**
 * Server-Sent Events stream of device position updates.
 *
 * Why SSE: the polling endpoint is fine for a snapshot view, but the
 * underlying device positions update on every MQTT message — typically
 * 5–10 Hz per active device. Polling at 1 Hz misses 80%+ of state
 * transitions, which makes algorithmic comparisons (RoomAware vs
 * RfRoomAware vs Bayesian, etc.) look smoother than they actually are
 * and hides locator instability that's worth seeing in real time.
 *
 * Protocol:
 *   - On connect: a single `event: snapshot` containing the full
 *     current devices list. Lets a fresh client render immediately
 *     without waiting for the next position update.
 *   - On every position change (from `setDevicePosition` /
 *     `setDeviceUpstreamPosition`): one `event: position` per device,
 *     debounced to coalesce same-tick bursts (the handler updates
 *     position then writes locator comparisons synchronously; firing
 *     on a `setImmediate` ensures the DTO sees the post-comparison
 *     state).
 *   - Periodic `: heartbeat` comments (every 20 s) keep the connection
 *     alive through proxies that idle-close.
 */

const HEARTBEAT_MS = 20_000;

export function GET() {
  const store = getStore();
  const encoder = new TextEncoder();
  // Teardown closure shared between start() and cancel() — set in
  // start, called from cancel. Lifted to outer scope because
  // ReadableStream's cancel() doesn't get a controller reference.
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Per-tick debounce: collect dirty device IDs as events arrive,
      // then drain once on setImmediate. Coalesces multi-emit bursts
      // (e.g. one MQTT message triggering setDevicePosition followed
      // by N recordLocatorComparison calls — though only the position
      // emit fires) into a single SSE write per device per tick.
      const dirty = new Set<string>();
      let scheduled = false;

      const send = (event: string, data: string): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // Controller closed (client disconnected) — listeners will be
          // torn down by the cancel() handler below.
        }
      };

      const flush = (): void => {
        scheduled = false;
        for (const id of dirty) {
          const d = store.devices.get(id);
          if (!d) continue;
          const dto = buildDevicePositionDTO(d);
          if (!dto) continue;
          send("position", JSON.stringify(dto));
        }
        dirty.clear();
      };

      const onChange = (deviceId: string): void => {
        dirty.add(deviceId);
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
      };

      // Initial snapshot — gives the client a full view before the
      // first incremental update arrives.
      const devices = [];
      for (const d of store.devices.values()) {
        const dto = buildDevicePositionDTO(d);
        if (dto) devices.push(dto);
      }
      send(
        "snapshot",
        JSON.stringify({ devices, serverTime: Date.now() }),
      );

      positionEvents.on("position-changed", onChange);

      // Heartbeat: SSE comments (lines starting with `:`) are ignored
      // by the EventSource spec but keep the underlying TCP connection
      // alive. Important for proxies (nginx, cloudflare) that close
      // idle connections after 30–60 s.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // controller closed
        }
      }, HEARTBEAT_MS);

      teardown = (): void => {
        positionEvents.off("position-changed", onChange);
        clearInterval(heartbeat);
      };
    },

    cancel(): void {
      // Listeners need to be removed or we leak per-connection event-
      // emitter entries (and eventually exceed maxListeners).
      teardown?.();
      teardown = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable nginx response buffering for SSE — without this, the
      // proxy may hold messages in a buffer until it fills, completely
      // defeating the live-stream property.
      "X-Accel-Buffering": "no",
    },
  });
}
