import type { NodePairFit, PairStats } from "@/lib/calibration/autofit";
import type {
  NodeTelemetry,
  NormalizedMeasurement,
} from "@/lib/mqtt/messages";
import { kalmanStep } from "./kalman";
import { smoothMeasurementDistance } from "./measurement_smoothing";
import { smoothDevicePosition } from "./smoothing";

/**
 * Active position filter, set at bootstrap from `filtering.position_filter`
 * in config.yaml. Defaults to `kalman` — see `setPositionFilter`.
 */
export type PositionFilter = "kalman" | "ema" | "none";
let positionFilter: PositionFilter = "kalman";

export function setPositionFilter(mode: PositionFilter): void {
  positionFilter = mode;
}

/**
 * In-memory runtime state for the hub.
 *
 * Lives as a per-process singleton (survives HMR via globalThis). This is
 * intentionally simple: the MQTT handler writes, server components read.
 * Eventually an SSE/WebSocket layer will push updates to the UI.
 */

export interface NodeState {
  id: string;
  online: boolean;
  status?: string;
  statusAt?: number;
  telemetry?: NodeTelemetry;
  telemetryAt?: number;
}

export interface DeviceMeasurement extends NormalizedMeasurement {
  nodeId: string;
  lastSeen: number;
  /**
   * Per-node EMA of `distance`, updated on every incoming measurement.
   * The solver uses this instead of the raw `distance` field so RSSI
   * jitter averages out instead of landing directly in the fit. See
   * `measurement_smoothing.ts` for the time constant and reset rules.
   */
  smoothedDistance?: number;
  /** Timestamp of the sample whose raw value was last blended in. */
  smoothedAt?: number;
  /**
   * Running variance of the raw distance around the smoothed mean.
   * High variance = node's readings fluctuate a lot (body-shadow,
   * multipath). Used by the solver to down-weight unreliable nodes.
   */
  distanceVariance?: number;
}

export interface AlternativePosition {
  x: number;
  y: number;
  z: number;
  algorithm: string;
}

export interface DevicePosition {
  x: number;
  y: number;
  z: number;
  confidence: number;
  fixes: number;
  algorithm: string;
  computedAt: number;
  /**
   * Positions computed by alternative (non-active) locators for side-by-side
   * comparison. Each entry is the raw, unwrapped result of one base locator
   * (IDW, NM, BFGS, MLE). Surfaced as ghost markers when compare mode is on.
   */
  alternatives?: AlternativePosition[];
}

export interface DeviceState {
  id: string;
  name?: string;
  firstSeen: number;
  lastSeen: number;
  /** Latest measurement from each reporting node, keyed by nodeId. */
  measurements: Map<string, DeviceMeasurement>;
  /** Most recent locator output for this device. */
  position?: DevicePosition;
  /**
   * Per-device Kalman filter state. Holds [x, y, z, vx, vy, vz] plus a
   * 6×6 covariance matrix. Only populated when `filtering.position_filter`
   * is `kalman` (the default). EMA mode leaves this undefined.
   */
  kalman?: import("./kalman").KalmanState;
}

export interface MqttConnectionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  host?: string;
  error?: string;
  lastConnectedAt?: number;
  lastMessageAt?: number;
  messageCount: number;
}

/** A single ground-truth sample: one node observing another known node. */
export interface GroundTruthSample {
  transmitterId: string;
  measured: number;
  trueDist: number;
  /** Firmware absorption value at the time the sample was recorded. */
  absorptionAtTime: number;
  timestamp: number;
}

const GT_SAMPLES_PER_NODE = 1000;

/**
 * Per-device config received from `espresense/settings/{originalId}/config`.
 * Mirrors the companion's `DeviceSettings` model. The `originalId` is
 * the MQTT topic ID (usually an IRK like `irk:7e45...`), and `id` is the
 * alias (`nicks_watch`). We index both ways so lookups by either work.
 */
export interface DeviceSettings {
  /** The original MQTT topic device ID (IRK, MAC, etc.). */
  originalId: string;
  /** Alias set by the user in the companion/firmware UI. */
  id?: string;
  name?: string;
  /** Per-device reference RSSI at 1m, in dBm. */
  refRssi?: number;
  x?: number;
  y?: number;
  z?: number;
}
const MAX_PINS_PER_DEVICE = 50;

/**
 * Streaming bias statistics for a single (pin, node) pair.
 * Accumulates while the pin is "active" (device is stationed there).
 * Bias = measured_distance / true_distance_to_pin.
 */
