// Periodic simulation cells: parsing the extended-XYZ Lattice, and
// minimum-image vectors between atoms.
//
// Fractional coordinates use row vectors: r = f · M, where the rows of M are
// the lattice vectors a, b, c. A minimum image is found by rounding the
// fractional components of a separation along periodic directions. Rounding
// is only reliable for a near-orthogonal basis, so the periodic vectors are
// first reduced (Lagrange-Gauss: subtract integer multiples of one vector
// from another until no pair can be shortened). The reduced basis spans the
// same lattice, so it describes exactly the same periodic images; a skewed
// cell such as tobermorite's (b has a -16.5 Å x component against a 28 Å a)
// becomes nearly orthogonal and rounding then picks the nearest image for any
// separation shorter than half the cell's narrowest width.

import type { Trajectory } from "./xyzParser";

export interface Cell {
  /** Lattice vectors a, b, c as given in the file, row-major (Å). */
  vectors: number[];
  /** Reduced basis of the same lattice, row-major (Å); used for minimum images. */
  reduced: number[];
  /** Inverse of `reduced`: fractional = cartesian · inverse. */
  inverse: number[];
  pbc: [boolean, boolean, boolean];
  /** Distance between opposite faces of the reduced cell, per direction (Å). */
  widths: [number, number, number];
}

const dot = (m: number[], i: number, n: number[], j: number) =>
  m[i * 3] * n[j * 3] + m[i * 3 + 1] * n[j * 3 + 1] + m[i * 3 + 2] * n[j * 3 + 2];

function cross(m: number[], i: number, j: number): [number, number, number] {
  const [ax, ay, az] = [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
  const [bx, by, bz] = [m[j * 3], m[j * 3 + 1], m[j * 3 + 2]];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function determinant(m: number[]): number {
  const [cx, cy, cz] = cross(m, 1, 2);
  return m[0] * cx + m[1] * cy + m[2] * cz;
}

function invert(m: number[]): number[] | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  // Columns of the inverse are (b×c, c×a, a×b) / det.
  const bc = cross(m, 1, 2);
  const ca = cross(m, 2, 0);
  const ab = cross(m, 0, 1);
  return [
    bc[0] / det, ca[0] / det, ab[0] / det,
    bc[1] / det, ca[1] / det, ab[1] / det,
    bc[2] / det, ca[2] / det, ab[2] / det,
  ];
}

/** Lagrange-Gauss reduction among the periodic vectors; non-periodic ones are left as they are. */
function reduce(vectors: number[], pbc: [boolean, boolean, boolean]): number[] {
  const m = vectors.slice();
  const periodic = [0, 1, 2].filter((i) => pbc[i]);
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    for (const i of periodic) {
      for (const j of periodic) {
        if (i === j) continue;
        const k = Math.round(dot(m, i, m, j) / dot(m, j, m, j));
        if (k === 0) continue;
        for (let c = 0; c < 3; c++) m[i * 3 + c] -= k * m[j * 3 + c];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return m;
}

/** Builds a cell from row-major lattice vectors; null if the cell is degenerate or not periodic at all. */
export function makeCell(vectors: ArrayLike<number>, pbc: [boolean, boolean, boolean] = [true, true, true]): Cell | null {
  const v = Array.from(vectors);
  if (v.length !== 9 || !v.every(Number.isFinite) || !pbc.some(Boolean)) return null;
  const reduced = reduce(v, pbc);
  const inverse = invert(reduced);
  if (!inverse) return null;
  const volume = Math.abs(determinant(reduced));
  const widths = [0, 1, 2].map((i) => {
    const [x, y, z] = cross(reduced, (i + 1) % 3, (i + 2) % 3);
    return volume / Math.hypot(x, y, z);
  }) as [number, number, number];
  return { vectors: v, reduced, inverse, pbc, widths };
}

function parsePbc(value: string): [boolean, boolean, boolean] | null {
  const flags = value.trim().split(/[\s,]+/).map((t) => /^(t|true|1)$/i.test(t));
  if (flags.length === 1) return [flags[0], flags[0], flags[0]];
  return flags.length === 3 ? (flags as [boolean, boolean, boolean]) : null;
}

function quoted(comment: string, key: string): string | null {
  const match = comment.match(new RegExp(`\\b${key}=(?:"([^"]*)"|'([^']*)'|(\\S+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

/**
 * Reads `Lattice="ax ay az bx by bz cx cy cz"` and `pbc="T T T"` from an
 * extended-XYZ comment line. A Lattice without pbc counts as periodic in all
 * three directions, as in ASE.
 */
export function parseCell(comment: string): Cell | null {
  const lattice = quoted(comment, "Lattice");
  if (!lattice) return null;
  const vectors = lattice.trim().split(/\s+/).map(Number);
  const pbcText = quoted(comment, "pbc");
  const pbc = pbcText === null ? ([true, true, true] as [boolean, boolean, boolean]) : parsePbc(pbcText);
  return pbc ? makeCell(vectors, pbc) : null;
}

/** Replaces d (a separation, Å) with its shortest periodic image, in place. */
export function minimumImage(cell: Cell, d: { [index: number]: number }): void {
  const inv = cell.inverse;
  const m = cell.reduced;
  let f0 = d[0] * inv[0] + d[1] * inv[3] + d[2] * inv[6];
  let f1 = d[0] * inv[1] + d[1] * inv[4] + d[2] * inv[7];
  let f2 = d[0] * inv[2] + d[1] * inv[5] + d[2] * inv[8];
  if (cell.pbc[0]) f0 -= Math.round(f0);
  if (cell.pbc[1]) f1 -= Math.round(f1);
  if (cell.pbc[2]) f2 -= Math.round(f2);
  d[0] = f0 * m[0] + f1 * m[3] + f2 * m[6];
  d[1] = f0 * m[1] + f1 * m[4] + f2 * m[7];
  d[2] = f0 * m[2] + f1 * m[5] + f2 * m[8];
}

/** The cell of a frame, or null for a non-periodic trajectory. */
export function frameCell(trajectory: Trajectory, frame: number): Cell | null {
  return trajectory.cells?.[frame] ?? null;
}

/** Shortest separation from atom a to atom b in a frame (Å). */
export function separation(trajectory: Trajectory, frame: number, a: number, b: number): [number, number, number] {
  const p = trajectory.positions;
  const base = frame * trajectory.numAtoms * 3;
  const d: [number, number, number] = [
    p[base + b * 3] - p[base + a * 3],
    p[base + b * 3 + 1] - p[base + a * 3 + 1],
    p[base + b * 3 + 2] - p[base + a * 3 + 2],
  ];
  const cell = frameCell(trajectory, frame);
  if (cell) minimumImage(cell, d);
  return d;
}

export function pairDistance(trajectory: Trajectory, frame: number, a: number, b: number): number {
  const [x, y, z] = separation(trajectory, frame, a, b);
  return Math.hypot(x, y, z);
}
