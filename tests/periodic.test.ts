// Roadmap milestone 1.1: periodic-boundary distances in orthogonal and
// triclinic cells. Pass tests: a bond across a cell wall is found; moving
// every atom by a random vector and re-wrapping gives identical events in
// 100 of 100 trials; atoms wrapping through a wall produce no events.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { computeBonds } from "../src/bonds";
import { makeCell, minimumImage, parseCell, type Cell } from "../src/cell";
import { detectBondEvents } from "../src/chapterDetect";
import type { Trajectory } from "../src/xyzParser";
import { eventSummary, firstFrames, loadXyz, random, shiftAndWrap } from "./helpers";

const TOBERMORITE: number[] = [28.01, 0, 0, -16.54, 25.8, 0, 0, 0, 23.42];

test("parseCell reads Lattice and pbc", () => {
  const cell = parseCell('Lattice="28.01 0 0 -16.54 25.80 0 0 0 23.42" pbc="T T F" Properties=species:S:1:pos:R:3')!;
  assert.deepEqual(cell.vectors, TOBERMORITE);
  assert.deepEqual(cell.pbc, [true, true, false]);
  assert.deepEqual(parseCell('Lattice="10 0 0 0 10 0 0 0 10"')!.pbc, [true, true, true], "Lattice alone means periodic");
  assert.equal(parseCell("Properties=species:S:1:pos:R:3"), null);
  assert.equal(parseCell('Lattice="10 0 0 0 10 0 0 0 10" pbc="F F F"'), null);
});

test("minimum image matches a brute-force search over images (triclinic)", () => {
  // A known short separation plus a random lattice translation must come back
  // as the short separation. Checked for tobermorite's skewed cell and for a
  // strongly sheared one.
  for (const vectors of [TOBERMORITE, [10, 0, 0, 9, 10, 0, -7, 4, 10]]) {
    const cell = makeCell(vectors)!;
    const half = Math.min(...cell.widths) / 2;
    const rand = random(7);
    for (let trial = 0; trial < 20000; trial++) {
      const len = rand() * Math.min(half * 0.99, 4);
      const theta = Math.acos(2 * rand() - 1);
      const phi = 2 * Math.PI * rand();
      const short = [len * Math.sin(theta) * Math.cos(phi), len * Math.sin(theta) * Math.sin(phi), len * Math.cos(theta)];
      const n = [0, 1, 2].map(() => Math.floor(rand() * 7) - 3);
      const d = short.map((s, c) => s + n[0] * vectors[c] + n[1] * vectors[3 + c] + n[2] * vectors[6 + c]);
      minimumImage(cell, d);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(d[c] - short[c]) < 1e-9, `trial ${trial}: ${d} vs ${short}`);
    }
  }
});

function pair(symbols: string[], coords: number[]): { positions: Float32Array; symbols: string[] } {
  return { positions: new Float32Array(coords), symbols };
}

test("a bond across the cell wall is found (orthogonal)", () => {
  const cell = makeCell([10, 0, 0, 0, 10, 0, 0, 0, 10])!;
  const { positions, symbols } = pair(["O", "H"], [0.2, 5, 5, 9.6, 5, 5]); // 0.6 Å apart through the wall
  assert.deepEqual(computeBonds(positions, 0, 2, symbols, cell), [{ a: 0, b: 1 }]);
  assert.deepEqual(computeBonds(positions, 0, 2, symbols), [], "without the cell they are 9.4 Å apart");
});

test("a bond across the cell wall is found (triclinic, every wall)", () => {
  const cell = makeCell(TOBERMORITE)!;
  const v = TOBERMORITE;
  const o = [1.0, 1.0, 1.0];
  const bond = [0.55, -0.6, 0.45]; // ~0.95 Å, an O-H bond
  for (const wall of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [-1, 1, 0]]) {
    const h = o.map((x, c) => x + bond[c] + wall[0] * v[c] + wall[1] * v[3 + c] + wall[2] * v[6 + c]);
    const { positions, symbols } = pair(["O", "H"], [...o, ...h]);
    assert.deepEqual(computeBonds(positions, 0, 2, symbols, cell), [{ a: 0, b: 1 }], `image ${wall}`);
  }
});

test("only periodic directions wrap", () => {
  const cell = makeCell([10, 0, 0, 0, 10, 0, 0, 0, 10], [true, true, false])!;
  const across = (axis: number) => {
    const h = [5, 5, 5];
    const o = [5, 5, 5];
    o[axis] = 0.2;
    h[axis] = 9.6;
    return computeBonds(new Float32Array([...o, ...h]), 0, 2, ["O", "H"], cell).length;
  };
  assert.equal(across(0), 1);
  assert.equal(across(1), 1);
  assert.equal(across(2), 0, "z is not periodic");
});