export interface PinNodeBiasStats {
  /** Number of samples that contributed. */
  sampleCount: number;
  /** Sum of bias values — used to derive running mean. */
  sumBias: number;
  /** Sum of bias² — used to derive running variance. */
  sumBias2: number;
  /** Timestamp of the most recent update. */
  lastUpdateMs: number;
}

/**
 * A user-placed ground-truth pin: "this device was at this position."
 *
 * Two kinds of data on each pin:
 *   1. `measurements` — single snapshot at pin-time (for instant
 *      bias initialization the moment a pin is placed)
 *   2. `nodeBias` — running statistics accumulated while the pin is
 *      "active" (device is sitting at this location). Far more
 *      robust than a single snapshot — averages out RSSI noise and
 *      momentary body-orientation effects.
 *
 * `activeUntilMs`: the pin is currently accepting new sample
 * accumulation while now < activeUntilMs. Auto-extended each time
 * we see the device is still stationary near this pin; auto-cleared
 * on detected motion or explicit user deactivation.
 */
export interface DeviceGroundTruthPin {
  deviceId: string;
  /** User-provided position in config-space meters. */
  position: readonly [number, number, number];
  /** nodeId → smoothedDistance at pin time (initial snapshot). */
  measurements: Map<string, number>;
  /** nodeId → accumulated bias statistics over the pin's active periods. */
  nodeBias: Map<string, PinNodeBiasStats>;
  /** When this pin was first placed. */
  timestamp: number;
  /** Until when this pin should accept new samples. 0 = inactive. */
  activeUntilMs: number;
}


/** Running aggregate of leave-one-out residuals per node, in meters. */
export interface NodeResidualStats {
  count: number;
  /** Sum of signed residuals (measured − expected). */
  sum: number;
  /** Sum of squared residuals — needed for stddev. */
  sumSq: number;
  lastUpdated: number;
  /** Debug: most recent raw sample for diagnosis. */
  lastDeviceId?: string;
  lastMeasured?: number;
  lastTrue?: number;
}

export class Store {
  readonly nodes = new Map<string, NodeState>();
  readonly devices = new Map<string, DeviceState>();
  readonly mqtt: MqttConnectionState = {
    status: "disconnected",
    messageCount: 0,
  };
  /**
   * Live `nodeId → 3D position` lookup used by the locator. Populated from
   * config at bootstrap, then mutated directly by the node editor so position
   * edits propagate to trilateration without a server restart.
   */
  readonly nodeIndex = new Map<
    string,
    readonly [number, number, number]
  >();
  /**
   * Per-node leave-one-out residual statistics, accumulated as device
   * measurements arrive. Used by the calibration diagnostics page.
   */
  readonly nodeResiduals = new Map<string, NodeResidualStats>();
  /**
   * Per-node retained settings published by ESPresense firmware
   * (absorption, rx_adj_rssi, tx_ref_rssi, etc.) — keyed `nodeId → key → value`.
   * Values are kept as raw strings; callers parse if they need a number.
   */
  readonly nodeSettings = new Map<string, Map<string, string>>();
  /**
   * Ground-truth residual stats: when one node observes another node's
   * BLE broadcast, we know the *actual* distance from config positions
   * — no locator approximation needed. Indexed by the listening (source)
   * node id. This is way more reliable than the leave-one-out residuals.
   */
  readonly nodeGroundTruthResiduals = new Map<string, NodeResidualStats>();
  /**
   * Ring buffer of recent ground-truth samples per listener node, used by
   * the auto-fit calibration code. Newest at the end. Bounded so memory
   * stays trivial.
   */
  readonly nodeGroundTruthSamples = new Map<string, GroundTruthSample[]>();
  /**
   * Cached per-(listener, transmitter) calibration fits. Derived from
   * the streaming sufficient statistics in `nodePairFitStats` — this
   * map is the "current view" PathAware reads at solve time.
   */
  readonly nodePairFits = new Map<string, Map<string, NodePairFit>>();
  /**
   * Streaming sufficient statistics for per-pair `n_real` estimation.
   * Since `d_real` is constant per pair, we fit only the exponent
   * (time-weighted mean of `n_i` values), not a full 2-parameter
   * regression. Updated incrementally on every ground-truth sample.
   * Seeded on bootstrap from the ring buffer.
   */
  readonly nodePairFitStats = new Map<string, Map<string, PairStats>>();
  /**
   * User-placed ground-truth pins per device. Each pin is a snapshot
   * "device was here, with these measurements." Multiple pins per
   * device build a spatial bias map — see device_bias.ts. Persisted
   * to disk via device_persistence.ts.
   */
  readonly devicePins = new Map<string, DeviceGroundTruthPin[]>();
  /**
   * Per-device settings received from retained MQTT messages on
   * `espresense/settings/{originalId}/config`. Two indexes:
   * - `deviceSettingsById`: originalId (IRK) → settings
   * - `deviceSettingsByAlias`: alias (e.g. "nicks_watch") → settings
   * Used to look up the original ID when publishing device config.
   */
  readonly deviceSettingsById = new Map<string, DeviceSettings>();
  readonly deviceSettingsByAlias = new Map<string, DeviceSettings>();

