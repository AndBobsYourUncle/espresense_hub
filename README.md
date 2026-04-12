# ESPresense Hub

A modernized Next.js replacement for [ESPresense-companion](https://github.com/ESPresense/ESPresense-companion) — the server side of an [ESPresense](https://espresense.com) BLE indoor-positioning system.

Reads the same `config.yaml`, talks to the same MQTT broker, drives the same firmware. Improvements take priority over 1:1 parity with the upstream C# companion.

## What it does

ESPresense ESP32 nodes scan for BLE devices around your home and publish RSSI readings to MQTT. This hub:

- Subscribes to those readings and turns them into `(x, y, z)` device positions in real time.
- Renders an interactive floor plan with rooms, walls, nodes, and devices, plus per-device measurement detail (which nodes saw it, residual error, confidence breakdown).
- Continuously calibrates the path-loss model — both per-node absorption and per-pair fits — from the live data.
- Lets you drop **pins** as ground-truth anchors when a device is at a known location. Pin samples accumulate over time and become per-(device, node) bias corrections that survive restarts.
- Auto-applies small calibration deltas back to the firmware over MQTT, gated and rate-limited so a bad sample can't run away with your config.

## Why fork?

The upstream companion is solid, but a few areas were worth rebuilding:

- **Per-pair calibration.** The original uses a single absorption value per node. This hub maintains streaming sufficient stats per `(listener, transmitter)` pair, so each path's effective path-loss exponent is learned independently. Walls between two specific nodes don't poison a node's global absorption.
- **Per-(device, node) bias correction.** The locator was repeatedly off by 3–4 m for a wearable in one specific room — node calibration was perfect, but the device's antenna interaction with that node's geometry was the culprit. Pins solve this by accumulating a multiplicative bias per device/node pair while the device sits at a known anchor. IDW interpolation spreads the correction smoothly across nearby positions.
- **RoomAware locator.** Combines circle-intersection geometry with GDOP weighting, R²-based pair quality, and a room-graph adjacency model. Nodes in a different room from the device are heavily down-weighted (cross-room ≈ 0.005), so a strong but through-the-wall reading doesn't drag a fix into the wrong space.
- **Modern stack.** Next.js (App Router), React 19, Tailwind 4, Zod schemas — type-safe end to end, hot-reloads while you tune.

## Getting started

### Prereqs

- Node.js 20+.
- An MQTT broker that ESPresense nodes are publishing to (typically the same one Home Assistant uses).
- At least one [ESPresense node](https://espresense.com) flashed and broadcasting.

### Configure

Copy the example config and edit it:

```bash
cp config.example.yaml config.yaml
```

At minimum, set `mqtt.host` and define your `floors[].rooms` and `nodes`. The schema is in `src/lib/config/schema.ts` and is intentionally compatible with upstream `config.yaml` files — most existing setups parse verbatim.

### Run

```bash
npm install
npm run dev
```

Open http://localhost:3000.

### Production

```bash
npm run build
npm start
```

### Deploy as a service (Debian/Ubuntu)

For a real always-on install on a VM/container/NAS:

```bash
sudo apt-get install -y git
sudo git clone https://github.com/your-user/espresense_hub.git /opt/espresense-hub
cd /opt/espresense-hub
sudo ./deploy/install.sh
```

That sets up an unprivileged user, installs Node.js if needed, builds, and writes a systemd unit. Config and accumulated calibration data live in `/var/lib/espresense-hub` so `git pull` never touches them. To update later: `sudo /opt/espresense-hub/deploy/update.sh`. Full details and tunables in [`deploy/README.md`](deploy/README.md).

## Configuration highlights

### Room adjacency

The room-aware locator weights measurements by whether the listener and the device are in the same room (1.0), an adjacent room (0.8), or unrelated (0.005). Adjacency comes from three sources, additively:

1. **Auto-detected** — two rooms whose polygons share an exact edge are assumed adjacent.
2. **`open_to`** — explicit per-pair declaration. Bidirectional. Use for doorways: `open_to: [Hallway]`.
3. **`floor_area`** — tag rooms with the same string and they form an all-to-all adjacency clique. Use for open-plan zones (kitchen/dining/living).

```yaml
- name: Living Room
  floor_area: main_open
  points: [...]
- name: Dining Room
  floor_area: main_open
  points: [...]
- name: Kitchen
  floor_area: main_open
  points: [...]
- name: Office
  open_to: [Hallway]   # door, not open zone
  points: [...]
```

### Pins (per-device calibration)

In the map UI, switch to the **pin** tool and click on the floor plan at a location where the selected device actually is. The pin becomes "active" and accumulates RSSI-vs-true-distance samples from every node that hears the device. Motion detection auto-deactivates the pin when the device moves. Drop multiple pins around the home for a device you care about (a watch, a phone) and the bias-correction layer learns the device's signature.

Pin data persists to `devices.json` and survives restarts.

### Persistence

Two JSON files live next to `config.yaml` and are written atomically every 60s plus on graceful shutdown:

- **`calibration.json`** — pair-fit streaming stats, ground-truth samples, residual aggregators. Restores per-pair calibration so PathAware doesn't cold-start.
- **`devices.json`** — per-device pins and accumulated per-node bias stats.

Both are `.gitignore`d and expected to grow with use.

## Project layout

```
src/
├── app/                  # Next.js App Router routes (UI + API)
│   ├── api/              # JSON endpoints (devices, calibration, nodes, ...)
│   └── (pages)/          # map, calibration, settings
├── components/           # React UI (map renderer, panels, overlays)
├── lib/
│   ├── bootstrap.ts      # one-shot server init: load state, connect MQTT, schedule timers
│   ├── calibration/      # autofit (per-pair), auto_apply, device_bias, pin accumulation
│   ├── config/           # YAML loader + Zod schema
│   ├── locators/         # path_aware, room_aware, nearest, IDW fallback
│   ├── mqtt/             # client + topic handlers
│   └── state/            # in-memory store + persistence (calibration, devices)
└── instrumentation.ts    # Next.js hook that calls bootstrap() once per server start
```

## Status

Active development. Used in production in one home — the original author's. Breaking changes between commits are possible while the calibration system stabilizes.

## License

TBD.
