# State-Tracker Architecture (working draft)

> **Status:** discussion in progress. Nothing here is committed; this
> is the running design doc we'll iterate on before writing code.
> Decisions get logged in the **Decisions** section as we make them.

## 1. Problem statement

Indoor positioning with BLE RSSI is fundamentally noisy and lossy:

- **Firmware reports a single distance per measurement** (RSSI converted via one absorption setting per node). The conversion is wrong some of the time — long open paths systematically undershoot, short walled paths overshoot.
- **Configured walls capture maybe 20–30% of real attenuation.** Multipath, body shadow, antenna patterns, and reflective leakage account for the rest.
- **Per-device variation** is large and persistent: same node sees different devices very differently due to antenna gain, mounting, and how the user wears them.
- **Per-position variation** for the same (device, node) pair is also large: body shadow flips with orientation, multipath geometry shifts, signal can leak through unmodeled paths.

We've built ten locators that each apply a different heuristic to compensate. The best of them (Room-Aware) gets it qualitatively right by *trusting topology over measurements*, but accuracy plateaus at ~1–3 m and there's no path to improve from here without adding fundamentally new inputs or a different framework.

## 2. What we have today

### Active stack

```
MQTT message (rssi, distance, etc.)
    ↓
MQTT handler: normalize, store DeviceMeasurement
    ↓
computeDevicePosition (per message, per device)
    ├── Apply per-(device, node) distance bias from pins (IDW interpolation)
    ↓
Pick locator (active = RoomAware) → solve(fixes)
    ↓
position
    ↓
Apply Kalman filter (per-device)
    ↓
d.position (the "current" position)
    ↓
Bayesian room tracker (separate per-device state, runs on Room-Aware output)
    ↓
Publish to MQTT (presence, position)
```

### Calibration data we already collect

- **Node-to-node `nReal`** per pair (calibrated path-loss exponent)
- **Per-node firmware absorption** (pushed via auto-apply)
- **Per-pin distance bias** per (device, node, pin position), accumulated while pin active
- **RF map**: walls, doors, exterior, with calibrated attenuation values

### What the existing locators do (one-line each)

| Locator | One-line |
|---|---|
| RoomAware | Pairwise circle-overlap centroid, weighted by topology (1.0/0.8/0.005) |
| RfRoomAware | Same as RoomAware but continuous RF-attenuation weighting + closest-node room prior + NM refinement |
| Bayesian | Wraps RoomAware; HMM forward-step over (room ∪ outside) with graph-based transitions |
| IDW (Nadaraya-Watson) | Weighted average of node positions by 1/d² |
| BFGS / MLE / NM | Trilateration solvers (least-squares minimization) |
| PathAware | IDW + per-pair n correction (mostly orphaned) |
| EnvironmentAware | BFGS with RF forward model in objective (orphaned) |
| RfPhysics | Various experiments — currently RSSI dB-space objective |

### Limitations of the current architecture

1. **Per-frame stateless fitting.** Each MQTT message recomputes position from scratch. Kalman is bolted on after, doesn't influence the fit.
2. **Calibration data is fragmented.** Distance bias on pins, `nReal` per pair, absorption per node — none combined into a single coherent model.
3. **Confidence is heuristic.** "1 / (1 + rmse)" type numbers, not real uncertainty.
4. **No spatial model of per-(device, node) noise.** Either fully trust a measurement or down-weight by 1/d² — no notion of "this node's signal to this device varies a lot" or "is consistent."
5. **Bayesian smoothing is only at the room level**, not the position level. Position can jump 2 m between frames even if device is stationary.

## 2.5 Asset stack (what we already have to work with)

The redesign sits on top of these existing assets. Understanding the stack drives the calibration cascade in §8.D2 and the bootstrap story in §7.

