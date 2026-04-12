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

## Why a different locator?

### The problem with how positioning normally works

ESPresense nodes turn RSSI (signal strength) into a distance estimate using a path-loss equation. The upstream companion offers several locators (Nadaraya-Watson, Nelder-Mead, BFGS, MLE, nearest-node) — but they all do roughly the same thing under the hood:

> "Given each node's distance estimate to this device, find the (x, y, z) point that best fits all of them at once."

That works fine in an empty parking lot. In a real house it falls apart for a few reasons:

1. **One absorption value per node.** Walls, doors, and furniture attenuate signal. The companion lets you set one `absorption` number per node — but a node's signal to a teammate across a hallway behaves differently than its signal to a teammate through two walls. One number can't be right for both paths.
2. **No notion of which walls matter.** A node hearing a device through three walls reports a number, but that number is wildly less reliable than one in the same room. The optimizer doesn't know that — it just throws everything into the same least-squares fit. A loud-but-wrong reading from the wrong room can yank the fix sideways.
3. **No knowledge of the device.** Body shadow, antenna orientation, what room the device usually sits in — none of that is modeled. A watch on someone's wrist behaves very differently from a phone on a table, but the locator treats both the same.
4. **Outliers leak in.** A reflected signal that arrives "too soon" produces an artificially-short distance, and the optimizer happily absorbs it. There's no good way to say "this measurement is suspicious — down-weight it".

The result is a position that's "kind of right on average" but jumps around a lot, and tends to drift into the wrong room when a single noisy node dominates a fix.

### What this hub does differently

Three changes that compound:

**1. Each *pair* of nodes learns its own path loss, online, forever.**

Instead of one absorption number per node, the hub maintains streaming statistics for every `(listener, transmitter)` pair — exponentially time-decayed so old data fades and new data takes over smoothly. The path from node A to node B has its own path-loss exponent, separate from A→C or A→D. Walls between A and B don't poison node A's view of node C.

This data is collected for free: nodes constantly hear *each other*, and we know the true distance between any two stationary nodes from the config. Every measurement between a node pair is a free calibration sample — no manual tape-measuring required after initial setup.

**2. The room graph downweights through-wall measurements.**

Each measurement comes with a weight based on the room relationship between the listener and the device's likely room:

- **Same room** → weight 1.0 (full trust).
- **Adjacent room** (door / open passage) → weight 0.8 (somewhat trusted).
- **Cross-room** (separated by one or more walls with no declared opening) → weight 0.005 (almost ignored).

The device's "likely room" is decided by a weighted vote of the *closest-reporting* nodes, not from the position estimate. That avoids a chicken-and-egg trap where a wrong initial guess picks the wrong room and then keeps confirming itself.

In practice this means a noisy through-wall reading from a strong but distant node can't drag a fix out of the room it actually belongs in. The geometry of the home becomes part of the math.

**3. Per-(device, node) bias correction via pins.**

Even with perfect node calibration, the locator was systematically off by 3–4 m for one specific watch in one specific room. The cause turned out to be the watch's antenna interacting with that node's geometry — body shadow, orientation, wrist position. There is no global setting that fixes this; it's a property of *that device on that user in that room*.

Pins solve it. When you know a device is at a specific spot — your bedside table, your couch — you drop a pin on the map. While the device sits there (motion detection auto-deactivates), every measurement is recorded as a ground-truth sample: "node X reported distance Y, true distance was Z". A multiplicative bias accumulates per (device, node) pair. As you drop pins around the house for a device you care about, the system builds a spatial map of how that device's signal behaves at each node, and IDW-interpolates the correction smoothly to positions in between. The bias data persists across restarts, so the calibration only gets better with use.

For any device you don't pin, the system falls back gracefully to the per-pair calibration — no worse than the upstream behavior.

### Why these layer well together

The three are independent improvements that stack:

- Per-pair calibration handles environmental attenuation between pairs of *nodes*.
- Room weighting handles which measurements to trust *now*, given the geometry of the home.
- Pin biases handle *device-specific* effects that no node-side calibration can model.

Each one alone helps. Together they give a system that improves slowly and continuously while you live in the house — no recalibration ritual, no tape measure, no per-device tuning. Drop a pin when you notice your watch always reads as "wrong room"; the next day it's fixed.

### Compare mode

The map UI has a side-by-side compare mode that runs every locator on the *same* live measurement set and shows each one's position as a colored ghost marker. Useful for sanity-checking RoomAware against the alternatives, and for understanding why one algorithm pulls left while another pulls right.

Locators currently rendered:

