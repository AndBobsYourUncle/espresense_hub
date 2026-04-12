import type { DeviceMatch } from "@/lib/config";

/**
 * Glob matcher: `*` wildcards, all other characters literal.
 * Used for matching config `devices` / `exclude_devices` rules against
 * runtime device IDs and names.
 */
function globToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except `*`, then replace `*` with `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

// Simple per-process cache so we're not recompiling regexes on every message.
const regexCache = new Map<string, RegExp>();
function getRegex(pattern: string): RegExp {
  let rx = regexCache.get(pattern);
  if (!rx) {
    rx = globToRegex(pattern);
    regexCache.set(pattern, rx);
  }
  return rx;
}

/** Does a single rule match this device? */
function ruleMatches(
  rule: DeviceMatch,
  deviceId: string,
  deviceName: string | undefined,
): boolean {
  if (rule.id) {
    if (getRegex(rule.id).test(deviceId)) return true;
  }
  if (rule.name) {
    if (deviceName != null && getRegex(rule.name).test(deviceName)) return true;
  }
  return false;
}

/**
 * Determine whether a device should be tracked.
 *
 * Mirrors upstream behavior:
 *   - If `exclude_devices` matches → not tracked.
 *   - Else if `devices` is empty → tracked (default permissive).
 *   - Else → tracked iff some `devices` rule matches.
 */
export function isDeviceTracked(
  deviceId: string,
  deviceName: string | undefined,
  includes: readonly DeviceMatch[],
  excludes: readonly DeviceMatch[],
): boolean {
  for (const rule of excludes) {
    if (ruleMatches(rule, deviceId, deviceName)) return false;
  }
  if (includes.length === 0) return true;
  for (const rule of includes) {
    if (ruleMatches(rule, deviceId, deviceName)) return true;
  }
  return false;
}
