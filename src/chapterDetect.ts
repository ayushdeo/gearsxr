// Bond-change event detection for Simulation Chapters.
//
// Bonds are recomputed per frame with the same covalent-radius rule the
// renderer uses (computeBonds), so a detected event is exactly a bond the
// viewer visibly draws or stops drawing. Raw per-frame diffs are noisy (bonds
// flicker around the cutoff), so a change only counts once the new state has
// held for `minPersistFrames` consecutive frames. Committed changes that share
// an atom and fall within `groupWindowFrames` of each other are merged into one
// event, so e.g. a proton transfer reads as one chapter, not a break + a form.
// Concerted changes on bonded neighbors (a ring opening while an adjacent H
// shifts) also merge within that window; neighbors come from the bond graph,
// so separate molecules that merely touch never merge.
// An exchange can take longer than that window (an atom sits between
// partners), so an atom's consecutive changes in opposite directions (a break
// then a formation, or a formation then a break) link within
// `transferWindowFrames`.

import { computeBonds } from "./bonds";
import { classifyChapter, localGraph, type ChapterCategory } from "./chapterChemistry";
import type { Trajectory } from "./xyzParser";

export const DETECTOR_NAME = "bond-diff";
export const DETECTOR_VERSION = 2;

export interface DetectOptions {
  /** Frames a new bond state must hold before it counts as a change. */
  minPersistFrames: number;
  /** Changes sharing an atom within this many frames merge into one event. */
  groupWindowFrames: number;
  /** An atom's break and next formation (either order) link within this many frames. */
  transferWindowFrames: number;
  /**
   * Per-frame displacement (Å) above which an atom is treated as having
   * jumped (periodic-boundary wrap or a discontinuous trajectory) rather than
   * moved; bond changes involving it on that frame are absorbed silently.
   */
  jumpThreshold: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  minPersistFrames: 3,
  groupWindowFrames: 10,
  transferWindowFrames: 30,
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
  /** Rule-based reaction category from the local bond graph (see chapterChemistry). */
  category: ChapterCategory;
}

interface BondChange {
  frame: number;
  a: number;
  b: number;
  formed: boolean;
  /** Atoms bonded to a or b when the change was committed. */
  neighbors: number[];
}

export type DetectProgress = (framesDone: number, totalFrames: number) => void;

function frameSymbols(trajectory: Trajectory, frame: number): string[] {
  const n = trajectory.numAtoms;
  const out = trajectory.frameSymbols.slice(frame * n, frame * n + n);
  return out.length === n ? out : trajectory.symbols;
}

/**
 * Atoms that moved more than the threshold since the previous frame, or whose
 * element changed (files without stable atom IDs reuse indices for different
 * atoms). Either way the index no longer tracks one continuous atom.
 */
