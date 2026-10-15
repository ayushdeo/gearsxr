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
 */
export function computeBonds(
  positions: Float32Array,
  frameIndex: number,
  numAtoms: number,
  symbols: string[],
): Bond[] {
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
