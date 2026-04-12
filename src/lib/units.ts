/**
 * Unit conversion + parsing for distance inputs.
 *
 * Internal storage is always meters. UI components ask the UnitsProvider
 * for the current preference and use these helpers to convert at the edges.
 */

export type UnitSystem = "metric" | "imperial";

export const M_PER_IN = 0.0254;
export const IN_PER_M = 1 / M_PER_IN;

export function metersToInches(m: number): number {
  return m * IN_PER_M;
}

export function inchesToMeters(i: number): number {
  return i * M_PER_IN;
}

/**
 * Parse a free-form imperial distance string. Accepts:
 *   - bare numbers: `210`, `5.5`             → inches
 *   - feet only:    `17'`, `5.5ft`, `17 feet`
 *   - inches only:  `6"`, `6in`, `6 inches`
 *   - combined:     `17'6`, `17' 6"`, `17ft 6in`, `17 feet 6 inches`
 *
 * Returns the value in inches, or null if the string can't be parsed.
 */
export function parseImperial(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;

  // Pull out feet and inches independently. Longer alternatives must come
  // first in the alternation so "inches" wins over "in".
  const ftMatch = trimmed.match(/(-?\d+(?:\.\d+)?)\s*(?:feet|ft|')/);
  const inMatch = trimmed.match(/(-?\d+(?:\.\d+)?)\s*(?:inches|in|")/);

  if (ftMatch || inMatch) {
    const ft = ftMatch ? parseFloat(ftMatch[1]) : 0;
    const inch = inMatch ? parseFloat(inMatch[1]) : 0;
    if (Number.isNaN(ft) || Number.isNaN(inch)) return null;
    return ft * 12 + inch;
  }

  // No unit suffix → treat as plain inches.
  const num = parseFloat(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse a distance input in the current unit system. Returns meters, or
 * null if the input is invalid.
 */
export function parseDistance(
  text: string,
  units: UnitSystem,
): number | null {
  if (units === "imperial") {
    const inches = parseImperial(text);
    if (inches == null) return null;
    return inchesToMeters(inches);
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = parseFloat(trimmed);
  return Number.isFinite(m) ? m : null;
}

/**
 * Canonical input value (used inside <input value={...}>). Decimal numbers
 * only — `5.33` for metric, `210.00` for imperial. Display formats live in
 * `formatDistanceDisplay`.
 */
export function formatForInput(meters: number, units: UnitSystem): string {
  if (units === "imperial") {
    return metersToInches(meters).toFixed(2);
  }
  return meters.toFixed(2);
}

/**
 * Read-only display formatter. Uses feet'inches" notation for imperial
 * values >= 12 inches so absolute coordinates stay readable.
 *
 * The inches value is rounded to one decimal place *before* splitting into
 * feet and inches, so we can never end up displaying something like
 * "20′ 12.0″" (which should roll over to "21′ 0.0″").
 */
export function formatDistanceDisplay(
  meters: number,
  units: UnitSystem,
): string {
  if (units === "imperial") {
    const inches = metersToInches(meters);
    const sign = inches < 0 ? "−" : "";
    const absRounded = Math.round(Math.abs(inches) * 10) / 10;
    if (absRounded >= 12) {
      const ft = Math.floor(absRounded / 12);
      const rem = absRounded - ft * 12;
      return `${sign}${ft}′ ${rem.toFixed(1)}″`;
    }
    return `${sign}${absRounded.toFixed(1)}″`;
  }
  return `${meters.toFixed(2)} m`;
}

/** Per-unit "nudge" step (one arrow-key press). */
export function stepMetersFor(units: UnitSystem): number {
  return units === "imperial" ? M_PER_IN : 0.05;
}

/** Suffix to render after the input ("m" or "in"). */
export function unitSuffix(units: UnitSystem): string {
  return units === "imperial" ? "in" : "m";
}
