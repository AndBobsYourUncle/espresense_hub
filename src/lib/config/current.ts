import type { Config } from "./schema";

/**
 * Per-process live reference to the currently-active Config. Callers that
 * need to react to config changes (MQTT handler, presence publisher, device
 * cleanup, etc.) read from this holder rather than closing over a captured
 * value at bootstrap time, so saves via the Settings UI take effect without
 * a service restart.
 *
 * Bootstrap sets the initial value; the config save endpoint updates it after
 * a successful write + re-parse. globalThis-scoped so HMR reimports don't
 * reset the holder to undefined.
 */
const globalForConfig = globalThis as unknown as {
  __espresenseCurrentConfig?: Config;
};

export function setCurrentConfig(config: Config): void {
  globalForConfig.__espresenseCurrentConfig = config;
}

/**
 * Return the live config. Throws if bootstrap hasn't completed yet — any
 * caller that could race bootstrap must check first or live with the throw.
 * In practice this is only called from inside message handlers / interval
 * callbacks that can't fire until bootstrap has wired them up, so the throw
 * is a "should never happen" guardrail.
 */
export function getCurrentConfig(): Config {
  const cfg = globalForConfig.__espresenseCurrentConfig;
  if (!cfg) {
    throw new Error(
      "getCurrentConfig called before bootstrap completed — bug: caller should not run until after setCurrentConfig",
    );
  }
  return cfg;
}

/** Non-throwing variant for callers that need to tolerate the pre-bootstrap window. */
export function getCurrentConfigOrNull(): Config | null {
  return globalForConfig.__espresenseCurrentConfig ?? null;
}
