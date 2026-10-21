"""Runs Chapters and two published tools on one shared trajectory (roadmap milestone 0.4).

1. LAMMPS runs a small ReaxFF methane combustion (CH4 + O2, the ReacNetGenerator
   paper's test chemistry, scaled down) and writes, at the same steps:
   - a dump (id element x y z) for Chapters,
   - fix reaxff/species molecule counts,
   - fix reaxff/bonds bond orders for ReacNetGenerator.
2. ReacNetGenerator (Zeng et al., PCCP 2020) extracts its reactions from the bond orders.
3. Chapters (tools/baselines/chapters_events.ts) detects events in the dump.
4. All three are converted to one format and compared in report.md / report.json:
   molecule counts per step (Chapters vs fix reaxff/species) and formula-level
   reactions (Chapters vs ReacNetGenerator).

The tools define bonds differently (Chapters: covalent radii x 1.2; ReaxFF:
bond order >= 0.3), so differences are expected; this script only makes them
measurable. Explaining them is milestone 1.6.

Usage (needs: pip install lammps reacnetgenerator; npm install):
    python tools/baselines/run_baselines.py [--steps 30000] [--every 30] [--out bench/baselines/methane-combustion]
"""

import argparse
import collections
import json
import os
import re
import subprocess
import sys

from lammps import lammps

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
POTENTIALS = os.path.join(os.path.dirname(__import__("lammps").__file__), "share", "lammps", "potentials")

CH4 = """CH4 for create_atoms

5 atoms

Coords

1 0.000 0.000 0.000
2 0.629 0.629 0.629
3 -0.629 -0.629 0.629
4 -0.629 0.629 -0.629
5 0.629 -0.629 -0.629

Types

1 1
2 2
3 2
4 2
5 2

Charges

1 0
2 0
3 0
4 0
5 0
"""

O2 = """O2 for create_atoms

2 atoms

Coords

1 0.000 0.000 0.000
2 1.210 0.000 0.000

Types

1 3
2 3

Charges

1 0
2 0
"""


def run_lammps(work, steps, every, n_ch4, n_o2, box, temperature):
    for name, text in (("ch4.mol", CH4), ("o2.mol", O2)):
        with open(os.path.join(work, name), "w") as f:
            f.write(text)
    lmp = lammps(cmdargs=["-nocite", "-log", os.path.join(work, "log.lammps"), "-screen", "none"])
    script = f"""
units real
atom_style charge
boundary p p p
region box block 0 {box} 0 {box} 0 {box}
create_box 3 box
mass 1 12.011
mass 2 1.008
mass 3 15.999
molecule ch4 {work}/ch4.mol
molecule o2 {work}/o2.mol
create_atoms 0 random {n_ch4} 1234 NULL mol ch4 5678 overlap 2.5 maxtry 500
create_atoms 0 random {n_o2} 2345 NULL mol o2 6789 overlap 2.5 maxtry 500
pair_style reaxff NULL
pair_coeff * * {POTENTIALS}/ffield.reax.cho C H O
fix qeq all qeq/reaxff 1 0.0 10.0 1.0e-6 reaxff
velocity all create {temperature} 4928459 mom yes rot yes dist gaussian
fix thermostat all nvt temp {temperature} {temperature} 10.0
timestep 0.1
fix species all reaxff/species 1 1 {every} {work}/species.out element C H O
fix bonds all reaxff/bonds {every} {work}/bonds.reaxff
dump traj all custom {every} {work}/traj.dump id element x y z
dump_modify traj element C H O sort id format float %.8g
thermo 1000
run {steps}
"""
    for line in script.strip().splitlines():
        lmp.command(line)
    natoms = lmp.get_natoms()
    lmp.close()
    return natoms


FORMULA = re.compile(r"([A-Z][a-z]?)(\d*)")


def hill(formula):
    """Normalizes a formula (e.g. ReaxFF's 'H2O1' or 'O2H2') to Hill order without 1s."""
    counts = collections.Counter()
    for element, n in FORMULA.findall(formula):
        counts[element] += int(n or 1)
    order = sorted(counts, key=lambda e: ((0 if e == "C" else 1 if e == "H" else 2) if "C" in counts else 2, e))
    return "".join(f"{e}{counts[e] if counts[e] > 1 else ''}" for e in order)