test("periodic and plain bond searches agree away from the walls", async () => {
  const t = await loadXyz("public/samples/tobermorite.xyz");
  const cell = t.cells![0]!;
  const symbols = t.frameSymbols.slice(0, t.numAtoms);
  const periodic = computeBonds(t.positions, 0, t.numAtoms, symbols, cell);
  const plain = new Set(computeBonds(t.positions, 0, t.numAtoms, symbols).map((b) => `${b.a}-${b.b}`));
  // Every bond the plain search finds is also found with the cell; the cell
  // only adds bonds that cross a wall.
  const periodicKeys = new Set(periodic.map((b) => `${b.a}-${b.b}`));
  for (const key of plain) assert.ok(periodicKeys.has(key), `lost ${key}`);
  assert.ok(periodic.length > plain.size, `expected bonds across walls (${periodic.length} vs ${plain.size})`);
});

/** A water molecule drifting through the +x wall of a 12 Å box, wrapped every frame. */
function driftingWater(cell: Cell | null): Trajectory {
  const frames = 60;
  const water = [[0, 0, 0], [0.76, 0.59, 0], [-0.76, 0.59, 0]];
  const positions = new Float32Array(frames * 9);
  for (let f = 0; f < frames; f++) {
    const shift = 9 + f * 0.1; // crosses x = 12 around frame 30
    water.forEach((atom, i) => {
      positions[f * 9 + i * 3] = (((atom[0] + shift) % 12) + 12) % 12;
      positions[f * 9 + i * 3 + 1] = atom[1] + 6;
      positions[f * 9 + i * 3 + 2] = atom[2] + 6;
    });
  }
  const symbols = ["O", "H", "H"];
  return {
    numFrames: frames,
    numAtoms: 3,
    symbols,
    frameSymbols: Array.from({ length: frames }, () => symbols).flat(),
    positions,
    comments: new Array(frames).fill(""),
    ...(cell ? { cells: new Array(frames).fill(cell) } : {}),
  };
}

test("atoms wrapping through a wall produce no events and keep their bonds", () => {
  const cell = makeCell([12, 0, 0, 0, 12, 0, 0, 0, 12])!;
  const t = driftingWater(cell);
  assert.deepEqual(detectBondEvents(t), []);
  for (let f = 0; f < t.numFrames; f++) {
    assert.equal(computeBonds(t.positions, f, 3, t.symbols, cell).length, 2, `frame ${f}`);
  }
  // Without the cell, the frames where the molecule straddles the wall lose
  // its bonds; the control shows the check above can fail.
  const plain = driftingWater(null);
  const lost = [...Array(plain.numFrames).keys()].filter((f) => computeBonds(plain.positions, f, 3, plain.symbols).length < 2);
  assert.ok(lost.length > 0);
});

test("a bond that breaks across a wall is an event", () => {
  // O just inside x = 0, H just across the wall at x ~ 11.x, pulled away
  // from O from frame 10 on.
  const frames = 40;
  const positions = new Float32Array(frames * 6);
  for (let f = 0; f < frames; f++) {
    const gap = 0.96 + Math.max(0, f - 10) * 0.08;
    positions.set([0.3, 6, 6, (((0.3 - gap) % 12) + 12) % 12, 6, 6], f * 6);
  }
  const symbols = ["O", "H"];
  const make = (cell: Cell | null): Trajectory => ({
    numFrames: frames,
    numAtoms: 2,
    symbols,
    frameSymbols: Array.from({ length: frames }, () => symbols).flat(),
    positions,
    comments: new Array(frames).fill(""),
    ...(cell ? { cells: new Array(frames).fill(cell) } : {}),
  });
  const events = detectBondEvents(make(makeCell([12, 0, 0, 0, 12, 0, 0, 0, 12])));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].broken, [[0, 1]]);
  assert.equal(events[0].label, "O0–H1 bond breaks");
  assert.deepEqual(detectBondEvents(make(null)), [], "without the cell the bond is never seen");
});

let tobe: Trajectory;
let baseline: string[];

before(async () => {
  tobe = firstFrames(await loadXyz("public/samples/tobe.xyz"), 12);
  baseline = eventSummary(detectBondEvents(tobe));
});

test("tobermorite events are unchanged by 100 random shifts and re-wrapping", () => {
  assert.ok(baseline.length > 0, "the sample should contain events");
  const rand = random(42);
  const v = tobe.cells![0]!.vectors;
  for (let trial = 0; trial < 100; trial++) {
    const f = [rand(), rand(), rand()];
    const shift: [number, number, number] = [0, 1, 2].map((c) => f[0] * v[c] + f[1] * v[3 + c] + f[2] * v[6 + c]) as [number, number, number];
    const moved = eventSummary(detectBondEvents(shiftAndWrap(tobe, shift)));
    assert.deepEqual(moved, baseline, `trial ${trial}, shift ${shift.map((x) => x.toFixed(2))}`);
  }
});
