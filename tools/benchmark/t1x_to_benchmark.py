#!/usr/bin/env python3
"""Turn Transition1x reactions into a known-answer benchmark for Chapters.

Transition1x (Schreiner et al., Sci. Data 2022) holds ~10k elementary reactions,
each with a reactant, transition state and product geometry computed at
wB97x/6-31G(d). For every sampled reaction this script writes:

  reactions/<id>.xyz   a trajectory: reactant (held), reactant -> TS -> product
                       (linearly interpolated), product (held)
  answers.json         the true bond changes and a reaction category

The answer key compares the reactant and product bond graphs, so it never looks
at the trajectory the detector sees. Bonds use covalent radii with hysteresis:
a pair counts as bonded below 1.15x the radius sum and unbonded above 1.25x.
Pairs that end between those bounds are listed as "ambiguous" and left out of
scoring, so borderline geometry can't make a detector look right or wrong.

H-H pairs get their own thresholds (bonded below 0.80 Å, unbonded above 1.00 Å):
H2's 0.74 Å bond sits inside the generic band, which hid H2 eliminations.

The interpolated path isn't real dynamics. It only gives each reaction a
continuous trajectory whose start and end are exact.

Usage:
  pip install h5py numpy
  python tools/benchmark/t1x_to_benchmark.py Transition1x.h5 bench/ --limit 200
  python tools/benchmark/t1x_to_benchmark.py --rekey bench/   # rebuild answers.json from bench/reactions
"""

import argparse
import json
import random
import sys
from pathlib import Path

import h5py
import numpy as np

SYMBOLS = {1: "H", 6: "C", 7: "N", 8: "O", 9: "F", 14: "Si", 15: "P", 16: "S", 17: "Cl"}
# Covalent radii (Å), matching src/elements.ts.
RADII = {"H": 0.31, "C": 0.76, "N": 0.71, "O": 0.66, "F": 0.57, "Si": 1.11, "P": 1.07, "S": 1.05, "Cl": 1.02}
BONDED_BELOW = 1.15
UNBONDED_ABOVE = 1.25
# Absolute bounds (Å) for H-H, whose 0.74 Å bond is 1.19x the radius sum.
HH_BONDED_BELOW = 0.80
HH_UNBONDED_ABOVE = 1.00


def bond_states(symbols, positions):
    """Per pair: True (bonded), False (unbonded) or None (in the hysteresis band)."""
    n = len(symbols)
    states = {}
    for i in range(n):
        for j in range(i + 1, n):
            limit = RADII.get(symbols[i], 0.7) + RADII.get(symbols[j], 0.7)
            bonded, unbonded = BONDED_BELOW * limit, UNBONDED_ABOVE * limit
            if symbols[i] == "H" and symbols[j] == "H":
                bonded, unbonded = HH_BONDED_BELOW, HH_UNBONDED_ABOVE
            d = float(np.linalg.norm(positions[i] - positions[j]))
            if d < bonded:
                states[(i, j)] = True
            elif d > unbonded:
                states[(i, j)] = False
            else:
                states[(i, j)] = None
    return states


def cyclomatic(n_atoms, bonds):
    """Independent ring count: edges - vertices + connected components."""
    parent = list(range(n_atoms))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in bonds:
        parent[find(a)] = find(b)
    components = len({find(i) for i in range(n_atoms)})
    return len(bonds) - n_atoms + components


def categorize(symbols, formed, broken, rings_before, rings_after):
    """Reaction category, using the same names and order as src/chapterChemistry.ts."""
    broken_atoms = {x for pair in broken for x in pair}
    # Two H atoms leave their partners and bond to each other.
    for a, b in formed:
        if symbols[a] == "H" and symbols[b] == "H" and a in broken_atoms and b in broken_atoms:
            return "h2-elimination"
    for a, b in broken:
        for h in (a, b):
            if symbols[h] != "H":
                continue
            donor = b if h == a else a
            for c, d in formed:
                if h in (c, d) and (d if h == c else c) != donor:
                    return "proton-transfer"
    if rings_before != rings_after:
        return "ring-change"
    if formed and not broken:
        return "bond-formation"
    if broken and not formed:
        return "bond-cleavage"
    if any(x in broken_atoms for pair in formed for x in pair):
        return "ligand-exchange"
    return "other"


def answer_key(symbols, reactant, product):
    before = bond_states(symbols, reactant)
    after = bond_states(symbols, product)
    formed, broken, ambiguous = [], [], []
    for pair, was in before.items():
        now = after[pair]
        if was is None or now is None:
            # Any change into or out of the band, e.g. unbonded -> band.
            if was != now:
                ambiguous.append(list(pair))
        elif was != now:
            (formed if now else broken).append(list(pair))
    bonds_r = [p for p, s in before.items() if s]
    bonds_p = [p for p, s in after.items() if s]
    category = categorize(
        symbols, formed, broken, cyclomatic(len(symbols), bonds_r), cyclomatic(len(symbols), bonds_p)
    )
    return {"formed": formed, "broken": broken, "ambiguous": ambiguous, "category": category}


