// Runs the Chapters detector on a trajectory and writes what it finds in the
// shared baseline format (see run_baselines.py): each event with its bond
// changes, a species-level equation and the same reaction split into
// ReacNetGenerator's species-to-species form, and molecule counts per frame.
//
//   npx tsx tools/baselines/chapters_events.ts <trajectory.dump|.xyz> <out.json> [C H O]
//
// Molecules are connected components of the bond graph, named by Hill
// formula, so they can be compared with fix reaxff/species and with
// ReacNetGenerator's species.

import { readFileSync, writeFileSync } from "node:fs";
import { computeBonds } from "../../src/bonds";
import { frameCell } from "../../src/cell";
import { bracketFrames } from "../../src/chapterChemistry";
import { DEFAULT_DETECT_OPTIONS, detectBondEvents } from "../../src/chapterDetect";
import { parseLammpsDump } from "../../src/lammpsDump";
import { parseExtendedXYZ, type Trajectory } from "../../src/xyzParser";

/** Hill formula: C, then H, then the rest alphabetically; counts of 1 omitted. */
export function hillFormula(symbols: string[]): string {
  const counts = new Map<string, number>();
  for (const s of symbols) counts.set(s, (counts.get(s) ?? 0) + 1);
  const order = [...counts.keys()].sort((a, b) => {
    const rank = (e: string) => (counts.has("C") ? (e === "C" ? 0 : e === "H" ? 1 : 2) : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return order.map((e) => `${e}${counts.get(e)! > 1 ? counts.get(e) : ""}`).join("");
}

/** Molecule (component) index of every atom in a frame. */
function molecules(t: Trajectory, frame: number): Int32Array {
  const symbols = t.frameSymbols.slice(frame * t.numAtoms, (frame + 1) * t.numAtoms);
  const parent = Int32Array.from({ length: t.numAtoms }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const { a, b } of computeBonds(t.positions, frame, t.numAtoms, symbols, frameCell(t, frame))) parent[find(a)] = find(b);
  return parent.map((_, i) => find(i));
}

function speciesCounts(t: Trajectory, frame: number): Record<string, number> {
  const comp = molecules(t, frame);
  const members = new Map<number, string[]>();
  comp.forEach((root, i) => (members.get(root) ?? members.set(root, []).get(root)!).push(t.frameSymbols[frame * t.numAtoms + i]));
  const counts: Record<string, number> = {};
  for (const atoms of members.values()) {
    const f = hillFormula(atoms);
    counts[f] = (counts[f] ?? 0) + 1;
  }
  return counts;
}

/** Atoms of each molecule that holds one of `atoms`, in a frame. */
function moleculesOf(t: Trajectory, frame: number, atoms: number[]): number[][] {
  const comp = molecules(t, frame);
  const roots = [...new Set(atoms.map((a) => comp[a]))];
  return roots.map((root) => [...comp.keys()].filter((i) => comp[i] === root));
}

const formulaOf = (t: Trajectory, frame: number, members: number[]) =>
  hillFormula(members.map((i) => t.frameSymbols[frame * t.numAtoms + i]));

/** "A + B -> C + D" from the molecules holding the event's atoms before and after it. */
function equation(t: Trajectory, atoms: number[], before: number, after: number): string {
  const side = (frame: number) => moleculesOf(t, frame, atoms).map((m) => formulaOf(t, frame, m)).sort().join(" + ");
  return `${side(before)} -> ${side(after)}`;
}

/**
 * The event as ReacNetGenerator counts reactions: one "A -> B" per molecule
 * before and molecule after that share atoms, skipping a molecule that comes
 * out with exactly its atoms (unchanged). CH4 + O2 -> CH3 + HO2 is
 * CH4 -> CH3, CH4 -> HO2 and O2 -> HO2.
 */
function flows(t: Trajectory, atoms: number[], before: number, after: number): string[] {
  const reactants = moleculesOf(t, before, atoms);
  const products = moleculesOf(t, after, atoms);
  const out: string[] = [];
  for (const r of reactants) {
    for (const p of products) {
      const shared = r.some((i) => p.includes(i));
      const same = r.length === p.length && r.every((i) => p.includes(i));
      if (shared && !same) out.push(`${formulaOf(t, before, r)} -> ${formulaOf(t, after, p)}`);
    }
  }
  return out.sort();
}

async function main() {
  const [input, output, ...elements] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Usage: tsx tools/baselines/chapters_events.ts <trajectory.dump|.xyz> <out.json> [C H O]");
    process.exit(1);
  }
  const blob = new Blob([readFileSync(input)]);
  const typeElements = elements.length ? Object.fromEntries(elements.map((e, i) => [i + 1, e])) : undefined;
  const t = /\.xyz$/i.test(input) ? await parseExtendedXYZ(blob) : await parseLammpsDump(blob, { typeElements });
  const started = performance.now();
  const events = detectBondEvents(t);
  const seconds = (performance.now() - started) / 1000;
  const steps = t.comments.map((c) => Number(c.match(/Timestep=(\d+)/)?.[1] ?? NaN));
  writeFileSync(
    output,
    JSON.stringify(
      {
        tool: "chapters",
        options: DEFAULT_DETECT_OPTIONS,
        numAtoms: t.numAtoms,
        numFrames: t.numFrames,
        seconds,
        steps,
        events: events.map((e) => {
          const { before, after } = bracketFrames(t, e, DEFAULT_DETECT_OPTIONS.minPersistFrames);
          return {
            startFrame: e.startFrame,
            endFrame: e.endFrame,
            step: steps[e.startFrame],
            atoms: e.atoms,
            formed: e.formed,
            broken: e.broken,
            category: e.category,
            label: e.label,
            equation: equation(t, e.atoms, before, after),
            flows: flows(t, e.atoms, before, after),
          };
        }),
        species: t.comments.map((_, frame) => speciesCounts(t, frame)),
      },
      null,
      1,
    ),
  );
  console.error(`chapters: ${events.length} events in ${t.numFrames} frames (${seconds.toFixed(2)} s)`);
}

void main();