```
Tier 1 — Ground truth (known a priori, doesn't change):
  • Floor plan: room polygons, walls (interior + exterior), doors
  • Node positions (3D)
  • Node room assignments

Tier 2 — Derivable from Tier 1 + RF physics:
  • Predicted RSSI at any point: ref − 10n·log10(d) − W(p, node)
  • Wall/door/exterior obstruction loss for any line segment
  • The RF heatmap (already renders in the UI)

Tier 3 — Self-learning, ZERO user input required:
  • Continuous stream of (TX node, RX node, raw RSSI) over MQTT —
    every time one node hears another's BLE broadcast.
  • Both endpoints have known positions + known walls between them.
  • Stream alone is enough to fit calibration cascade Layers 1 + 2:
      Layer 1: n_path, wall_att, ext_att, door_att (4 global params)
      Layer 2: per-node tx_offset[N], rx_offset[N] (2N params)
      σ_pair: noise variance per (transmitter, listener) pair
  • Over-determined: ~N² pair observations vs (4 + 2N) parameters.
    For 15 nodes: 225 observations, 34 params → tight fit.
  • Converges in hours of operation. No human in the loop.

Tier 4 — Device-specific (requires user input OR confident estimates):
  • Per-device tx_offset[D] (Layer 3 of the cascade)
  • Per-(device, listener, position) spatial offset (Layer 4)
  • Initial fits from pins; ongoing fits from high-confidence
    position estimates once tracking is good enough.
```

**The killer property — autonomous bootstrap.** Tiers 1–3 produce a
fully calibrated forward model before any device or pin exists. Drop
in nodes, let them hear each other for a few hours, and the system
predicts RSSI at any (position, listener) with calibrated uncertainty.
Improves continuously as more node-to-node samples accumulate.

**Deployment story becomes:**
1. Place nodes; configure positions, rooms, walls in the YAML
2. Wait ~1 hour for node-to-node observations to accumulate
3. Tiers 1 + 2 converge → tracking already works at "default device"
   accuracy (position estimates within a room or two)
4. Pin a few devices to refine per-device calibration → tracking
   tightens into "right room, ~1m accuracy"
5. Tracking quality grows → confident positions feed back into
   per-device calibration → continuous improvement

## 3. Design principles

The redesign should be:

1. **State-based, not per-frame.** The device has a state `(position, velocity, ...)` evolving over time. Each MQTT message is an observation that updates a posterior, not a problem to re-solve from scratch.
2. **Probabilistic.** Maintain real distributions, not point estimates. Confidence is a posterior covariance, not a heuristic.
3. **Self-calibrating.** Every observation that lands at a known-confident position contributes to learning per-(device, node) calibration. The system gets better with use.
4. **Spatially-aware calibration.** Per-(device, node) calibration is a *spatial field*, not a global scalar — body shadow, multipath, etc. genuinely vary with position.
5. **Single coherent pipeline.** Replace the 10 fitters with one state-tracking system. Old locators can stay as alternatives during rollout for verification.

## 4. Target architecture (sketch)

> **TBD** — this is what we'll discuss in detail before fixing.

Working hypothesis: per-device particle filter with:

- State: `(p, v, room)` with ~200 particles
- Motion model: mixture of (stationary, walking, sudden change)
- Observation model: dB-space RSSI likelihood with per-(device, node, position) calibration
- Room constraint: particles must be in a valid room
- Calibration learning: per-pin per-node RSSI residual stats, IDW-interpolated at query time

## 5. Components — to be discussed in detail

Each of these is a section we'll fill in as we discuss.

### 5.1 Per-(device, node, position) RSSI calibration

> **Status:** prototyped (per-pin, per-node residual stats, IDW lookup).
> Reverted pending discussion — needs to be finalized before any
> consumer is built.

**Current open questions:**
- What's the scale of IDW falloff? (Current: 3 m Gaussian)
- How do we capture data outside of pinned positions? (Future: confident-position observations)
- How do we handle the "same pin, two body orientations" problem? (Same position, different signature)
- Persistence model

### 5.2 Observation model (likelihood function)

What does `P(observed_rssi | position, calibration)` look like?

- Naive: Gaussian on dB-space residual
- Better: asymmetric (under-residuals more probable than over)
- Per-(device, node) sigma from calibration
- Confidence weighting based on how much pin support exists at the candidate position

### 5.3 Motion model

How does the device evolve between observations?

- Mixture: stationary / walking / fast
- Velocity damping
- Process noise scaled by Δt

### 5.4 Room constraint / Bayesian smoothing

How does room membership integrate?

