import type { Config } from "@/lib/config";
import { computeFloorBounds, polygonCentroid } from "@/lib/map/geometry";
import {
  buildWallSegments,
  countCrossings,
  type WallSegment,
} from "@/lib/map/rf_geometry";
import { findRoom } from "@/lib/locators/room_aware";
import { getStore } from "@/lib/state/store";
import type { Locator, LocatorResult, NodeFix } from "./types";

/**
 * Cascade contour-overlap locator.
 *
 * Like room-aware's circle-overlap approach, but with wall-shaped
 * iso-RSSI contours instead of free-space circles. Where multiple
 * nodes' contours overlap = positions consistent with all those
 * observations. Cell with the most distinct-node overlaps = answer.
 *
 * Uses the cascade's fitted RF model (n_path, wall attenuation,
 * per-node rx_offset) for the contour shapes, and firmware distance
 * ratios for device TX offset calibration.
 *
 * The contours naturally account for walls: they contract through
 * walls (model says signal is weaker → device must be closer),
 * thread through doors (low loss), and fragment across rooms. This
 * makes the overlap regions MUCH tighter than circle overlaps —
 * two contours can only intersect where the wall geometry is
 * consistent with both observations simultaneously.
 */

const GRID_RES_M = 0.15;
const MIN_RSSI_FIXES = 3;
/** Contour band width. Wider = more overlap tolerance. */
const CONTOUR_TOLERANCE_DB = 2.5;
/** Max walls on a path for it to be considered. */
const MAX_WALL_COUNT = 5;

interface NodeGrid {
  nodeId: string;
  nodeX: number;
  nodeY: number;
  interior: Uint8Array;
  exterior: Uint8Array;
  doors: Uint8Array;
}

export class CascadeParticleLocator implements Locator {
  readonly name = "cascade";

  private readonly bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null;
  private readonly nx: number;
  private readonly ny: number;
  private readonly grids: Map<string, NodeGrid>;

  constructor(config: Config) {
    if (config.floors.length === 0) {
      this.bounds = null;
      this.nx = 0;
      this.ny = 0;
      this.grids = new Map();
      return;
    }
    const floor = config.floors[0];
    const b = computeFloorBounds(floor, config.nodes);
    this.bounds = b;
    this.nx = Math.max(1, Math.ceil((b.maxX - b.minX) / GRID_RES_M) + 1);
    this.ny = Math.max(1, Math.ceil((b.maxY - b.minY) / GRID_RES_M) + 1);
    const walls: readonly WallSegment[] = buildWallSegments([floor]);

    this.grids = new Map();
    for (const node of config.nodes) {
      if (!node.id || !node.point) continue;
      const centroid = nodeRoomCentroid(
        { room: node.room, point: node.point },
        floor.rooms,
      );
      const grid: NodeGrid = {
        nodeId: node.id,
        nodeX: node.point[0],
        nodeY: node.point[1],
        interior: new Uint8Array(this.nx * this.ny),
        exterior: new Uint8Array(this.nx * this.ny),
        doors: new Uint8Array(this.nx * this.ny),
      };
      for (let gy = 0; gy < this.ny; gy++) {
        const py = b.minY + gy * GRID_RES_M;
        for (let gx = 0; gx < this.nx; gx++) {
          const px = b.minX + gx * GRID_RES_M;
          const c = countCrossings(
            grid.nodeX,
            grid.nodeY,
            px,
            py,
            walls,
            centroid,
          );
          const idx = gy * this.nx + gx;
          grid.interior[idx] = Math.min(255, c.interior);
          grid.exterior[idx] = Math.min(255, c.exterior);
          grid.doors[idx] = Math.min(255, c.doors);
        }
      }
      this.grids.set(node.id, grid);
    }
  }

