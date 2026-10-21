"""Writes LAMMPS dump files for the reader tests (roadmap milestones 0.2, 0.3).

The files are written by LAMMPS itself, from the tobermorite sample, so the
tests check the reader against what LAMMPS really produces rather than
against our own idea of the format. Atoms do not interact (pair_style zero);
they only drift with thermal velocities, which is enough to make positions
differ between frames and to wrap a few atoms through the cell walls.
Floats are written with 10 significant digits: LAMMPS's default (6) alone
puts positions up to ~1.4e-4 Å apart between column styles, which would hide
reader errors of that size.

Usage (needs the LAMMPS Python wheel: pip install lammps):
    python tools/fixtures/make_lammps_fixtures.py

Writes tests/fixtures/lammps/*.dump. Re-run it only when the fixtures need
to change; the tests read the committed files.
"""

import os
import re
import sys

from lammps import lammps

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, "public", "samples", "tobermorite.xyz")
OUT = os.path.join(ROOT, "tests", "fixtures", "lammps")
MASSES = {"Ca": 40.078, "Si": 28.085, "O": 15.999, "H": 1.008}


def read_xyz(path):
    with open(path) as f:
        n = int(f.readline())
        comment = f.readline()
        atoms = [f.readline().split() for _ in range(n)]
    lattice = [float(v) for v in re.search(r'Lattice="([^"]+)"', comment).group(1).split()]
    return lattice, [(a[0], float(a[1]), float(a[2]), float(a[3])) for a in atoms]


def write_data(path, lattice, atoms, elements):
    ax, ay, az, bx, by, bz, cx, cy, cz = lattice
    # LAMMPS needs a = (lx, 0, 0), b = (xy, ly, 0), c = (xz, yz, lz).
    assert ay == az == bz == 0, "tobermorite's cell is already lower-triangular"
    with open(path, "w") as f:
        f.write("tobermorite from public/samples/tobermorite.xyz\n\n")
        f.write(f"{len(atoms)} atoms\n{len(elements)} atom types\n\n")
        f.write(f"0 {ax} xlo xhi\n0 {by} ylo yhi\n0 {cz} zlo zhi\n{bx} {cx} {cy} xy xz yz\n\n")
        f.write("Masses\n\n")
        for t, el in enumerate(elements, 1):
            f.write(f"{t} {MASSES[el]}\n")
        f.write("\nAtoms # atomic\n\n")
        for i, (el, x, y, z) in enumerate(atoms, 1):
            f.write(f"{i} {elements.index(el) + 1} {x} {y} {z}\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    lattice, atoms = read_xyz(SOURCE)
    elements = sorted({a[0] for a in atoms}, key=lambda e: ["Ca", "Si", "O", "H"].index(e))
    data = os.path.join(OUT, "tobermorite.data")
    write_data(data, lattice, atoms, elements)

    lmp = lammps(cmdargs=["-nocite", "-log", "none", "-screen", "none"])
    names = " ".join(elements)
    commands = f"""
units metal
atom_style atomic
boundary p p p
box tilt large
read_data {data}
pair_style zero 3.0
pair_coeff * *
velocity all create 3000.0 4928459 mom yes rot no
timestep 0.002
fix move all nve
dump unscaled all custom 50 {OUT}/tobermorite-unscaled.dump id type element x y z
dump_modify unscaled element {names} format float %.10g sort id
dump scaled all custom 50 {OUT}/tobermorite-scaled.dump id element xs ys zs
dump_modify scaled element {names} format float %.10g
dump unwrapped all custom 50 {OUT}/tobermorite-unwrapped.dump id element xu yu zu
dump_modify unwrapped element {names} format float %.10g sort id
dump types all custom 50 {OUT}/tobermorite-types.dump id type x y z
dump_modify types sort id format float %.10g
run 100
"""
    for line in commands.strip().splitlines():
        lmp.command(line)
    lmp.close()
    os.remove(data)
    for name in sorted(os.listdir(OUT)):
        print(name, os.path.getsize(os.path.join(OUT, name)), "bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