- Hard constraint (particles in invalid rooms killed)?
- Soft constraint (particles weighted by P(room | room_prev))?
- Integration with existing Bayesian tracker (replace it? extend it?)

### 5.5 Algorithm choice

Particle filter? EKF? UKF? Variational?

- PF handles multimodality (good for wall-boundary cases)
- EKF cheaper if posterior is Gaussian-enough
- Trade-offs between particle count, update rate, accuracy

### 5.6 Calibration update sources

When do we *learn* (not just consume) calibration?

- Active pin → known position (current)
- High-confidence position estimate → "known enough" position (future)
- Stable position over time (device hasn't moved → reuse same position for many samples)
- Ground-truth pin re-anchoring

### 5.7 Output API

What does this system emit?

- Position (mean of posterior)
- Position uncertainty (covariance)
- Room (argmax of room marginal)
- Velocity (mean velocity component)
- Confidence (function of posterior trace)

## 6. Data plumbing requirements

Things we need to move around the system that we don't currently:

- Raw RSSI in `NodeFix` (already done — live in dev)
- Per-pin per-node RSSI residual stats (was prototyped, reverted)
- Persistent per-pin RSSI calibration on disk
- Particle-filter state per device (per-process map, persisted optionally)

## 7. Phased rollout

### Phase 1 — Cascade calibration as diagnostic-only system

**Goal:** prove the calibration cascade (Layers 1 + 2) actually converges to sensible parameters from real node-to-node data, before any positioning logic depends on it.

**What ships:**
- Save raw RSSI on node-to-node ground-truth samples (was being discarded)
- `CascadeCalibration` module:
  - Per-(TX, RX) RSSI residual stats with recency decay
  - Layer 1 fitter: global RF parameters (`n_path`, `wall_att`, `ext_att`, `door_att`)
  - Layer 2 fitter: per-node `tx_offset`, `rx_offset` from inter-node residuals
  - Periodic refit (analogous to existing per-pair fits)
- Persistence alongside other calibration state
- Inspector API endpoint
- Calibration-page UI panel showing fitted vs configured params, per-node offsets, residual quality metrics, per-pair residual matrix

**What stays untouched:**
- Every existing locator
- Auto-apply absorption push
- Per-pin calibration (per-pin RSSI / Layer 4 deferred)
- Bayesian / Kalman / state tracking

**Success criterion before moving to Phase 2:** stand in front of the calibration panel and verify
- Layer 1 fits to plausible values (n in 2.5–4, wall_att in 2–6 dB, ext_att in 4–10 dB)
- Layer 2 per-node offsets are bounded (typically ±5 dB, fixed reference node at 0)
- Residual RMS after fit lands in 3–6 dB across most pairs
- Parameters stable across consecutive refits (no oscillation)

If these don't all hold, the model is wrong (or the inputs are wrong) and we need to fix it before building any consumer.

### Phase 1.7–1.8 — Reflections + wall-count + routing fixes (COMPLETE)

See §8.6 for detailed narrative. Summary:
- Specular reflections via mirror-image method (D8) — physically correct, not graph vertices
- Direction-symmetric wall counts (D9) — both endpoints' mount walls properly handled
- Linear Dijkstra cost (D10) — multi-hop door routes no longer penalized by Jensen's inequality
- Debug tooling: per-pair wall highlights, click-to-focus, inspection panel pairs table

**Result:** σ from 5.15 → 4.72, door-routed pairs from 14 → 138, direction asymmetry ~0.

### Phase 1.9 — Per-room clutter / obstacle modeling (NEXT)

For NEGATIVE residuals (model says signal stronger than reality) where wall counts are correct but real physical obstacles attenuate the signal. Remaining ≥9 dB negative residuals:
- `master_bedroom_3 ↔ master_bedroom`: −10 dB, 0 walls — dresser in LOS path
- `kitchen ↔ living_room`: −10 dB, 0 walls — kitchen appliances
- `hall_bathroom ↔ office`: −9 dB, 2 walls — unmodeled clutter

Options (in order of preference per D7):
- **Per-room clutter offset**: learned per-room extra loss term (~200 LOC). Rooms with metal appliances/furniture get a room-wide extra dB.
- **Explicit obstacle declarations**: `obstacles: [{polygon, attenuation_db}]` in config. More precise but requires user input.
- **Body shadow**: assume person near most-active device, add ~6 dB obstacle

### Phase 1.10 — Multi-path power summing (DEFERRED)

Single-path model is sufficient at current σ. Multi-path (K-shortest-paths, power summing in linear mW) is architecturally ready but not needed until per-room clutter is handled. Remaining positive residuals are mostly config geometry gaps (room polygons not covering indoor space), not multi-path effects.

**Per-wall attenuation remains last resort** per D7.

### Phase 1.6 — Routing graph for the cascade

After Phase 1's cascade converges, residual analysis (visible in the cascade map overlay) reveals that several long-diagonal pairs have ±10–21 dB residuals because the model assumes straight-line propagation through many walls. Real signal takes longer-but-fewer-walls routes through doorways and open-plan areas.

Phase 1.6 closes this gap by introducing a **routing graph** over the floor plan and computing per-pair `W` from the shortest-loss path instead of the direct line. See D6 for details.

**Success criterion:** large-residual pairs identified in Phase 1 (>10 dB) drop to typical noise (<6 dB) after one or two cascade refits. The routing graph is producing physically-reasonable paths (visible in the cascade map overlay).

### Phase 2 — Per-pin RSSI residual learning + Layer 4 lookup

Builds on Phase 1's confidence in Layers 1+2. Captures per-pin per-(device, node) RSSI residuals (Layer 4), with IDW-interpolated lookup for arbitrary positions. Still no consumer in the live pipeline — runs as additional diagnostic + populates the data Layer 4 needs.

### Phase 3 — `RfBayesianLocator`: per-frame locator using the cascade

The first consumer of the calibration cascade. Runs per-MQTT-message, computes a likelihood-weighted MAP estimate of position using the full cascade model. Lives as an alternative in the compare view; not yet active.

### Phase 4 — Particle filter / state tracking

Replaces per-frame fitting with proper temporal state tracking. Uses the cascade for the observation likelihood, mixture motion model, room-graph priors. Becomes the active locator once verified. Old locators retained as alternatives indefinitely.

### Phase 5 — Refinements

- Confident-position criterion → Layer 3/4 learning from non-pinned data
- Cross-device correlation
- Per-zone refinements
- Whatever else falls out of operational experience

## 8. Decisions log

### D1: Use raw RSSI server-side; ignore firmware's distance conversion entirely.

**Decided:** the server will derive all positioning state from the raw `rssi` field in MQTT messages. Firmware's `distance` field becomes diagnostic info, not consumed by any state-tracking logic.

**Rationale:**
- Firmware can only have one absorption value per node. That single value is wrong some of the time (long open paths systematically undershoot, short walled paths overshoot). We've chased this for weeks.
- Putting the entire RF model server-side means: one source of truth, no firmware coordination, easy to iterate on, raw signal preserved.
- Server already has all the context (walls, devices, history) firmware lacks.

**Implications:**
- The auto-apply absorption-push pipeline becomes *optional* (some users may still want firmware-side conversion for use without our state tracker).
- Existing per-pair `nReal` fits and per-pin distance biases become legacy — replaced by RSSI-space calibration.
- The state-tracker calibration cascade splits into 4 layers (see D2).

### D7: Physical models before fitted parameters.

**Decided:** when residuals remain after a model upgrade, prefer adding a *structural physical model* over adding a *fitted parameter*. Specifically: per-wall attenuation `δ_i` is a *last resort*, only after richer routing, multi-path summing, and physical obstacle/antenna models have been tried.

**Rationale:**
- A fitted per-wall parameter absorbs the residual but doesn't *explain* it — the value could be from a hard wall, a pipe inside, an antenna pattern, or noise we'll never know.
- Fitted parameters don't generalize: a new (TX, RX) pair that doesn't cross that wall doesn't benefit from the fit.
- Physical models (reflection, diffraction, multi-path summing, body shadow) make testable claims about the world. If the claim is right, residuals drop everywhere similar physics applies — the model generalizes.
- Residuals are the *diagnostic signal* — once you fit them away, you've lost the ability to tell where the model is still wrong. Save fitted parameters for when there's nothing physical left to model.

**Implication for rollout:** Phase 1.7+ proceeds in order (richer routing → multi-path → physical obstacles → per-wall as absolute last resort), with a residual evaluation after each step to confirm the upgrade was needed and worked.

### D6: Replace direct-line geometry with shortest-path routing through a graph of RF nodes + doors + room centroids.

**Decided:** the cascade no longer assumes signal propagates along the straight line between TX and RX. For each pair, it computes the **lowest-loss path through a routing graph** whose vertices are RF nodes, door centers, and room centroids. The path's accumulated `(length, interior, exterior, doors)` feeds the cascade fit.

**Rationale:**
- After Phase 1 cascade convergence, residuals up to ±21 dB on long-diagonal pairs (e.g., nursery↔master_bedroom) demonstrate the model is structurally wrong on those paths. The signal isn't traversing all 6+ walls in a straight line — it's leaking through doorways and the open-plan area.
- Cascade can't fix this with parameter tweaks alone; the model itself needs to capture the alternative paths.
- Routing-graph approach matches physical reality (RF takes the easiest path) without committing to expensive multi-path summing.

**Convergence loop:**
- First cascade fit uses configured params for routing → fits params from those paths.
- Subsequent refits route with the *latest fitted* params → fit params from those paths.
- Fixed-point iteration of (params, paths) converges over 2–3 refits.

**Implementation:** new module `src/lib/map/rf_routing.ts` — `RoutingGraph` build + Dijkstra. Cascade fit changes minimally — just replaces direct-line `(length, walls)` with routed-path `(length, walls)`.

### D5: Hybrid update cadence — streaming per-pair stats, periodic batch cascade fit.

**Decided:**
- Per-(TX, RX) RSSI residual stats update on every node-to-node MQTT message (cheap O(1)).
- Cascade fit (Layer 1 global params + Layer 2 per-node offsets) runs as a periodic batch — every 5 min, mirroring the existing per-pair fit refresh.

**Rationale:**
- Streaming keeps the residual stats fresh and avoids per-message linear-system inversions.
- Batch cascade fit amortizes the linear-system solve over many observations and gives stable, globally-consistent parameters.
- Same pattern the existing `refreshNodePairFits` job already uses; consistent operations story.

### D4: Per-pair state — both aggregate stats and recent-sample ring buffer.

**Decided:** keep both
- **Aggregate stats** (recency-decayed sum, sum², count) — the fit input.
- **Ring buffer of last N samples** (~50) — diagnostic UI ("last residuals on this pair") and future use for outlier rejection.

**Rationale:**
- Aggregate is what the cascade fitter consumes (cheap to maintain).
- Ring buffer is invaluable for diagnostic inspection — when a pair's residual is anomalous, "show me the last 50 samples" beats "trust the average."
- Memory cost is small: ~50 samples × ~20 bytes × N² pairs. For 15 nodes → 225 pairs × 1 KB = 225 KB. Negligible.

### D3: Phase 1 ships as parallel diagnostic only — touches no positioning logic.

**Decided:** the cascade calibration system runs entirely in parallel to existing positioning. Updates from MQTT, fits periodically, exposes via UI/API. **No locator consumes it.** Auto-apply absorption push remains untouched. Existing per-pair `nReal` fits and per-pin distance biases continue to operate as today.

**Rationale:**
- Zero risk to live system.
- Validates the cascade math against real data before any consumer is built.
- Lets data accumulate so by the time Phase 2/3 lands, calibration is already converged.
- Makes diagnostic value standalone — even without a state tracker, the residual map tells operators which paths/nodes have problems.

**Success criterion to advance to Phase 2:** see §7 — Layer 1 fits to plausible values, Layer 2 offsets bounded, residuals settle in 3–6 dB, parameters stable across refits.

### D2: Calibration as a 4-layer cascade.

**Decided:** the server-side calibration is a layered model, each layer fit from data the previous one made interpretable.

```
Layer 1: Global RF model parameters
   n_path, wall_att, ext_wall_att, door_att
   ← fit from: node-to-node residuals (at known distances, known walls)

Layer 2: Per-node TX/RX offsets
   tx_offset[N], rx_offset[N]
   ← fit from: node-to-node residuals after subtracting layer 1
   Each node-to-node observation gives one equation:
     residual = tx_offset[TX] − rx_offset[RX]
   With N nodes → N² observations → 2N − 1 parameters (one DOF fixed
   by anchoring tx_offset of a reference node to 0)

Layer 3: Per-device TX offset
   tx_offset[D]
   ← fit from: device→listener observations during high-confidence position
     (pinned position OR posterior-mean with low covariance)
   Captures the device's antenna gain relative to the reference node

Layer 4: Per-(device, listener, position) spatial residual
   spatial_offset[D, N, p], spatial_sigma[D, N, p]
   ← fit from: pin observations + confident-position observations
   Captures what the global model can't (body shadow, multipath,
   antenna directionality). Stored per-pin (per-position), IDW-
   interpolated at lookup.
```

**Observation model that consumes the cascade:**

```
predicted_rssi(p, listener N, device D) =
    ref_1m
  + tx_offset[D]                       ← layer 3
  − 10·n_path · log10(|p − N|)         ← layer 1
  − W(p, N)                            ← layer 1 + map
  + tx_offset[N] − rx_offset[N]        ← layer 2
  + spatial_offset[D, N, p]            ← layer 4

likelihood(r | p) = AsymGaussian(r − predicted, σ_combined)
```

**Rationale:**
- Each layer can be fit independently in cascade order — clean dependency chain.
- Each layer's data source is automatic (no human action required for layers 1–3; layer 4 uses pins + later confident-position observations).
- Layer separation makes failure modes diagnosable: "is the wrong room because the global model is off, or because device-specific calibration is off, or because spatial calibration is missing here?"
- Mirrors how the noise actually decomposes: global structural + per-node hardware + per-device antenna + per-position multipath/body-shadow.

## 8.5 Phase 1 ship + first observations

Phase 1 deployed to dev. First cascade fit on ~1400 weighted observations:

```
Layer 1                Configured    Fitted
─────────────────────────────────────────────
path_loss_exponent     3.00          2.41
wall_attenuation_db    4.00          2.59
exterior_wall_att_db   10.00         5.73
door_attenuation_db    0.00          0.30

R² = 0.45,  σ = 5.36 dB,  188 pairs,  1399 effective weight

Layer 2: per-node offsets (ref = garage_2)
TX offsets ∈ [−4.12, +4.45] dB
RX offsets ∈ [−3.92, +5.76] dB
```

**Reads cleanly against success criteria:**
- ✓ Wall/ext/door in plausible ranges; close to standalone rf_param_fit's earlier fit
- ✓ Per-node offsets bounded ±5 dB (matches the configured `OFFSET_BOUND_DB`)
- ✓ σ = 5.36 dB squarely in 3–6 dB target

**Slightly low `n_path = 2.41`.** Path-loss exponent below the typical 2.5–3.5 indoor range, because the per-node offsets are now absorbing hardware variation that previously inflated `n`. This is *cleaner* decomposition (variance attributed to the right parameter), but worth confirming that `n` doesn't drift further down over more samples.

**Per-node patterns are physically meaningful:** garage transmits hot but hears poorly; living_room is a weak transmitter but sensitive receiver. ESPresense hardware variation is real and the cascade is capturing it.

**Stability confirmed at second refit (6 min later, ~20× more data):**

```
                Earlier   Now      Δ
n_path          2.41   →  2.43    +0.02
wall            2.59   →  2.50    −0.09
ext             5.73   →  5.62    −0.11
door            0.30   →  0.31    +0.01
R²              0.45   →  0.467   +0.017  (slightly better)
σ               5.36   →  5.24    −0.12   (slightly better)

weight          1399   →  27354
```

Per-node offsets drifted by < 0.5 dB on average; biggest swing was garage's tx by 1.0 dB. R² and σ both improved (more data → noise averaging out). The killer property: 20× more weight, parameters barely move — that's the signature of a properly-converged fit.

**Phase 1 success criteria all met.** Proceed to discussion of Phase 2 (consumer architecture).

## 8.6 Phase 1.7–1.8 — Routing + reflection fixes

Major iteration on the cascade's routing and wall-counting after Phase 1.6, driven by visual debugging with the cascade map overlay. Each fix was motivated by specific pair residuals whose physical explanation didn't match the model's.

### Reflection evolution (Phase 1.7 → 1.8)

**Phase 1.7 (initial):** added generic reflection vertices at wall midpoints, offset ±0.05m. Dijkstra routed through them as regular graph nodes. Results: no improvement — reflection_loss sat at prior, no pairs used reflections. Diagnosed: midpoint vertices don't enforce specular geometry, and cost was too high vs door routes.

**Phase 1.7 (revised):** lowered reflection prior from `{6.0, 0.3}` to `{3.5, 0.05}`. Some reflections started appearing. But produced unphysical paths — "reflecting off the far side of a wall two walls away" because graph vertices had no line-of-sight constraint.

**Phase 1.8 (final):** removed generic reflection vertices entirely. Replaced with proper per-pair specular reflection computation via mirror-image method:
1. **Same-side-of-wall:** source and target must be on same side of reflecting wall
2. **Mirror-image geometry:** reflect source across wall line; intersection with wall segment gives the unique specular reflection point where angle-in = angle-out
3. **Segment membership:** reflection point must fall within the wall segment bounds
4. **LOS on both legs:** no walls between source→reflection or reflection→target (with proper centroid-based side testing at each endpoint)

`findBestPathForPair` evaluates direct ∪ Dijkstra-routed ∪ all valid specular reflections, picks minimum RF loss. See D8.

### Wall-count bug fixes

**At-source wall dropping (D9):** `countCrossings` was only side-testing walls touching the source endpoint. Walls touching the target were either dropped (when no centroid passed) or counted unconditionally. Extended to accept both source and target room centroids. Applied everywhere:
- `obstructionCountsForPair` (sample accumulation time)
- Routing graph edge builder
- Specular reflection LOS checks

**Result:** direction asymmetry collapsed from many pairs to ~1/102. `office↔kitchen` went from `1i/2e` vs `2i/2e` to `1i/2e` both ways. `breakfast_nook↔living_room` reflection was exposed as phantom (LOS check was passing because walls touching living_room mount point were being dropped).

### Dijkstra cost function fix (D10)

**Bug:** per-hop edge cost used `10n·log10(hop_length + 1)`. Sum of per-hop log-losses systematically overestimates total path loss due to Jensen's inequality (`Σlog(Lᵢ) > log(ΣLᵢ)`). A 4-hop door route with total length 13m appeared to cost ~47 dB inside Dijkstra, vs ~38 dB for a direct 7m path — even though the true RF cost comparison (using `log(total_length)`) would favor the door route.

**Fix:** replaced per-hop log-loss with linear distance (`edge.length × n_path`) as the distance component of Dijkstra's edge cost. Dijkstra now correctly finds minimum-wall routes with distance as tiebreaker. `findBestPathForPair` evaluates the Dijkstra winner at true RF cost (`10n·log10(total_length) + wall_loss`) when comparing against direct.

**Result:** door-routed pairs jumped from 14/200 to 138/200. Pairs like `master_bedroom_3→dining_room` now find multi-hop paths through doors instead of straight lines through exterior walls.

### Cascade overlay debug tooling

Built during this phase to diagnose the bugs above:

- **Node-selection filtering:** clicking a node shows only that node's pair lines (not all 200+)
- **Wall crossing highlights:** when a node is selected, highlights all walls its direct rays cross, color-coded (blue=interior, red=exterior, green=door)
- **Click-to-focus pairs:** click a pair line on the map → isolates just that pair's walls; dims all others. Click the row in the inspection panel → same effect. Shared state via `focusedCascadePairKey` in MapToolProvider.
- **Pair table in inspection panel:** replaces old calibration/GT sections. Shows per-pair walls, routed walls (blue when different from direct), residual (color-coded), weight. Sorted by |residual| desc.

### Current state (post Phase 1.8)

```
σ = 4.72 dB    R² = 0.60    pairs = 200
n_path = 3.14  wall = 2.53  ext = 4.83  door = 0.20

|resid| < 3 dB:   88 pairs  (44%)
|resid| < 6 dB:  161 pairs  (80%)
|resid| < 9 dB:  189 pairs  (94%)
|resid| ≥ 9 dB:   11 pairs  ( 6%)
median |resid|:   3.32 dB

Direction-asymmetric pairs: 1/102
Pairs using door routing: 138/200
Pairs using specular reflection: 0 (refl_loss at prior, unconstrained)
```

**Remaining ≥9 dB residuals fall into two categories:**

1. **Positive (model over-attenuates):** pairs crossing exterior walls where the real signal goes through an indoor path the router doesn't find. Most involve room polygon gaps where adjacent rooms don't fully share walls, creating phantom "exterior" classifications. Config geometry improvements would fix these.

2. **Negative (model under-attenuates):** pairs with correct wall counts but real physical obstacles the model doesn't know about (dressers, appliances, bed frames). These are the Phase 1.9 targets — per-room clutter offsets or explicit obstacle declarations.

### New decisions

### D8: Specular reflections via mirror-image, not graph vertices.

**Decided:** remove generic reflection vertices from the routing graph. Compute specular reflections per-pair via the mirror-image construction, enforcing same-side, segment membership, and LOS on both legs. Evaluate as candidates alongside direct and Dijkstra-routed paths.

**Rationale:**
- Generic graph vertices can't enforce specular geometry (angle-in = angle-out). Dijkstra treats them as regular waypoints, producing non-physical "bounce off the far side of a wall two rooms away" paths.
- Same-side-of-wall and LOS constraints are fundamentally per-pair properties — they depend on where source and target are relative to the reflecting wall. Can't encode that in a static graph.
- Mirror-image construction gives the exact unique reflection point per wall, with O(W) complexity per pair (W = number of wall segments, typically ~50).

### D9: Direction-symmetric wall counts via both-endpoint centroid side-testing.

**Decided:** `countCrossings` accepts both a source and target room centroid. Walls touching either endpoint are side-tested against that endpoint's room interior. Makes the count truly direction-independent: `tx→rx` and `rx→tx` produce identical `{interior, exterior, doors}` for the same physical line.

**Rationale:**
- Without target-side testing, swapping direction gave different counts (e.g., `office→kitchen: 1i/2e` vs `kitchen→office: 2i/2e`) because the formerly-target mount wall became at-source with no centroid to test against.
- Direction-dependent counts meant the cascade fit was learning from inconsistent data: the same physical line segment contributed different wall losses depending on which node happened to be transmitting.
- Also exposed a bug in specular reflection LOS checks: walls touching the target RF node were being silently dropped (no centroid → `continue`), allowing reflections that pass through real blockers.

### D10: Linear distance in Dijkstra edge cost.

**Decided:** replace `10n·log10(hop_length + 1)` with `hop_length × n_path` as the distance component of Dijkstra's edge cost. The true RF cost function (`10n·log10(total_path_length) + total_wall_loss`) is applied in `findBestPathForPair` when comparing the Dijkstra winner against the direct path.

**Rationale:**
- Per-hop log-loss sums overestimate total path loss (Jensen's inequality). This systematically rejects multi-hop door routes that are actually cheaper at true RF cost.
- Concrete example: `master_bedroom_3→dining_room` through Hallway doors costs ~34 dB at true cost but ~47 dB at Dijkstra's per-hop cost. Direct (through 2 exterior walls) costs ~33 dB at true cost and ~38 dB at Dijkstra's cost. Dijkstra picked direct (38 < 47) even though direct is actually more expensive (33 < 34 is close, but the door route has fewer walls and is often cheaper).
- Linear distance preserves the correct ordering for Dijkstra: minimize wall loss with total distance as tiebreaker. The final `findBestPathForPair` comparison uses the real log-based cost.

## 9. Open questions / parking lot

- **Persistence**: where do we store the per-pin RSSI calibration? Same file as existing pin data? New file?
- **Dynamic state**: how often does the particle filter run? Per MQTT message (~5–10 Hz) or batched?
- **Cold start**: when a device first appears, no pins exist, no calibration — what does the system do?
- **Compute budget**: current pipeline is essentially free; particle filter at 10 Hz × 200 particles × multiple devices could matter on a small VM. Budget?
- **Backwards compatibility**: do we keep room_aware as a fallback when state-tracker fails / hasn't initialized?
- **Per-device antenna model**: is there value in modeling antenna pattern (directional gain) explicitly, or does the per-pin per-node calibration absorb it implicitly?
