import mqtt, { type MqttClient } from "mqtt";
import type { Config } from "@/lib/config";

const globalForMqtt = globalThis as unknown as {
  __espresenseMqttClient?: MqttClient;
};

export function getMqttClient(): MqttClient | null {
  return globalForMqtt.__espresenseMqttClient ?? null;
}

/**
 * Publish a per-node setting to ESPresense firmware (e.g. absorption,
 * rx_adj_rssi). The value is published with retain=true so it persists
 * on the broker after the node reads it once.
 */
export function publishNodeSetting(
  nodeId: string,
  key: string,
  value: string,
): Promise<void> {
  const client = getMqttClient();
  if (!client) {
    return Promise.reject(new Error("MQTT client not connected"));
  }
  const topic = `espresense/rooms/${nodeId}/${key}/set`;
  return new Promise((resolve, reject) => {
    client.publish(topic, value, { retain: true, qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Publish a per-device config to ESPresense firmware. The payload is a
 * JSON object published to `espresense/settings/{deviceId}/config` with
 * retain=true — same topic the companion uses.
 *
 * Currently used to push the computed `rssi@1m` after a ground-truth
 * pin calibrates a device's TX power.
 */
export function publishDeviceConfig(
  deviceId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const client = getMqttClient();
  if (!client) {
    return Promise.reject(new Error("MQTT client not connected"));
  }
  const topic = `espresense/settings/${deviceId}/config`;
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify(config),
      { retain: true, qos: 1 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

/**
 * Low-level publish for arbitrary topics. Used by the presence publisher
 * and anything else that needs to send to a topic not covered by the
 * typed helpers above.
 */
export function publishRaw(
  topic: string,
  payload: string,
  opts: { retain?: boolean; qos?: 0 | 1 | 2 } = {},
): Promise<void> {
  const client = getMqttClient();
  if (!client) return Promise.reject(new Error("MQTT client not connected"));
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      payload,
      { retain: opts.retain ?? false, qos: opts.qos ?? 1 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export function connectMqtt(config: Config): MqttClient {
  const existing = globalForMqtt.__espresenseMqttClient;
  if (existing) return existing;

  const { host, port, ssl, username, password, client_id } = config.mqtt;
  if (!host) {
    throw new Error(
      "mqtt.host is not configured — cannot connect to broker",
    );
  }

  const protocol = ssl ? "mqtts" : "mqtt";
  const url = `${protocol}://${host}:${port}`;

  const client = mqtt.connect(url, {
    clientId: client_id,
    username,
    password,
    reconnectPeriod: 5000,
    keepalive: 30,
    clean: true,
  });

  globalForMqtt.__espresenseMqttClient = client;
  return client;
}
