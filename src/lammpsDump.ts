// Streaming parser for LAMMPS text dumps (`dump custom` / `dump atom`).
//
// Each frame is:
//   ITEM: TIMESTEP / <step>
//   ITEM: NUMBER OF ATOMS / <n>
//   ITEM: BOX BOUNDS [xy xz yz] <x flags> <y flags> <z flags> / three lines
//   ITEM: ATOMS <column names> / n lines
// Positions come from x y z, else xu yu zu (unwrapped), else xs ys zs or
// xsu ysu zsu (fractional). Elements come from an `element` column, else
// from a type -> element map the caller supplies. Atoms are put in atom-ID
// order, because LAMMPS writes them in per-processor order unless the dump
// is sorted. The box becomes a periodic cell (see cell.ts), so bonds across
// the walls and atoms wrapping through them are handled like extended XYZ.

import { makeCell, type Cell } from "./cell";
import { createLineReader } from "./lineReader";
import type { ParseProgress, Trajectory } from "./xyzParser";

const MAX_ATOMS_PER_FRAME = 2_000_000;

/** The dump has no element column and no map was given; `types` lists the atom types seen. */
export class MissingTypeMapError extends Error {
  constructor(readonly types: number[]) {
    super(`This LAMMPS dump has atom types (${types.join(", ")}) but no element column. Say which element each type is.`);
  }
}

export interface LammpsDumpOptions {
  /** Element symbol per LAMMPS atom type, for dumps without an `element` column. */
  typeElements?: Record<number, string>;
}

export interface LammpsBox {
  /** Lattice vectors a, b, c as rows (Å). */
  vectors: number[];
  origin: [number, number, number];
  pbc: [boolean, boolean, boolean];
}

/**
 * Box from the three BOX BOUNDS lines. A triclinic box lists bounding-box
 * extents plus tilts; the LAMMPS docs give the conversion back to
 * xlo/xhi/ylo/yhi, and then a = (lx, 0, 0), b = (xy, ly, 0), c = (xz, yz, lz).
 */
export function parseBoxBounds(header: string, lines: string[]): LammpsBox {
  const tokens = header.replace(/^ITEM:\s*BOX BOUNDS\s*/, "").trim().split(/\s+/);
  const triclinic = tokens[0] === "xy";
  const flags = tokens.slice(triclinic ? 3 : 0);
  const rows = lines.map((line) => line.trim().split(/\s+/).map(Number));
  if (rows.length !== 3 || rows.some((r) => r.length < 2 || r.some((v) => !Number.isFinite(v)))) {
    throw new Error("Could not read the BOX BOUNDS lines of the LAMMPS dump.");
  }
  let [xlo, xhi] = rows[0];
  let [ylo, yhi] = rows[1];
  const [zlo, zhi] = rows[2];
  const xy = triclinic ? rows[0][2] ?? 0 : 0;
  const xz = triclinic ? rows[1][2] ?? 0 : 0;
  const yz = triclinic ? rows[2][2] ?? 0 : 0;
  if (triclinic) {
    xlo -= Math.min(0, xy, xz, xy + xz);
    xhi -= Math.max(0, xy, xz, xy + xz);
    ylo -= Math.min(0, yz);
    yhi -= Math.max(0, yz);
  }
  const pbc = [0, 1, 2].map((i) => (flags[i] ?? "pp") === "pp") as [boolean, boolean, boolean];
  return {
    vectors: [xhi - xlo, 0, 0, xy, yhi - ylo, 0, xz, yz, zhi - zlo],
    origin: [xlo, ylo, zlo],
    pbc,
  };
}

interface Columns {
  id: number;
  type: number;
  element: number;
  position: [number, number, number];
  scaled: boolean;
}

function parseColumns(header: string): Columns {
  const names = header.replace(/^ITEM:\s*ATOMS\s*/, "").trim().split(/\s+/);
  const at = (name: string) => names.indexOf(name);
  for (const [x, y, z, scaled] of [
    ["x", "y", "z", false],
    ["xu", "yu", "zu", false],
    ["xs", "ys", "zs", true],
    ["xsu", "ysu", "zsu", true],
  ] as const) {
    if (at(x) >= 0 && at(y) >= 0 && at(z) >= 0) {
      return { id: at("id"), type: at("type"), element: at("element"), position: [at(x), at(y), at(z)], scaled };
    }
  }
  throw new Error(`The LAMMPS dump has no position columns (x y z, xu yu zu, xs ys zs or xsu ysu zsu): "${names.join(" ")}"`);
}

/** Quick check of the first bytes of a file: LAMMPS dumps start with "ITEM: TIMESTEP". */
export function looksLikeLammpsDump(head: string): boolean {
  return /^\s*ITEM:\s*TIMESTEP/.test(head);
}