  solve(fixes: readonly NodeFix[]): LocatorResult | null {
    if (fixes.length < MIN_RSSI_FIXES || !this.bounds) return null;
    const fit = getStore().latestCascadeFit;
    if (!fit) return null;

    const rssiFixes = fixes.filter(
      (f): f is NodeFix & { rssi: number } =>
        f.rssi != null && f.distance > 0,
    );
    if (rssiFixes.length < MIN_RSSI_FIXES) return null;

    const { bounds, nx, ny } = this;
    const refRssi = fit.referenceRssi1m;
    const nPath = fit.pathLossExponent;
    const wallAtt = fit.wallAttenuationDb;
    const extAtt = fit.exteriorWallAttenuationDb;
    const doorAtt = fit.doorAttenuationDb;
    const cellCount = nx * ny;

    // Resolve per-fix data.
    const perFix: {
      fix: NodeFix & { rssi: number };
      grid: NodeGrid;
      rxOff: number;
    }[] = [];
    for (const f of rssiFixes) {
      const grid = this.grids.get(f.nodeId);
      if (!grid) continue;
      const rxOff = fit.nodeOffsets.get(f.nodeId)?.rxOffsetDb ?? 0;
      perFix.push({ fix: f, grid, rxOff });
    }
    if (perFix.length < MIN_RSSI_FIXES) return null;
    const N = perFix.length;

    // ── Device TX offset from firmware distance scaling ──
    // Firmware distances are calibrated for the device's TX power.
    // Cascade free-space distances assume reference TX. The median
    // ratio gives a robust per-device correction.
    const ratios: number[] = [];
    for (const d of perFix) {
      const logD = (refRssi - d.fix.rssi - d.rxOff) / (10 * nPath);
      const cascadeDist = Math.pow(10, logD);
      if (cascadeDist > 0.1 && d.fix.distance > 0.1) {
        ratios.push(d.fix.distance / cascadeDist);
      }
    }
    ratios.sort((a, b) => a - b);
    const txScale = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 1;
    const txOffDb = 10 * nPath * Math.log10(Math.max(0.01, txScale));

    // ── Predicted RSSI at each cell for each node ──
    // Uses the full cascade model: path loss + wall loss + rx_off.
    // txOff is applied when comparing to observed.
    const predGrids: Float32Array[] = [];
    for (const d of perFix) {
      const pred = new Float32Array(cellCount);
      for (let gy = 0; gy < ny; gy++) {
        const py = bounds.minY + gy * GRID_RES_M;
        for (let gx = 0; gx < nx; gx++) {
          const idx = gy * nx + gx;
          const wallCount =
            d.grid.interior[idx] + d.grid.exterior[idx] + d.grid.doors[idx];
          if (wallCount > MAX_WALL_COUNT) {
            pred[idx] = NaN;
            continue;
          }
          const dx = (bounds.minX + gx * GRID_RES_M) - d.grid.nodeX;
          const dy = py - d.grid.nodeY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 0.1) {
            pred[idx] = NaN;
            continue;
          }
          const W =
            d.grid.interior[idx] * wallAtt +
            d.grid.exterior[idx] * extAtt +
            d.grid.doors[idx] * doorAtt;
          pred[idx] =
            refRssi - 10 * nPath * Math.log10(dist) - W - d.rxOff;
        }
      }
      predGrids.push(pred);
    }

    // ── Contour overlap counting ──
    // For each cell: how many nodes' iso-RSSI contours contain it?
    // A node's contour at cell c: |predicted(c) + txOff − observed| ≤ tolerance.
    // Cell with the most distinct-node overlaps = position.
    //
    // Weight by signal strength: strong-RSSI observations (close
    // nodes) contribute more to the score, mirroring room-aware's
    // topology-based trust of same-room nodes.
    const overlapCount = new Uint8Array(cellCount);
    const overlapScore = new Float32Array(cellCount);

    for (let i = 0; i < N; i++) {
      const pred = predGrids[i];
      const observed = perFix[i].fix.rssi;
      // Signal strength weight: close nodes get more influence.
      const strength = Math.max(0, (observed + 110) / 50);
      const weight = strength * strength;

      for (let idx = 0; idx < cellCount; idx++) {
        const p = pred[idx];
        if (Number.isNaN(p)) continue;
        if (Math.abs(p + txOffDb - observed) <= CONTOUR_TOLERANCE_DB) {
          overlapCount[idx] += 1;
          overlapScore[idx] += weight;
        }
      }
    }

    // ── Find peak: cell with most overlapping contours ──
    // Tiebreak by weighted score (signal-strength-weighted overlap).
    let maxCount = 0;
    for (let i = 0; i < cellCount; i++) {
      if (overlapCount[i] > maxCount) maxCount = overlapCount[i];
    }
    if (maxCount === 0) return null;

    // Among cells matching maxCount, pick by highest score.
    // Centroid all cells at (maxCount, maxScore) for smooth output.
    let maxScore = 0;
    for (let i = 0; i < cellCount; i++) {
      if (overlapCount[i] === maxCount && overlapScore[i] > maxScore) {
        maxScore = overlapScore[i];
      }
    }
    const scoreThr = maxScore * 0.9;
    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const idx = gy * nx + gx;
        if (
          overlapCount[idx] === maxCount &&
          overlapScore[idx] >= scoreThr
        ) {
          const w = overlapScore[idx];
          sumX += w * (bounds.minX + gx * GRID_RES_M);
          sumY += w * (bounds.minY + gy * GRID_RES_M);
          sumW += w;
        }
      }
    }
    if (sumW <= 0) return null;

    const posX = sumX / sumW;
    const posY = sumY / sumW;

    // Z from distance-weighted average.
    let zw = 0;
    let zt = 0;
    for (const f of rssiFixes) {
      const w = 1 / (f.distance * f.distance + 1e-6);
      zw += w * f.point[2];
      zt += w;
    }

    const confidence = Math.max(0, Math.min(1, maxCount / N));

    return {
      x: posX,
      y: posY,
      z: zt > 0 ? zw / zt : 0,
      confidence,
      fixes: N,
      algorithm: this.name,
    };
  }
}

function nodeRoomCentroid(
  node: { room?: string; point: readonly [number, number, number] },
  rooms: ReadonlyArray<{
    id?: string;
    name?: string;
    points?: ReadonlyArray<readonly [number, number]>;
  }>,
): readonly [number, number] | undefined {
  const resolve = (
    label: string | undefined,
  ): { points?: ReadonlyArray<readonly [number, number]> } | null =>
    label
      ? rooms.find((r) => r.id === label || r.name === label) ?? null
      : null;
  let room = resolve(node.room);
  if (!room) {
    const id = findRoom(
      rooms as Parameters<typeof findRoom>[0],
      [node.point[0], node.point[1]],
    );
    if (id) room = resolve(id);
  }
  if (!room?.points || room.points.length < 3) return undefined;
  return polygonCentroid(room.points);
}
