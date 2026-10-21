import { minimumImage, type Cell } from "./cell";
import { getElementInfo } from "./elements";

export interface Bond {
  a: number;
  b: number;
}

// Bonded if distance <= sum of covalent radii * tolerance.
export const BOND_TOLERANCE = 1.2;
// H2's bond (0.74 Å) sits right at 1.2 x the H radius sum (0.744 Å), so the
// generic rule drew H2 only intermittently. Non-bonded H...H contacts are
// well above 1.5 Å, so a fixed H-H cutoff is safe.
export const HH_BOND_CUTOFF = 0.85;

/** Distance (Å) below which two atoms count as bonded. */
export function bondCutoff(symbolA: string, symbolB: string): number {
  if (symbolA === "H" && symbolB === "H") return HH_BOND_CUTOFF;
  return (getElementInfo(symbolA).radius + getElementInfo(symbolB).radius) * BOND_TOLERANCE;
}

/**
 * Computes bonds for a single frame using a uniform spatial hash grid so
 * cost stays near O(n) instead of O(n^2) for the thousands-of-atoms case.
 * With a periodic cell, distances use the minimum image, so bonds across a
 * cell wall are found and atoms wrapping through a wall keep their bonds.
 */
export function computeBonds(
  positions: Float32Array,
  frameIndex: number,
  numAtoms: number,
  symbols: string[],
  cell: Cell | null = null,
): Bond[] {
  if (cell) return computePeriodicBonds(positions, frameIndex, numAtoms, symbols, cell);
  const base = frameIndex * numAtoms * 3;
  const radii = new Float32Array(numAtoms);
  let maxRadius = 0;
  for (let i = 0; i < numAtoms; i++) {
    const r = getElementInfo(symbols[i]).radius;
    radii[i] = r;
    if (r > maxRadius) maxRadius = r;
  }
  const cellSize = Math.max(maxRadius * 2 * BOND_TOLERANCE, HH_BOND_CUTOFF);

  const cellOf = (x: number, y: number, z: number) =>
    `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;

  const grid = new Map<string, number[]>();
  for (let i = 0; i < numAtoms; i++) {
    const off = base + i * 3;
    const key = cellOf(positions[off], positions[off + 1], positions[off + 2]);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  const bonds: Bond[] = [];

  for (let i = 0; i < numAtoms; i++) {
    const off = base + i * 3;
    const xi = positions[off], yi = positions[off + 1], zi = positions[off + 2];
    const cx = Math.floor(xi / cellSize);
    const cy = Math.floor(yi / cellSize);
    const cz = Math.floor(zi / cellSize);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;

            const offj = base + j * 3;
            const ddx = xi - positions[offj];
            const ddy = yi - positions[offj + 1];
            const ddz = zi - positions[offj + 2];
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            const cutoff =
              symbols[i] === "H" && symbols[j] === "H" ? HH_BOND_CUTOFF : (radii[i] + radii[j]) * BOND_TOLERANCE;
            if (distSq <= cutoff * cutoff) {
              bonds.push({ a: i, b: j });
            }
          }
        }
      }
    }
  }

  return bonds;
}

/**
 * computeBonds for a periodic cell. Atoms are binned in fractional
 * coordinates of the reduced cell, with at least one bond cutoff of width per
 * bin, so every bonded pair sits in the same or an adjacent bin; bin indices
 * wrap along periodic directions. Each pair is measured once, at its minimum
 * image, which is exact while the cutoff is under half the cell's narrowest
 * width (always true for bonds in simulation cells).
 */
function computePeriodicBonds(
  positions: Float32Array,
  frameIndex: number,
  numAtoms: number,
  symbols: string[],
  cell: Cell,
): Bond[] {
  const base = frameIndex * numAtoms * 3;
  const radii = new Float32Array(numAtoms);
  let maxRadius = 0;
  for (let i = 0; i < numAtoms; i++) {
    const r = getElementInfo(symbols[i]).radius;
    radii[i] = r;
    if (r > maxRadius) maxRadius = r;
  }
  const maxCutoff = Math.max(maxRadius * 2 * BOND_TOLERANCE, HH_BOND_CUTOFF);
  const bins = cell.widths.map((w) => Math.max(1, Math.floor(w / maxCutoff))) as [number, number, number];
  const inv = cell.inverse;

  // Bin indices along non-periodic axes are unbounded, so keys offset them.
  // Two bins sharing a key (only possible beyond KEY_SPAN / 2 bins from the
  // origin) would just put extra atoms in a bucket; distances are still checked.
  const KEY_SPAN = 4096;
  const keyOf = (x: number, y: number, z: number) =>
    ((x + KEY_SPAN / 2) * KEY_SPAN + (y + KEY_SPAN / 2)) * KEY_SPAN + (z + KEY_SPAN / 2);
  const binX = new Int32Array(numAtoms);
  const binY = new Int32Array(numAtoms);
  const binZ = new Int32Array(numAtoms);
  const binOf = (f: number, axis: 0 | 1 | 2) => {
    const n = bins[axis];
    const b = Math.floor(f * n);
    return cell.pbc[axis] ? ((b % n) + n) % n : b;
  };
  const grid = new Map<number, number[]>();
  for (let i = 0; i < numAtoms; i++) {
    const off = base + i * 3;
    const x = positions[off], y = positions[off + 1], z = positions[off + 2];
    binX[i] = binOf(x * inv[0] + y * inv[3] + z * inv[6], 0);
    binY[i] = binOf(x * inv[1] + y * inv[4] + z * inv[7], 1);
    binZ[i] = binOf(x * inv[2] + y * inv[5] + z * inv[8], 2);
    const key = keyOf(binX[i], binY[i], binZ[i]);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  // Neighbor bins along one axis; fewer than 3 bins on a periodic axis would
  // list the same bin twice, so duplicates are dropped. Periodic axes have a
  // fixed set of bins, so their lists are built once.
  const aroundUncached = (b: number, axis: 0 | 1 | 2) => {
    const n = bins[axis];
    const out = [b - 1, b, b + 1].map((v) => (cell.pbc[axis] ? ((v % n) + n) % n : v));
    return [...new Set(out)];
  };
  const cached = ([0, 1, 2] as const).map((axis) =>
    cell.pbc[axis] ? Array.from({ length: bins[axis] }, (_, b) => aroundUncached(b, axis)) : null,
  );
  const around = (b: number, axis: 0 | 1 | 2) => cached[axis]?.[b] ?? aroundUncached(b, axis);

  const bonds: Bond[] = [];
  const d = new Float64Array(3);
  for (let i = 0; i < numAtoms; i++) {
    const off = base + i * 3;
    const xi = positions[off], yi = positions[off + 1], zi = positions[off + 2];
    for (const bx of around(binX[i], 0)) {
      for (const by of around(binY[i], 1)) {
        for (const bz of around(binZ[i], 2)) {
          const bucket = grid.get(keyOf(bx, by, bz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const offj = base + j * 3;
            d[0] = positions[offj] - xi;
            d[1] = positions[offj + 1] - yi;
            d[2] = positions[offj + 2] - zi;
            minimumImage(cell, d);
            const distSq = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            const cutoff =
              symbols[i] === "H" && symbols[j] === "H" ? HH_BOND_CUTOFF : (radii[i] + radii[j]) * BOND_TOLERANCE;
            if (distSq <= cutoff * cutoff) bonds.push({ a: i, b: j });
          }
        }
      }
    }
  }
  return bonds;
}