def path_frames(reactant, ts, product, hold, steps):
    frames = [reactant] * hold
    for start, end in ((reactant, ts), (ts, product)):
        for k in range(1, steps + 1):
            frames.append(start + (end - start) * (k / steps))
    frames += [product] * hold
    return frames


def write_xyz(path, symbols, frames, comment):
    with open(path, "w") as f:
        for i, frame in enumerate(frames):
            f.write(f"{len(symbols)}\n")
            f.write(f'Properties=species:S:1:pos:R:3 frame={i} {comment}\n')
            for s, (x, y, z) in zip(symbols, frame):
                f.write(f"{s} {x:.5f} {y:.5f} {z:.5f}\n")


def geometry(group, name):
    positions = np.asarray(group[name]["positions"], dtype=np.float64)
    return positions[0] if positions.ndim == 3 else positions


def read_xyz_endpoints(path):
    """First and last frame of a trajectory written by write_xyz."""
    with open(path) as f:
        lines = f.read().splitlines()
    n = int(lines[0])
    stride = n + 2
    frames = len(lines) // stride

    def frame(k):
        rows = [line.split() for line in lines[k * stride + 2 : k * stride + 2 + n]]
        return [r[0] for r in rows], np.array([[float(v) for v in r[1:4]] for r in rows])

    symbols, first = frame(0)
    _, last = frame(frames - 1)
    return symbols, first, last


def rekey(out):
    """Recompute every answer from the reactant/product frames already on disk."""
    path = out / "answers.json"
    manifest = json.loads(path.read_text())
    kept = []
    for answer in manifest["reactions"]:
        symbols, reactant, product = read_xyz_endpoints(out / answer["file"])
        key = answer_key(symbols, reactant, product)
        if key["formed"] or key["broken"]:
            kept.append({**answer, "symbols": symbols, **key})
    manifest["reactions"] = kept
    manifest["bondRule"] = {
        "bondedBelow": BONDED_BELOW, "unbondedAbove": UNBONDED_ABOVE, "radii": RADII,
        "hhBondedBelow": HH_BONDED_BELOW, "hhUnbondedAbove": HH_UNBONDED_ABOVE,
    }
    path.write_text(json.dumps(manifest, indent=1))
    return kept


def summarize(answers, out, skipped):
    counts = {}
    for a in answers:
        counts[a["category"]] = counts.get(a["category"], 0) + 1
    print(f"Wrote {len(answers)} reactions to {out} (skipped {skipped}). Categories: {counts}")


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--rekey":
        out = Path(sys.argv[2])
        before = len(json.loads((out / "answers.json").read_text())["reactions"])
        kept = rekey(out)
        summarize(kept, out, before - len(kept))
        return

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("h5", help="path to Transition1x.h5")
    parser.add_argument("out", help="output directory")
    parser.add_argument("--split", default="test", help="h5 group to sample from: data, train, val or test")
    parser.add_argument("--limit", type=int, default=200, help="number of reactions to sample")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--hold", type=int, default=5, help="frames to hold at reactant and product")
    parser.add_argument("--steps", type=int, default=15, help="interpolated frames per leg")
    args = parser.parse_args()

    out = Path(args.out)
    (out / "reactions").mkdir(parents=True, exist_ok=True)

    with h5py.File(args.h5, "r") as f:
        if args.split not in f:
            sys.exit(f"No group '{args.split}' in {args.h5}; found {list(f.keys())}")
        split = f[args.split]
        reactions = [(formula, rxn) for formula in split for rxn in split[formula]]
        random.Random(args.seed).shuffle(reactions)

        answers = []
        skipped = 0
        for formula, rxn in reactions:
            if len(answers) >= args.limit:
                break
            group = split[formula][rxn]
            try:
                numbers = [int(z) for z in group["atomic_numbers"]]
                symbols = [SYMBOLS[z] for z in numbers]
                reactant = geometry(group, "reactant")
                ts = geometry(group, "transition_state")
                product = geometry(group, "product")
            except KeyError:
                skipped += 1
                continue
            key = answer_key(symbols, reactant, product)
            if not key["formed"] and not key["broken"]:
                skipped += 1  # no unambiguous bond change to find
                continue
            rid = f"{formula}_{rxn}"
            write_xyz(
                out / "reactions" / f"{rid}.xyz",
                symbols,
                path_frames(reactant, ts, product, args.hold, args.steps),
                f"source=Transition1x formula={formula} rxn={rxn}",
            )
            answers.append({"id": rid, "file": f"reactions/{rid}.xyz", "formula": formula, "symbols": symbols, **key})

    manifest = {
        "format": "gearsxr-benchmark",
        "version": 1,
        "source": "Transition1x",
        "split": args.split,
        "seed": args.seed,
        "bondRule": {
            "bondedBelow": BONDED_BELOW, "unbondedAbove": UNBONDED_ABOVE, "radii": RADII,
            "hhBondedBelow": HH_BONDED_BELOW, "hhUnbondedAbove": HH_UNBONDED_ABOVE,
        },
        "path": {"hold": args.hold, "steps": args.steps},
        "reactions": answers,
    }
    (out / "answers.json").write_text(json.dumps(manifest, indent=1))
    summarize(answers, out, skipped)


if __name__ == "__main__":
    main()