| Locator | Color | What it does |
|---|---|---|
| **Room-Aware** (active) | orange | Circle-intersection geometry + GDOP + R² + room-graph weighting + per-(device, node) bias correction. The default. |
| **IDW** (nadaraya_watson) | violet | Inverse-distance² weighted average of node positions. Closed-form, no iteration. The companion's default. |
| **Nelder-Mead** | cyan | Simplex optimization on the squared-distance residual. |
| **BFGS** | emerald | Quasi-Newton gradient descent on the same residual. |
| **MLE** | pink | Maximum-likelihood estimation under a Gaussian noise model. |
| **Nearest Node** | amber | Picks the node reporting the smallest distance and places the marker at the *centroid of that node's room* — a faithful "device is somewhere in this room" baseline rather than pretending to know exact coordinates. |

That's a complete superset of the upstream companion's per-floor base locators (`nadaraya_watson`, `nelder_mead`, `bfgs`, `mle`, `nearest_node`). The companion's `multi_floor` isn't a separate algorithm in our model — our locators are 3D-native and select the floor implicitly from the Z coordinate of the fix.

All non-baseline locators are wrapped in an outlier-rejection layer that drops measurements with extreme residuals against an initial fit before solving again. `nearest_node` is intentionally left raw so the comparison shows the trivial heuristic's actual behavior.

### Other improvements

- **GDOP-aware confidence.** The position confidence score actually reflects whether the listener geometry around the device is good (well-distributed → low GDOP, high confidence) or poor (all listeners on one side → high GDOP, low confidence). The UI shows this breakdown.
- **R² weighting.** Pairs with a strong fit (low residual variance, lots of samples) get more weight in solves than pairs with a noisy fit.
- **Auto-applied calibration.** Small drift corrections are pushed back to nodes over MQTT every 5 min, gated and rate-limited so a bad sample window can't run away with your config. The audit log on the calibration page shows every push.
- **Modern stack.** Next.js (App Router), React 19, Tailwind 4, Zod schemas — type-safe end to end, hot-reloads while you tune.

## Getting the most out of it

A rough order of operations to dial in a fresh install:

### 1. Get the rooms right first

The room graph is foundational — if the locator doesn't know that your kitchen and dining room are open to each other, it will incorrectly suppress measurements that actually should be trusted. Spend the time on this *before* obsessing over node positions.

- Draw room polygons in `config.yaml` matching your floor plan as closely as you can. Exact corner coordinates beat approximations because the auto-edge-detection only fires when polygon edges share endpoints exactly.
- For open-plan zones (kitchen/living/dining), tag each room with the same `floor_area` string. They become all-mutually-adjacent in one stroke.
- For doorways between otherwise-walled rooms, declare `open_to:` between them. Bidirectional — only one side needs to declare it.
- Solid walls between rooms? Don't declare anything. The cross-room weight (0.005) is the right model.

### 2. Place nodes accurately

The X, Y, Z of each node directly drives the per-pair calibration baseline (distance between A and B is computed from these). An error of 30 cm in node placement is an error of 30 cm in every truth distance the calibration sees. Use a tape measure or LiDAR scan if you have one.

The map editor has a wall/corner snapping mode for entering positions relative to a wall edge — usually easier than measuring in absolute floor coordinates.

### 3. Let it run

The first hour of MQTT traffic populates initial per-pair fits. After about two hours of accumulation:

- Open `/calibration`. Each node should show a row with non-zero `LOO bias` (leave-one-out residual). A green dot means the node is well-calibrated against its peers.
- The auto-apply system starts pushing absorption corrections after the first 5 min cycle, rate-limited to once per node per 10 min. The audit panel shows what fired.
- If a node is consistently red (large bias), check its position. The most common cause is a 1–2 m error in the configured XYZ.

### 4. Pin your stationary devices

For each wearable or phone you care about positioning accurately:

- Select the device in the map UI.
- Switch to the pin tool and **shift+click** on the map at the device's actual location (e.g., your desk, your bedside table).
- The pin lights up and starts accumulating samples while the device is stationary. Motion auto-deactivates it.
- After a few minutes, that pin will have a few hundred samples and the per-(device, node) bias for nearby nodes will be well-calibrated.

Drop 3–5 pins around your home for the same device — the bias map gets richer and IDW interpolation handles positions in between. A single watch with pins at your bed, couch, desk, and dining table covers most of your day-to-day positioning needs.

### 5. Re-pin when things change

If you rearrange furniture, replace a node, or move a device's typical resting spot, the existing pins for that area become slightly stale. Drop a new pin at the new spot — the streaming bias accumulator gives the recent samples more weight, and old data fades. No reset needed.

### 6. Watch for systematic outliers

A single node with persistently red `GT bias` (ground-truth bias) usually means one of:

- Wrong physical position in `config.yaml` (most common).
- A wall or large object that wasn't there when you set up the floor plan.
- A failing antenna or a node behind metal (rare but possible).

The calibration page lets you click a row to see the per-pair breakdown — useful for spotting whether the bias is uniform (probably node placement) or directional (probably an obstruction in one specific direction).

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