def read_reaxff_species(path):
    """fix reaxff/species output: a '# Timestep No_Moles No_Specs A B ...' header, then a values line, per step."""
    out = {}
    with open(path) as f:
        lines = [l.split() for l in f if l.strip()]
    for header, values in zip(lines[0::2], lines[1::2]):
        names = header[4:]
        step = int(values[0])
        counts = collections.Counter()
        for name, n in zip(names, values[3:]):
            counts[hill(name)] += int(n)
        out[step] = dict(counts)
    return out


def smiles_formula(smiles):
    from rdkit import Chem
    from rdkit.Chem.rdMolDescriptors import CalcMolFormula

    mol = Chem.MolFromSmiles(smiles, sanitize=False)
    if mol is None:
        return smiles
    mol.UpdatePropertyCache(strict=False)
    return hill(re.sub(r"[+-]\d*$", "", CalcMolFormula(mol)))


def read_reacnetgenerator(path):
    """'.reaction' file: '<count> A->B' per line (a species turning into another that shares
    atoms with it), species as SMILES; '+' sides are split the same way if present."""
    reactions = collections.Counter()
    with open(path) as f:
        for line in f:
            parts = line.split()
            if len(parts) != 2 or "->" not in parts[1]:
                continue
            left, right = parts[1].split("->")
            side = lambda s: " + ".join(sorted(smiles_formula(x) for x in s.split("+")))
            reactions[f"{side(left)} -> {side(right)}"] += int(parts[0])
    return reactions


def compare(work, out, natoms, steps, every, seconds):
    chapters = json.load(open(os.path.join(work, "chapters.json")))
    reaxff = read_reaxff_species(os.path.join(work, "species.out"))
    rng = read_reacnetgenerator(os.path.join(work, "bonds.reaxff.reaction"))

    # Molecule counts at the same steps.
    agreement = []
    differences = collections.Counter()
    for frame, step in enumerate(chapters["steps"]):
        if step not in reaxff:
            continue
        ours, theirs = collections.Counter(chapters["species"][frame]), collections.Counter(reaxff[step])
        shared = sum((ours & theirs).values())
        agreement.append(shared / max(sum(ours.values()), sum(theirs.values())))
        for name in set(ours) | set(theirs):
            differences[name] += abs(ours[name] - theirs[name])

    # ReacNetGenerator counts species-to-species conversions ("A -> B" for molecules that share
    # atoms), so Chapters' events are compared in that form; a reaction and its reverse count
    # separately in both.
    ours = collections.Counter(flow for e in chapters["events"] for flow in e["flows"])
    equations = collections.Counter(e["equation"] for e in chapters["events"])
    top_rng = [r for r, _ in rng.most_common(20)]
    found = [r for r in top_rng if ours[r] > 0]

    report = {
        "system": {"atoms": natoms, "steps": steps, "dump_every": every, "frames": chapters["numFrames"], "timestep_fs": 0.1},
        "species_agreement": {
            "mean": sum(agreement) / len(agreement),
            "min": min(agreement),
            "steps_compared": len(agreement),
            "largest_differences": differences.most_common(10),
        },
        "reactions": {
            "chapters_events": len(chapters["events"]),
            "chapters_distinct": len(ours),
            "reacnetgenerator_distinct": len(rng),
            "reacnetgenerator_top20_found_by_chapters": len(found),
            "reacnetgenerator_top20": [[r, rng[r], ours[r]] for r in top_rng],
            "chapters_top20": [[r, n, rng[r]] for r, n in ours.most_common(20)],
            "chapters_equations": equations.most_common(),
        },
        "seconds": seconds,
    }
    os.makedirs(out, exist_ok=True)
    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=1)

    s = report["species_agreement"]
    r = report["reactions"]
    lines = [
        "# Baselines: methane combustion (ReaxFF)",
        "",
        f"{natoms} atoms, {steps} steps of 0.1 fs ({steps * 0.1 / 1000:.1f} ps), every {every} steps saved ({chapters['numFrames']} frames).",
        "Written by tools/baselines/run_baselines.py. The tools define bonds differently (Chapters: covalent radii x 1.2;",
        "ReaxFF: bond order >= 0.3), so this measures how far apart they are; explaining the gap is milestone 1.6.",
        "",
        "## Molecule counts: Chapters vs fix reaxff/species",
        "",
        f"Share of molecules counted the same at each step: mean {s['mean'] * 100:.1f}%, lowest {s['min'] * 100:.1f}% ({s['steps_compared']} steps).",
        "",
        "| Molecule | Total count difference over all steps |",
        "|---|---|",
        *[f"| {name} | {n} |" for name, n in s["largest_differences"]],
        "",
        "## Reactions: Chapters vs ReacNetGenerator",
        "",
        "ReacNetGenerator lists a reaction as one species turning into another that shares atoms with it",
        "(\"A -> B\"), so each Chapters event is split the same way: CH4 + O2 -> CH3 + HO2 counts as",
        "CH4 -> CH3, CH4 -> HO2 and O2 -> HO2.",
        "",
        f"Chapters found {r['chapters_events']} events ({r['chapters_distinct']} distinct A -> B conversions);",
        f"ReacNetGenerator found {r['reacnetgenerator_distinct']} distinct conversions.",
        f"Of ReacNetGenerator's {min(20, r['reacnetgenerator_distinct'])} most frequent conversions, Chapters found {r['reacnetgenerator_top20_found_by_chapters']}.",
        "",
        "| ReacNetGenerator's top reactions | ReacNetGenerator count | Chapters count |",
        "|---|---|---|",
        *[f"| {eq} | {a} | {b} |" for eq, a, b in r["reacnetgenerator_top20"]],
        "",
        "| Chapters' top reactions | Chapters count | ReacNetGenerator count |",
        "|---|---|---|",
        *[f"| {eq} | {a} | {b} |" for eq, a, b in r["chapters_top20"]],
        "",
        "Chapters' events as whole equations:",
        "",
        "| Equation | Events |",
        "|---|---|",
        *[f"| {eq} | {n} |" for eq, n in r["chapters_equations"]],
        "",
        f"Run times: LAMMPS {seconds['lammps']:.0f} s, ReacNetGenerator {seconds['reacnetgenerator']:.0f} s, Chapters {seconds['chapters']:.1f} s.",
        "",
    ]
    open(os.path.join(out, "report.md"), "w").write("\n".join(lines))
    print("\n".join(lines))


