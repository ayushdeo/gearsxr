// Bond-change event detection for Simulation Chapters.
//
// Bonds are recomputed per frame with the same covalent-radius rule the
// renderer uses (computeBonds), so a detected event is exactly a bond the
// viewer visibly draws or stops drawing. Raw per-frame diffs are noisy (bonds
// flicker around the cutoff), so a change only counts once the new state has
// held for `minPersistFrames` consecutive frames. Committed changes that share
// an atom and fall within `groupWindowFrames` of each other are merged into one
// event, so e.g. a proton transfer reads as one chapter, not a break + a form.

import { computeBonds } from "./bonds";
import type { Trajectory } from "./xyzParser";

export const DETECTOR_NAME = "bond-diff";
export const DETECTOR_VERSION = 1;

export interface DetectOptions {
  /** Frames a new bond state must hold before it counts as a change. */
  minPersistFrames: number;
  /** Changes sharing an atom within this many frames merge into one event. */
  groupWindowFrames: number;
  /**
   * Per-frame displacement (Å) above which an atom is treated as having
   * jumped (periodic-boundary wrap or a discontinuous trajectory) rather than
   * moved; bond changes involving it on that frame are absorbed silently.
   */
  jumpThreshold: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  minPersistFrames: 3,
  groupWindowFrames: 5,
  jumpThreshold: 2.5,
};

export type BondPair = [number, number];

export type ChapterKind = "bond-break" | "bond-form" | "transfer" | "rearrangement";

export interface DetectedEvent {
  kind: ChapterKind;
  /** First frame the new bond state is observed. */
  startFrame: number;
  /** Last frame at which a change in this event starts. */
  endFrame: number;
  /** Sorted atom indices involved in any formed or broken bond. */
  atoms: number[];
  formed: BondPair[];
  broken: BondPair[];
  label: string;
}

interface BondChange {
  frame: number;
  a: number;
  b: number;
  formed: boolean;
}

export type DetectProgress = (framesDone: number, totalFrames: number) => void;

function frameSymbols(trajectory: Trajectory, frame: number): string[] {
  const n = trajectory.numAtoms;
  const out = trajectory.frameSymbols.slice(frame * n, frame * n + n);
  return out.length === n ? out : trajectory.symbols;
}

/** Atoms whose displacement from the previous frame exceeds the threshold. */
function jumpedAtoms(trajectory: Trajectory, frame: number, threshold: number): Set<number> {
  const jumped = new Set<number>();
  if (frame === 0) return jumped;
  const { positions, numAtoms } = trajectory;
  const cur = frame * numAtoms * 3;
  const prev = cur - numAtoms * 3;
  const limitSq = threshold * threshold;
  for (let i = 0; i < numAtoms; i++) {
    const dx = positions[cur + i * 3] - positions[prev + i * 3];
    const dy = positions[cur + i * 3 + 1] - positions[prev + i * 3 + 1];
    const dz = positions[cur + i * 3 + 2] - positions[prev + i * 3 + 2];
    if (dx * dx + dy * dy + dz * dz > limitSq) jumped.add(i);
  }
  return jumped;
}

/**
 * Walks the trajectory once and returns the debounced bond changes.
 * `stable` holds the accepted bond set; `pending` maps a bond key to the frame
 * its state first differed from `stable`.
 */
function detectBondChanges(trajectory: Trajectory, options: DetectOptions, onProgress?: DetectProgress): BondChange[] {
  const { numAtoms, numFrames } = trajectory;
  const keyOf = (a: number, b: number) => a * numAtoms + b;
  const changes: BondChange[] = [];

  const bondKeys = (frame: number) => {
    const keys = new Set<number>();
    for (const bond of computeBonds(trajectory.positions, frame, numAtoms, frameSymbols(trajectory, frame))) {
      keys.add(keyOf(bond.a, bond.b));
    }
    return keys;
  };

  const stable = bondKeys(0);
  const pending = new Map<number, number>();
  onProgress?.(1, numFrames);

  for (let frame = 1; frame < numFrames; frame++) {
    const current = bondKeys(frame);
    const jumped = jumpedAtoms(trajectory, frame, options.jumpThreshold);

    const candidates = new Set<number>(pending.keys());
    for (const key of current) if (!stable.has(key)) candidates.add(key);
    for (const key of stable) if (!current.has(key)) candidates.add(key);

    for (const key of candidates) {
      const a = Math.floor(key / numAtoms);
      const b = key % numAtoms;
      const observed = current.has(key);
      const accepted = stable.has(key);

      if (observed === accepted) {
        pending.delete(key);
        continue;
      }
      if (jumped.has(a) || jumped.has(b)) {
        // A wrapped/jumping atom: adopt the new state without an event.
        if (observed) stable.add(key);
        else stable.delete(key);
        pending.delete(key);
        continue;
      }

      let since = pending.get(key);
      if (since === undefined) {
        since = frame;
        pending.set(key, since);
      }
      if (frame - since + 1 >= options.minPersistFrames) {
        changes.push({ frame: since, a, b, formed: observed });
        if (observed) stable.add(key);
        else stable.delete(key);
        pending.delete(key);
      }
    }

    if (frame % 16 === 0 || frame === numFrames - 1) onProgress?.(frame + 1, numFrames);
  }

  return changes;
}

