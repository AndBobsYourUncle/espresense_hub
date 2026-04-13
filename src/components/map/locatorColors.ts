/**
 * Color palette for the per-locator ghost markers in compare mode.
 * The active locator's marker stays orange (the device's primary color);
 * each alternative gets a distinct hue so the user can tell them apart
 * at a glance.
 */
export const LOCATOR_COLORS: Record<string, string> = {
  nadaraya_watson: "#a78bfa", // violet-400
  nelder_mead: "#22d3ee", // cyan-400
  bfgs: "#34d399", // emerald-400
  mle: "#f472b6", // pink-400
  nearest_node: "#fbbf24", // amber-400
  room_aware: "#f97316", // orange-500 (the active marker)
  upstream_companion: "#64748b", // slate-500 — neutral, signals "external reference"
};

export const LOCATOR_LABELS: Record<string, string> = {
  nadaraya_watson: "IDW",
  nelder_mead: "Nelder-Mead",
  bfgs: "BFGS",
  mle: "MLE",
  nearest_node: "Nearest",
  room_aware: "Room-Aware",
  upstream_companion: "ESP-Companion",
};

export function colorForLocator(name: string): string {
  return LOCATOR_COLORS[name] ?? "#94a3b8"; // slate-400 fallback
}

export function labelForLocator(name: string): string {
  return LOCATOR_LABELS[name] ?? name;
}