def main():
    import time

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--steps", type=int, default=30000)
    p.add_argument("--every", type=int, default=30)
    p.add_argument("--ch4", type=int, default=20)
    p.add_argument("--o2", type=int, default=40)
    p.add_argument("--box", type=float, default=22.0)
    p.add_argument("--temperature", type=float, default=3500.0)
    p.add_argument("--work", default=os.path.join(ROOT, "tools", "baselines", "work"))
    p.add_argument("--out", default=os.path.join(ROOT, "bench", "baselines", "methane-combustion"))
    p.add_argument("--reuse", action="store_true", help="reuse the LAMMPS and ReacNetGenerator outputs in --work")
    args = p.parse_args()
    os.makedirs(args.work, exist_ok=True)
    timing = os.path.join(args.work, "timing.json")
    seconds = json.load(open(timing)) if args.reuse else {}

    if not args.reuse:
        t = time.time()
        natoms = run_lammps(args.work, args.steps, args.every, args.ch4, args.o2, args.box, args.temperature)
        seconds["lammps"] = time.time() - t
        print(f"LAMMPS: {natoms} atoms, {args.steps} steps ({seconds['lammps']:.0f} s)", file=sys.stderr)

        t = time.time()
        rng_bin = os.path.join(os.path.dirname(sys.executable), "reacnetgenerator")
        subprocess.run([rng_bin, "--type", "bond", "-i", "bonds.reaxff", "-a", "C", "H", "O", "-n", "4"], cwd=args.work,
                       check=True, stdout=subprocess.DEVNULL)
        seconds["reacnetgenerator"] = time.time() - t
        json.dump({**seconds, "natoms": natoms}, open(timing, "w"))
    natoms = seconds.pop("natoms", None) or json.load(open(timing))["natoms"]

    t = time.time()
    subprocess.run(["npx", "tsx", os.path.join(ROOT, "tools", "baselines", "chapters_events.ts"),
                    os.path.join(args.work, "traj.dump"), os.path.join(args.work, "chapters.json")], cwd=ROOT, check=True)
    seconds["chapters"] = json.load(open(os.path.join(args.work, "chapters.json")))["seconds"]

    compare(args.work, args.out, natoms, args.steps, args.every, seconds)


if __name__ == "__main__":
    main()
