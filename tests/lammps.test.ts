// Roadmap milestones 0.2 and 0.3: LAMMPS dumps. The fixtures in
// tests/fixtures/lammps were written by LAMMPS (22 Jul 2025) from
// public/samples/tobermorite.xyz by tools/fixtures/make_lammps_fixtures.py,
// in four column styles, with a triclinic cell.
// Pass tests: every style reads to the same positions within 1e-4 Å, frame 0
// matches the extended-XYZ source within 1e-4 Å, and the dump's box gives the
// same cell as the XYZ Lattice within 1e-6 Å.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { minimumImage } from "../src/cell";
import { detectBondEvents } from "../src/chapterDetect";
import { MissingTypeMapError, parseLammpsDump, parseBoxBounds } from "../src/lammpsDump";
import type { Trajectory } from "../src/xyzParser";
import { eventSummary, loadXyz, ROOT } from "./helpers";

const fixture = (name: string) => new Blob([readFileSync(join(ROOT, "tests/fixtures/lammps", name))]);
const TYPES = { 1: "Ca", 2: "Si", 3: "O", 4: "H" };

/** Largest minimum-image distance between the same atom in two trajectories, frame by frame (Å). */
function maxDeviation(a: Trajectory, b: Trajectory, frames = a.numFrames): number {
  let worst = 0;
  const d = new Float64Array(3);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < a.numAtoms; i++) {
      const off = (f * a.numAtoms + i) * 3;
      for (let c = 0; c < 3; c++) d[c] = b.positions[off + c] - a.positions[off + c];
      minimumImage(a.cells![f]!, d);
      worst = Math.max(worst, Math.hypot(d[0], d[1], d[2]));
    }
  }
  return worst;
}

test("every LAMMPS column style reads to the same positions (within 1e-4 Å)", async () => {
  const unscaled = await parseLammpsDump(fixture("tobermorite-unscaled.dump"));
  const styles = {
    scaled: await parseLammpsDump(fixture("tobermorite-scaled.dump")),
    unwrapped: await parseLammpsDump(fixture("tobermorite-unwrapped.dump")),
    types: await parseLammpsDump(fixture("tobermorite-types.dump"), { typeElements: TYPES }),
  };
  assert.equal(unscaled.numFrames, 3);
  assert.equal(unscaled.numAtoms, 1408);
  for (const [name, t] of Object.entries(styles)) {
    assert.equal(t.numFrames, 3, name);
    assert.deepEqual(t.frameSymbols, unscaled.frameSymbols, `${name}: elements`);
    const dev = maxDeviation(unscaled, t);
    assert.ok(dev < 1e-4, `${name}: ${dev} Å`);
  }
});

test("frame 0 matches the extended-XYZ source (within 1e-4 Å)", async () => {
  const xyz = await loadXyz("public/samples/tobermorite.xyz");
  const dump = await parseLammpsDump(fixture("tobermorite-scaled.dump"));
  // The data file numbered atoms 1..N in XYZ order, so ID order is XYZ order.
  assert.deepEqual(dump.symbols, xyz.symbols);
  const dev = maxDeviation(xyz, dump, 1);
  assert.ok(dev < 1e-4, `${dev} Å`);
});

test("the dump's box gives the XYZ Lattice cell (within 1e-6 Å)", async () => {
  const xyz = await loadXyz("public/samples/tobermorite.xyz");
  const dump = await parseLammpsDump(fixture("tobermorite-unscaled.dump"));
  const a = xyz.cells![0]!;
  const b = dump.cells![0]!;
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(a.vectors[k] - b.vectors[k]) < 1e-6, `component ${k}: ${a.vectors[k]} vs ${b.vectors[k]}`);
  assert.deepEqual(b.pbc, [true, true, true]);
});

test("the same events from every column style", async () => {
  const base = eventSummary(detectBondEvents(await parseLammpsDump(fixture("tobermorite-unscaled.dump"))));
  for (const name of ["tobermorite-scaled.dump", "tobermorite-unwrapped.dump"]) {
    assert.deepEqual(eventSummary(detectBondEvents(await parseLammpsDump(fixture(name)))), base, name);
  }
});

test("a dump with only atom types asks for an element map", async () => {
  await assert.rejects(parseLammpsDump(fixture("tobermorite-types.dump")), (err: unknown) => {
    assert.ok(err instanceof MissingTypeMapError);
    assert.deepEqual(err.types, [1, 2, 3, 4]);
    return true;
  });
});

test("unsorted atoms, orthogonal boxes and extra ITEM sections", async () => {
  const text = [
    "ITEM: UNITS", "metal",
    "ITEM: TIMESTEP", "0",
    "ITEM: NUMBER OF ATOMS", "3",
    "ITEM: BOX BOUNDS pp pp ff", "0 10", "0 10", "0 10",
    "ITEM: ATOMS id element x y z",
    "3 H 9.6 5 5", "1 O 0.2 5 5", "2 H 0.2 5.95 5",
    "ITEM: TIMESTEP", "10",
    "ITEM: NUMBER OF ATOMS", "3",
    "ITEM: BOX BOUNDS pp pp ff", "0 10", "0 10", "0 10",
    "ITEM: ATOMS id element x y z",
    "2 H 0.25 5.95 5", "3 H 9.65 5 5", "1 O 0.25 5 5",
  ].join("\n");
  const t = await parseLammpsDump(new Blob([text]));
  assert.deepEqual(t.symbols, ["O", "H", "H"]);
  assert.deepEqual([...t.positions.slice(0, 3)], [0.2, 5, 5].map(Math.fround));
  assert.deepEqual([...t.positions.slice(9, 12)], [0.25, 5, 5].map(Math.fround));
  assert.deepEqual(t.cells![0]!.pbc, [true, true, false]);
  assert.deepEqual(t.comments, ["Timestep=0", "Timestep=10"]);
});

test("triclinic BOX BOUNDS convert to lattice vectors", () => {
  // LAMMPS docs: bounds lines hold xlo_bound xhi_bound xy, etc.
  const box = parseBoxBounds("ITEM: BOX BOUNDS xy xz yz pp pp pp", ["-2 12 -2", "0 10 1", "0 10 1"]);
  // xlo = -2 - min(0, -2, 1, -1) = 0; xhi = 12 - max(0, -2, 1, -1) = 11; ylo = 0; yhi = 10 - 1 = 9.
  assert.deepEqual(box.vectors, [11, 0, 0, -2, 9, 0, 1, 1, 10]);
  assert.deepEqual(box.origin, [0, 0, 0]);
});