  private getOrCreateNode(id: string): NodeState {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, online: false };
      this.nodes.set(id, n);
    }
    return n;
  }

  updateNodeTelemetry(id: string, telemetry: NodeTelemetry): void {
    const n = this.getOrCreateNode(id);
    n.telemetry = telemetry;
    n.telemetryAt = Date.now();
    // A telemetry message is a strong signal the node is alive.
    n.online = true;
  }

  updateNodeStatus(id: string, status: string): void {
    const n = this.getOrCreateNode(id);
    n.status = status;
    n.statusAt = Date.now();
    n.online = status.toLowerCase() === "online";
  }

  updateDeviceMeasurement(
    deviceId: string,
    nodeId: string,
    measurement: NormalizedMeasurement,
  ): DeviceState {
    const now = Date.now();
    let d = this.devices.get(deviceId);
    if (!d) {
      d = {
        id: deviceId,
        name: measurement.name,
        firstSeen: now,
        lastSeen: now,
        measurements: new Map(),
      };
      this.devices.set(deviceId, d);
    }
    d.lastSeen = now;
    if (measurement.name) d.name = measurement.name;

    // Compute the per-node EMA + variance before we overwrite the
    // previous entry. The solver reads `smoothedDistance` and uses
    // `distanceVariance` to down-weight body-blocked nodes.
    const prev = d.measurements.get(nodeId);
    let smoothedDistance: number | undefined;
    let smoothedAt: number | undefined;
    let distanceVariance: number | undefined;
    if (measurement.distance != null && Number.isFinite(measurement.distance)) {
      const result = smoothMeasurementDistance(
        prev?.smoothedDistance,
        prev?.smoothedAt,
        prev?.distanceVariance,
        measurement.distance,
        now,
      );
      smoothedDistance = result.mean;
      distanceVariance = result.variance;
      smoothedAt = now;
    }

    d.measurements.set(nodeId, {
      ...measurement,
      nodeId,
      lastSeen: now,
      smoothedDistance,
      smoothedAt,
      distanceVariance,
    });
    return d;
  }

  setDevicePosition(deviceId: string, position: DevicePosition | null): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    if (!position) {
      d.position = undefined;
      d.kalman = undefined;
      return;
    }
    // Apply the active position filter. Kalman filter is the default —
    // tracks position AND velocity so motion is followed without lag,
    // while stationary devices still benefit from measurement noise
    // averaging. EMA is kept available as a fallback / A-B comparison
    // via `filtering.position_filter: ema` in config.yaml.
    // The alternatives array is passed through unchanged either way so
    // compare-mode ghost markers still show raw per-algorithm output.
    if (positionFilter === "kalman") {
      const next = kalmanStep(
        d.kalman,
        [position.x, position.y, position.z],
        position.confidence,
        position.computedAt,
      );
      d.kalman = next;
      d.position = {
        ...position,
        x: next.x[0],
        y: next.x[1],
        z: next.x[2],
      };
    } else if (positionFilter === "ema") {
      d.position = smoothDevicePosition(d.position, position);
    } else {
      // "none" — pass raw locator output straight through. Useful for
      // diagnosing whether smoothing is responsible for an artifact.
      d.position = position;
    }
  }

  setMqttStatus(next: Partial<MqttConnectionState>): void {
    Object.assign(this.mqtt, next);
  }

  noteMqttMessage(): void {
    this.mqtt.messageCount += 1;
    this.mqtt.lastMessageAt = Date.now();
  }
}

const globalForStore = globalThis as unknown as {
  __espresenseStore?: Store;
};

