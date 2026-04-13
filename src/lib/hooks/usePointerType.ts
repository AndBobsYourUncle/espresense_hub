"use client";

import { useEffect, useState } from "react";

/**
 * Reactive read of the user's primary pointer modality. Watches the
 * CSS `pointer: coarse` media query (true for touchscreens, false for
 * a precise pointer like a mouse or trackpad). Updates if the user
 * connects/disconnects an input device mid-session.
 *
 * Default during SSR / before mount: `"fine"` — assume desktop.
 * Avoids a hydration flash that would say "long-press" then flip to
 * "shift+click" milliseconds later for the majority case.
 */
export type PointerType = "fine" | "coarse";

export function usePointerType(): PointerType {
  const [type, setType] = useState<PointerType>("fine");
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setType(mq.matches ? "coarse" : "fine");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return type;
}

/** Convenience: true on touchscreens / styluses. */
export function useIsTouch(): boolean {
  return usePointerType() === "coarse";
}
