import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cell } from "../src/cell";
import type { DetectedEvent } from "../src/chapterDetect";
import { parseExtendedXYZ, type Trajectory } from "../src/xyzParser";

export const ROOT = join(import.meta.dirname, "..");

export async function loadXyz(relativePath: string): Promise<Trajectory> {
  return parseExtendedXYZ(new Blob([readFileSync(join(ROOT, relativePath))]));
}

/** First `frames` frames of a trajectory. */
export function firstFrames(t: Trajectory, frames: number): Trajectory {
  const n = Math.min(frames, t.numFrames);
  return {
    ...t,
    numFrames: n,
    positions: t.positions.slice(0, n * t.numAtoms * 3),
    frameSymbols: t.frameSymbols.slice(0, n * t.numAtoms),
    comments: t.comments.slice(0, n),
    cells: t.cells?.slice(0, n),
  };
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32), so failures reproduce. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fractional coordinates in the cell's given (not reduced) vectors: f = r · M⁻¹. */
export function toFractional(cell: Cell, x: number, y: number, z: number): [number, number, number] {
  const m = cell.vectors;
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
  ];
  return [
    x * inv[0] + y * inv[3] + z * inv[6],
    x * inv[1] + y * inv[4] + z * inv[7],
    x * inv[2] + y * inv[5] + z * inv[8],
  ];
}

/** Moves every atom of every frame by `shift` and wraps it back into its frame's cell. */
export function shiftAndWrap(t: Trajectory, shift: [number, number, number]): Trajectory {
  const positions = new Float32Array(t.positions.length);
  for (let f = 0; f < t.numFrames; f++) {
    const cell = t.cells![f]!;
    const m = cell.vectors;
    for (let i = 0; i < t.numAtoms; i++) {
      const off = (f * t.numAtoms + i) * 3;
      const frac = toFractional(cell, t.positions[off] + shift[0], t.positions[off + 1] + shift[1], t.positions[off + 2] + shift[2]);
      const w = frac.map((v) => v - Math.floor(v));
      for (let c = 0; c < 3; c++) positions[off + c] = w[0] * m[c] + w[1] * m[3 + c] + w[2] * m[6 + c];
    }
  }
  return { ...t, positions };
}

/** Events reduced to what a reviewer sees, for comparing two runs. */
export function eventSummary(events: DetectedEvent[]): string[] {
  const pairs = (list: [number, number][]) => list.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`).sort().join(",");
  return events.map(
    (e) => `${e.startFrame}-${e.endFrame} ${e.category} +[${pairs(e.formed)}] -[${pairs(e.broken)}] ${e.label}`,
  );
}