export async function parseLammpsDump(
  file: Blob,
  options: LammpsDumpOptions = {},
  onProgress?: (p: ParseProgress) => void,
): Promise<Trajectory> {
  const lines = createLineReader(file);
  const expectLine = async (what: string) => {
    const line = await lines.next();
    if (line === null) throw new Error(`The LAMMPS dump ended while reading ${what}.`);
    return line;
  };

  let numAtoms = -1;
  let numFrames = 0;
  let order: number[] = []; // atom IDs of the first frame, ascending
  let indexOfId = new Map<number, number>();
  const symbols: string[] = [];
  const frameSymbols: string[] = [];
  const comments: string[] = [];
  const cells: (Cell | null)[] = [];
  const cellCache = new Map<string, Cell | null>();
  let positions = new Float32Array(0);
  let frameCapacity = 0;
  let typesWithoutElement: Set<number> | null = null;

  let timestep = "";
  let box: LammpsBox | null = null;
  let boxKey = "";

  while (true) {
    const line = await lines.next();
    if (line === null) break;
    const item = line.trim();
    if (!item) continue;
    if (!item.startsWith("ITEM:")) throw new Error(`Unexpected line in LAMMPS dump: "${item.slice(0, 80)}"`);

    if (item.startsWith("ITEM: TIMESTEP")) {
      timestep = (await expectLine("the timestep")).trim();
    } else if (item.startsWith("ITEM: NUMBER OF ATOMS")) {
      const n = parseInt(await expectLine("the atom count"), 10);
      if (!(n >= 1 && n <= MAX_ATOMS_PER_FRAME)) throw new Error(`Atom count ${n} is out of the supported range (1..${MAX_ATOMS_PER_FRAME}).`);
      if (numAtoms === -1) numAtoms = n;
      else if (n !== numAtoms) {
        throw new Error(`Timestep ${timestep} has ${n} atoms, expected ${numAtoms}. Variable atom counts are not supported.`);
      }
    } else if (item.startsWith("ITEM: BOX BOUNDS")) {
      const bounds = [await expectLine("the box"), await expectLine("the box"), await expectLine("the box")];
      box = parseBoxBounds(item, bounds);
      boxKey = `${item}\n${bounds.join("\n")}`;
    } else if (item.startsWith("ITEM: ATOMS")) {
      if (numAtoms === -1 || !box) throw new Error("LAMMPS dump frame is missing its atom count or box.");
      const columns = parseColumns(item);
      if (columns.id < 0) throw new Error("The LAMMPS dump needs an id column to keep atoms in order between frames.");
      if (columns.element < 0 && columns.type < 0) throw new Error("The LAMMPS dump needs an element or a type column.");

      const ids = new Int32Array(numAtoms);
      const xyz = new Float64Array(numAtoms * 3);
      const elements: string[] = new Array(numAtoms);
      const m = box.vectors;
      for (let i = 0; i < numAtoms; i++) {
        const parts = (await expectLine("atoms")).trim().split(/\s+/);
        ids[i] = Number(parts[columns.id]);
        const p = columns.position.map((c) => Number(parts[c]));
        if (!p.every(Number.isFinite)) throw new Error(`Timestep ${timestep}: could not read a position for atom ${parts[columns.id]}.`);
        if (columns.scaled) {
          for (let c = 0; c < 3; c++) xyz[i * 3 + c] = box.origin[c] + p[0] * m[c] + p[1] * m[3 + c] + p[2] * m[6 + c];
        } else {
          xyz.set(p, i * 3);
        }
        if (columns.element >= 0) {
          elements[i] = parts[columns.element];
        } else {
          const type = Number(parts[columns.type]);
          const element = options.typeElements?.[type];
          if (element) elements[i] = element;
          else (typesWithoutElement ??= new Set()).add(type);
        }
      }
      if (typesWithoutElement) throw new MissingTypeMapError([...typesWithoutElement].sort((a, b) => a - b));

      if (numFrames === 0) {
        order = [...ids].sort((a, b) => a - b);
        indexOfId = new Map(order.map((id, i) => [id, i]));
        if (indexOfId.size !== numAtoms) throw new Error("The LAMMPS dump has duplicate atom IDs.");
      }
      if (numFrames >= frameCapacity) {
        frameCapacity = Math.max(64, frameCapacity * 2);
        const grown = new Float32Array(frameCapacity * numAtoms * 3);
        grown.set(positions);
        positions = grown;
      }
      const base = numFrames * numAtoms;
      for (let i = 0; i < numAtoms; i++) {
        const index = indexOfId.get(ids[i]);
        if (index === undefined) throw new Error(`Timestep ${timestep}: atom ID ${ids[i]} is not in the first frame.`);
        positions[(base + index) * 3] = xyz[i * 3];
        positions[(base + index) * 3 + 1] = xyz[i * 3 + 1];
        positions[(base + index) * 3 + 2] = xyz[i * 3 + 2];
        frameSymbols[base + index] = elements[i];
        if (numFrames === 0) symbols[index] = elements[i];
      }

      let cell = cellCache.get(boxKey);
      if (cell === undefined) {
        cell = makeCell(box.vectors, box.pbc);
        cellCache.set(boxKey, cell);
      }
      cells.push(cell);
      comments.push(`Timestep=${timestep}`);
      numFrames++;
      onProgress?.({ framesParsed: numFrames, bytesRead: lines.bytesRead(), totalBytes: file.size });
    } else {
      // Unknown ITEM sections (e.g. ITEM: UNITS, ITEM: TIME) have one value line.
      await expectLine(item);
    }
  }

  if (numFrames === 0) throw new Error("The LAMMPS dump contained no frames.");
  return {
    numFrames,
    numAtoms,
    symbols,
    frameSymbols,
    positions: positions.slice(0, numFrames * numAtoms * 3),
    comments,
    ...(cells.some(Boolean) ? { cells } : {}),
  };
}
