import { EventEmitter } from "node:events";

/**
 * Process-wide event bus for runtime state changes that subscribers
 * (currently just the positions SSE endpoint) want to be notified of.
 *
 * Why a separate module: store.ts is imported from many places, and
 * adding event-emit calls inline forces those modules to indirectly
 * depend on EventEmitter. Splitting the bus out keeps store.ts pure
 * data-and-mutation, while subscribers (handlers, SSE) couple only to
 * this lightweight module.
 *
 * **HMR safety**: the emitter is stashed on globalThis, mirroring the
 * pattern used by `store.ts` and `bootstrap.ts`. Without this, Next's
 * dev-mode module re-import (HMR) creates multiple emitter instances —
 * the MQTT handler ends up emitting on one while SSE clients listen on
 * another, and no position events ever reach the client. Lost an hour
 * to this in dev before realizing the symptoms (snapshot arrives but
 * no per-device updates) pointed exactly here.
 *
 * Event semantics:
 *   - "position-changed" — fired with the deviceId whenever a device's
 *     position, upstream position, or locator-comparison stats are
 *     updated. Subscribers should re-read the device's current state
 *     rather than relying on payload data — fast-burst updates within
 *     the same event-loop tick are debounced by subscribers, and the
 *     payload would be stale by the time the listener runs anyway.
 *
 * MaxListeners is bumped because in steady state we may have a handful
 * of SSE clients connected (each connected map view is one), plus any
 * future internal subscribers. Default 10 would warn in normal use.
 */
const globalForEvents = globalThis as unknown as {
  __espresensePositionEvents?: EventEmitter;
};

export const positionEvents: EventEmitter =
  globalForEvents.__espresensePositionEvents ?? new EventEmitter();
positionEvents.setMaxListeners(50);
globalForEvents.__espresensePositionEvents = positionEvents;

/** Notify subscribers that a device's position-related state changed. */
export function emitPositionChange(deviceId: string): void {
  positionEvents.emit("position-changed", deviceId);
}
