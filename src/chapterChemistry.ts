// Structural facts about a chapter, computed from geometry rather than asked
// of a language model: the bond graph around the event before and after it,
// and a reaction category from fixed rules. Small local models scored 5-33%
// on categories when asked to infer them from raw bond lists, while the rules
// below are the same ones the Transition1x answer key uses
// (tools/benchmark/t1x_to_benchmark.py), so the model is left to name and
// explain events, which is where it adds value.

import { computeBonds } from "./bonds";
import type { BondPair } from "./chapterDetect";
import type { Trajectory } from "./xyzParser";

export const CHAPTER_CATEGORIES = [
  "proton-transfer",
  "ring-change",
  "bond-formation",
  "bond-cleavage",
  "ligand-exchange",
  "other",
] as const;

export type ChapterCategory = (typeof CHAPTER_CATEGORIES)[number];

/** Radius (Å) around event atoms used for local graphs; covers rings up to ~8 atoms. */
const LOCAL_RADIUS = 6;

export interface LocalGraph {
  /** Global atom indices in the neighborhood (fixed from the "before" frame). */
  atoms: number[];
  before: BondPair[];
  after: BondPair[];
}

export interface ChapterGeometry {
  startFrame: number;
  endFrame: number;
  atoms: number[];
  formed: BondPair[];
  broken: BondPair[];
}

function symbolAt(trajectory: Trajectory, frame: number, atom: number) {
  return trajectory.frameSymbols[frame * trajectory.numAtoms + atom] ?? trajectory.symbols[atom] ?? "X";
}

/** Frames bracketing the event: the last frame before it and one where it has settled. */
export function bracketFrames(trajectory: Trajectory, event: ChapterGeometry, settleFrames: number) {
  return {
    before: Math.max(event.startFrame - 1, 0),
    after: Math.min(event.endFrame + Math.max(settleFrames - 1, 0), trajectory.numFrames - 1),
  };
}

function bondsAmong(trajectory: Trajectory, frame: number, atoms: number[]): BondPair[] {
  const base = frame * trajectory.numAtoms * 3;
  const sub = new Float32Array(atoms.length * 3);
  atoms.forEach((atom, i) => {
    sub[i * 3] = trajectory.positions[base + atom * 3];
    sub[i * 3 + 1] = trajectory.positions[base + atom * 3 + 1];
    sub[i * 3 + 2] = trajectory.positions[base + atom * 3 + 2];
  });
  const symbols = atoms.map((atom) => symbolAt(trajectory, frame, atom));
  return computeBonds(sub, 0, atoms.length, symbols).map(({ a, b }): BondPair => [atoms[a], atoms[b]]);
}

export function localGraph(trajectory: Trajectory, event: ChapterGeometry, settleFrames: number): LocalGraph {
  const { before, after } = bracketFrames(trajectory, event, settleFrames);
  const p = trajectory.positions;
  const base = before * trajectory.numAtoms * 3;
  const limitSq = LOCAL_RADIUS * LOCAL_RADIUS;
  const atoms: number[] = [];
  for (let i = 0; i < trajectory.numAtoms; i++) {
    const near = event.atoms.some((c) => {
      const dx = p[base + i * 3] - p[base + c * 3];
      const dy = p[base + i * 3 + 1] - p[base + c * 3 + 1];
      const dz = p[base + i * 3 + 2] - p[base + c * 3 + 2];
      return dx * dx + dy * dy + dz * dz <= limitSq;
    });
    if (near) atoms.push(i);
  }
  return { atoms, before: bondsAmong(trajectory, before, atoms), after: bondsAmong(trajectory, after, atoms) };
}

/** Independent ring count of a graph: edges - vertices + connected components. */
function cyclomatic(atoms: number[], bonds: BondPair[]): number {
  const parent = new Map(atoms.map((a) => [a, a]));
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const [a, b] of bonds) parent.set(find(a), find(b));
  const components = new Set(atoms.map(find)).size;
  return bonds.length - atoms.length + components;
}

/** Category rules, in priority order; mirrors categorize() in t1x_to_benchmark.py. */
export function classifyChapter(
  trajectory: Trajectory,
  event: ChapterGeometry,
  graph: LocalGraph,
): ChapterCategory {
  const { formed, broken } = event;
  const symbol = (atom: number) => symbolAt(trajectory, event.startFrame, atom);

  for (const [a, b] of broken) {
    for (const h of [a, b]) {
      if (symbol(h) !== "H") continue;
      const donor = h === a ? b : a;
      if (formed.some(([c, d]) => (c === h || d === h) && (c === h ? d : c) !== donor)) return "proton-transfer";
    }
  }
  if (cyclomatic(graph.atoms, graph.before) !== cyclomatic(graph.atoms, graph.after)) return "ring-change";
  if (formed.length && !broken.length) return "bond-formation";
  if (broken.length && !formed.length) return "bond-cleavage";
  const brokenAtoms = new Set(broken.flat());
  if (formed.some(([a, b]) => brokenAtoms.has(a) || brokenAtoms.has(b))) return "ligand-exchange";
  return "other";
}

/** Bonded neighbors of each event atom before and after, as names like "C3". */
export function neighborContext(trajectory: Trajectory, event: ChapterGeometry, graph: LocalGraph) {
  const name = (atom: number) => `${symbolAt(trajectory, event.startFrame, atom)}${atom}`;
  const neighbors = (bonds: BondPair[], atom: number) =>
    bonds.filter(([a, b]) => a === atom || b === atom).map(([a, b]) => name(a === atom ? b : a)).sort();
  return event.atoms.map((atom) => ({
    atom: name(atom),
    bonded_before: neighbors(graph.before, atom),
    bonded_after: neighbors(graph.after, atom),
  }));
}