function jumpedAtoms(trajectory: Trajectory, frame: number, threshold: number): Set<number> {
  const jumped = new Set<number>();
  if (frame === 0) return jumped;
  const { positions, numAtoms, frameSymbols: species } = trajectory;
  const cur = frame * numAtoms * 3;
  const prev = cur - numAtoms * 3;
  const limitSq = threshold * threshold;
  for (let i = 0; i < numAtoms; i++) {
    const dx = positions[cur + i * 3] - positions[prev + i * 3];
    const dy = positions[cur + i * 3 + 1] - positions[prev + i * 3 + 1];
    const dz = positions[cur + i * 3 + 2] - positions[prev + i * 3 + 2];
    if (dx * dx + dy * dy + dz * dz > limitSq) jumped.add(i);
    else if (species[frame * numAtoms + i] !== species[(frame - 1) * numAtoms + i]) jumped.add(i);
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

    // Adjacency over bonds held before or at this frame, built only when a
    // change commits here (rare compared with frames).
    let adjacency: Map<number, number[]> | null = null;
    const neighborsOf = (a: number, b: number) => {
      if (!adjacency) {
        adjacency = new Map();
        for (const key of new Set([...stable, ...current])) {
          const x = Math.floor(key / numAtoms);
          const y = key % numAtoms;
          (adjacency.get(x) ?? adjacency.set(x, []).get(x)!).push(y);
          (adjacency.get(y) ?? adjacency.set(y, []).get(y)!).push(x);
        }
      }
      return [...new Set([...(adjacency.get(a) ?? []), ...(adjacency.get(b) ?? [])])].filter((n) => n !== a && n !== b);
    };

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
        changes.push({ frame: since, a, b, formed: observed, neighbors: neighborsOf(a, b) });
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
function groupChanges(changes: BondChange[], windowFrames: number, transferWindowFrames: number): BondChange[][] {
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
  const recentByNeighbor = new Map<number, number[]>();
  const lastByAtom = new Map<number, number>();
  const inWindow = (list: number[] | undefined, frame: number) =>
    (list ?? []).filter((j) => frame - changes[j].frame <= windowFrames);
  changes.forEach((change, i) => {
    // Bonded-neighbor links: an earlier change touched one of this change's
    // neighbors, or listed one of this change's atoms as its neighbor.
    for (const atom of change.neighbors) for (const j of inWindow(recentByAtom.get(atom), change.frame)) union(i, j);
    for (const atom of [change.a, change.b]) for (const j of inWindow(recentByNeighbor.get(atom), change.frame)) union(i, j);
    for (const atom of change.neighbors) {
      const recent = inWindow(recentByNeighbor.get(atom), change.frame);
      recent.push(i);
      recentByNeighbor.set(atom, recent);
    }

    for (const atom of [change.a, change.b]) {
      // Exchange: this atom's previous change went the other way (lost a
      // partner and now binds one, or bound one and now loses another).
      const last = lastByAtom.get(atom);
      if (last !== undefined && changes[last].formed !== change.formed && change.frame - changes[last].frame <= transferWindowFrames) {
        union(i, last);
      }
      lastByAtom.set(atom, i);

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

/** Plain-language list: "A", "A and B", "A, B and C". */
function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Names an event in plain words a non-specialist can follow. The phrasing
 * stays within what chapterClaims.ts reads ("X moves from A to B",
 * "A–B bond forms", "X swaps A for B", "X and Y form H2"), so the detector's
 * own names are checkable the same way as model suggestions.
 */
function describe(group: BondChange[], symbols: string[]): { kind: ChapterKind; label: string } {
  const formed = group.filter((c) => c.formed);
  const broken = group.filter((c) => !c.formed);
  const name = (atom: number) => atomName(symbols, atom);
  const pair = (c: BondChange) => `${name(c.a)}–${name(c.b)}`;
  const key = (c: BondChange) => `${Math.min(c.a, c.b)}-${Math.max(c.a, c.b)}`;

  // One atom leaves one partner and binds another: a transfer (e.g. H+) or a swap.
  if (formed.length === 1 && broken.length === 1) {
    const f = formed[0];
    const k = broken[0];
    if (key(f) === key(k)) {
      return { kind: "rearrangement", label: `${pair(k)} bond breaks and re-forms` };
    }
    const shared = [f.a, f.b].find((atom) => atom === k.a || atom === k.b);
    if (shared !== undefined) {
      const from = k.a === shared ? k.b : k.a;
      const to = f.a === shared ? f.b : f.a;
      const label =
        symbols[shared] === "H"
          ? `${name(shared)} moves from ${name(from)} to ${name(to)}`
          : `${name(shared)} swaps ${name(from)} for ${name(to)}`;
      return { kind: "transfer", label };
    }
  }
  if (group.length === 1) {
    const c = group[0];
    return c.formed
      ? { kind: "bond-form", label: `${pair(c)} bond forms` }
      : { kind: "bond-break", label: `${pair(c)} bond breaks` };
  }

  const kind: ChapterKind = broken.length === 0 ? "bond-form" : formed.length === 0 ? "bond-break" : "rearrangement";
  // Two H atoms that each lost a partner bond to each other: H2 forms.
  const brokenAtoms = new Set(broken.flatMap((c) => [c.a, c.b]));
  const h2 = formed.find((c) => symbols[c.a] === "H" && symbols[c.b] === "H" && brokenAtoms.has(c.a) && brokenAtoms.has(c.b));
  if (h2) {
    return { kind, label: `${name(h2.a)} and ${name(h2.b)} form H2 (${broken.length} bonds break)` };
  }

  // A few bonds: list them. Many: summarize around the most involved atom.
  if (group.length <= 3) {
    const parts: string[] = [];
    if (formed.length) parts.push(`${joinList(formed.map(pair))} ${formed.length === 1 ? "forms" : "form"}`);
    if (broken.length) parts.push(`${joinList(broken.map(pair))} ${broken.length === 1 ? "breaks" : "break"}`);
    return { kind, label: parts.join(", ") };
  }
  const counts = new Map<number, number>();
  for (const c of group) for (const atom of [c.a, c.b]) counts.set(atom, (counts.get(atom) ?? 0) + 1);
  const center = [...counts].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
  const tally = [formed.length && `${formed.length} form`, broken.length && `${broken.length} break`].filter(Boolean).join(", ");
  return { kind, label: `${group.length} bonds change around ${name(center)}: ${tally}` };
}

export function detectBondEvents(
  trajectory: Trajectory,
  options: DetectOptions = DEFAULT_DETECT_OPTIONS,
  onProgress?: DetectProgress,
): DetectedEvent[] {
  if (trajectory.numFrames < 2 || trajectory.numAtoms < 2) return [];
  const changes = detectBondChanges(trajectory, options, onProgress);

  return groupChanges(changes, options.groupWindowFrames, options.transferWindowFrames)
    .map((group) => {
      // Name atoms by their element at the event, not in frame 0.
      const symbols = frameSymbols(trajectory, Math.min(...group.map((c) => c.frame)));
      const atoms = new Set<number>();
      for (const c of group) {
        atoms.add(c.a);
        atoms.add(c.b);
      }
      const geometry = {
        startFrame: Math.min(...group.map((c) => c.frame)),
        endFrame: Math.max(...group.map((c) => c.frame)),
        atoms: [...atoms].sort((x, y) => x - y),
        formed: group.filter((c) => c.formed).map((c): BondPair => [c.a, c.b]),
        broken: group.filter((c) => !c.formed).map((c): BondPair => [c.a, c.b]),
      };
      const category = classifyChapter(trajectory, geometry, localGraph(trajectory, geometry, options.minPersistFrames));
      return { ...describe(group, symbols), ...geometry, category };
    })
    .sort((x, y) => x.startFrame - y.startFrame || x.atoms[0] - y.atoms[0]);
}