/** Union-find grouping: changes sharing an atom within the window form one event. */
function groupChanges(changes: BondChange[], windowFrames: number): BondChange[][] {
  const parent = changes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  // Changes are produced in frame order; per atom, link to recent changes.
  const recentByAtom = new Map<number, number[]>();
  changes.forEach((change, i) => {
    for (const atom of [change.a, change.b]) {
      const recent = (recentByAtom.get(atom) ?? []).filter((j) => change.frame - changes[j].frame <= windowFrames);
      for (const j of recent) union(i, j);
      recent.push(i);
      recentByAtom.set(atom, recent);
    }
  });

  const groups = new Map<number, BondChange[]>();
  changes.forEach((change, i) => {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(change);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function atomName(symbols: string[], atom: number) {
  return `${symbols[atom] ?? "X"}${atom}`;
}

function describe(group: BondChange[], symbols: string[]): { kind: ChapterKind; label: string } {
  const formed = group.filter((c) => c.formed);
  const broken = group.filter((c) => !c.formed);
  const pair = (c: BondChange) => `${atomName(symbols, c.a)}–${atomName(symbols, c.b)}`;

  // One atom leaves one partner and binds another: a transfer (e.g. H+).
  if (formed.length === 1 && broken.length === 1) {
    const f = formed[0];
    const k = broken[0];
    const shared = [f.a, f.b].find((atom) => atom === k.a || atom === k.b);
    if (shared !== undefined) {
      const from = k.a === shared ? k.b : k.a;
      const to = f.a === shared ? f.b : f.a;
      return {
        kind: "transfer",
        label: `${atomName(symbols, shared)} transfer ${atomName(symbols, from)} → ${atomName(symbols, to)}`,
      };
    }
  }
  if (group.length === 1) {
    const c = group[0];
    return c.formed
      ? { kind: "bond-form", label: `Bond formed ${pair(c)}` }
      : { kind: "bond-break", label: `Bond broken ${pair(c)}` };
  }
  if (broken.length === 0) return { kind: "bond-form", label: `${formed.length} bonds formed` };
  if (formed.length === 0) return { kind: "bond-break", label: `${broken.length} bonds broken` };
  return { kind: "rearrangement", label: `Rearrangement: ${formed.length} formed, ${broken.length} broken` };
}

export function detectBondEvents(
  trajectory: Trajectory,
  options: DetectOptions = DEFAULT_DETECT_OPTIONS,
  onProgress?: DetectProgress,
): DetectedEvent[] {
  if (trajectory.numFrames < 2 || trajectory.numAtoms < 2) return [];
  const changes = detectBondChanges(trajectory, options, onProgress);
  const symbols = trajectory.symbols;

  return groupChanges(changes, options.groupWindowFrames)
    .map((group) => {
      const atoms = new Set<number>();
      for (const c of group) {
        atoms.add(c.a);
        atoms.add(c.b);
      }
      return {
        ...describe(group, symbols),
        startFrame: Math.min(...group.map((c) => c.frame)),
        endFrame: Math.max(...group.map((c) => c.frame)),
        atoms: [...atoms].sort((x, y) => x - y),
        formed: group.filter((c) => c.formed).map((c): BondPair => [c.a, c.b]),
        broken: group.filter((c) => !c.formed).map((c): BondPair => [c.a, c.b]),
      };
    })
    .sort((x, y) => x.startFrame - y.startFrame || x.atoms[0] - y.atoms[0]);
}