export function getStore(): Store {
  let store = globalForStore.__espresenseStore;
  if (!store) {
    store = new Store();
    globalForStore.__espresenseStore = store;
  }
  // HMR safety: if a Map field was added to Store *after* this singleton was
  // first constructed (a real risk during dev — the globalThis singleton
  // survives module reloads but TypeScript class field initializers do not
  // re-run on existing instances), materialize the field with a default.
  // The first cold restart of the dev server populates everything properly.
  type Mut = {
    nodeIndex?: Map<string, readonly [number, number, number]>;
    nodeResiduals?: Map<string, NodeResidualStats>;
    nodeSettings?: Map<string, Map<string, string>>;
    nodeGroundTruthResiduals?: Map<string, NodeResidualStats>;
    nodeGroundTruthSamples?: Map<string, GroundTruthSample[]>;
    nodePairFits?: Map<string, Map<string, NodePairFit>>;
    nodePairFitStats?: Map<string, Map<string, PairStats>>;
    devicePins?: Map<string, DeviceGroundTruthPin[]>;
    deviceSettingsById?: Map<string, DeviceSettings>;
    deviceSettingsByAlias?: Map<string, DeviceSettings>;
  };
  const mut = store as Mut;
  if (!mut.nodeIndex) mut.nodeIndex = new Map();
  if (!mut.nodeResiduals) mut.nodeResiduals = new Map();
  if (!mut.nodeSettings) mut.nodeSettings = new Map();
  if (!mut.nodeGroundTruthResiduals)
    mut.nodeGroundTruthResiduals = new Map();
  if (!mut.nodeGroundTruthSamples) mut.nodeGroundTruthSamples = new Map();
  if (!mut.nodePairFits) mut.nodePairFits = new Map();
  if (!mut.nodePairFitStats) mut.nodePairFitStats = new Map();
  if (!mut.devicePins) mut.devicePins = new Map();
  if (!mut.deviceSettingsById) mut.deviceSettingsById = new Map();
  if (!mut.deviceSettingsByAlias) mut.deviceSettingsByAlias = new Map();
  return store;
}

/** Mean of the signed residuals — the per-node distance bias. */
export function meanResidual(s: NodeResidualStats): number {
  return s.count > 0 ? s.sum / s.count : 0;
}

/** Sample standard deviation of residuals. */
export function stddevResidual(s: NodeResidualStats): number {
  if (s.count < 2) return 0;
  const mean = s.sum / s.count;
  const variance = s.sumSq / s.count - mean * mean;
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Free-function update so the call site doesn't depend on the Store class
 * having a method (HMR-stale singletons may be missing methods added later).
 */
export function recordNodeResidual(
  store: Store,
  nodeId: string,
  residual: number,
): void {
  let s = store.nodeResiduals.get(nodeId);
  if (!s) {
    s = { count: 0, sum: 0, sumSq: 0, lastUpdated: 0 };
    store.nodeResiduals.set(nodeId, s);
  }
  s.count += 1;
  s.sum += residual;
  s.sumSq += residual * residual;
  s.lastUpdated = Date.now();
}

export function resetNodeResiduals(store: Store): void {
  store.nodeResiduals.clear();
  store.nodeGroundTruthResiduals.clear();
  store.nodeGroundTruthSamples.clear();
}

/** Append a ground-truth sample to the per-node ring buffer. */
export function recordGroundTruthSample(
  store: Store,
  listenerId: string,
  sample: GroundTruthSample,
): void {
  let buf = store.nodeGroundTruthSamples.get(listenerId);
  if (!buf) {
    buf = [];
    store.nodeGroundTruthSamples.set(listenerId, buf);
  }
  buf.push(sample);
  // Bound the buffer; drop oldest entries.
  if (buf.length > GT_SAMPLES_PER_NODE) {
    buf.splice(0, buf.length - GT_SAMPLES_PER_NODE);
  }
}

/** Ground-truth (node-to-node) residual aggregator. */
export function recordGroundTruthResidual(
  store: Store,
  listenerId: string,
  residual: number,
  debug?: { deviceId: string; measured: number; trueDist: number },
): void {
  let s = store.nodeGroundTruthResiduals.get(listenerId);
  if (!s) {
    s = { count: 0, sum: 0, sumSq: 0, lastUpdated: 0 };
    store.nodeGroundTruthResiduals.set(listenerId, s);
  }
  s.count += 1;
  s.sum += residual;
  s.sumSq += residual * residual;
  s.lastUpdated = Date.now();
  if (debug) {
    s.lastDeviceId = debug.deviceId;
    s.lastMeasured = debug.measured;
    s.lastTrue = debug.trueDist;
  }
}

/** Record a per-node retained setting (e.g. absorption, rx_adj_rssi). */
export function recordNodeSetting(
  store: Store,
  nodeId: string,
  key: string,
  value: string,
): void {
  let m = store.nodeSettings.get(nodeId);
  if (!m) {
    m = new Map();
    store.nodeSettings.set(nodeId, m);
  }
  m.set(key, value);
}
