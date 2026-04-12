"use client";

import { createContext, useContext, useState } from "react";

interface PinHighlightCtx {
  /** Timestamp of the pin currently being hovered in the panel (or null). */
  hoveredTimestamp: number | null;
  setHoveredTimestamp: (ts: number | null) => void;
}

const Ctx = createContext<PinHighlightCtx | null>(null);

/**
 * Shared hover state between the device detail panel's pin list and
 * the map's PinOverlay. When a row in the panel is hovered, the
 * corresponding pin marker glows on the map — even when the pin tool
 * isn't active.
 */
export function usePinHighlight(): PinHighlightCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("usePinHighlight must be used inside <PinHighlightProvider>");
  return ctx;
}

export default function PinHighlightProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [hoveredTimestamp, setHoveredTimestamp] = useState<number | null>(null);
  return (
    <Ctx.Provider value={{ hoveredTimestamp, setHoveredTimestamp }}>
      {children}
    </Ctx.Provider>
  );
}
