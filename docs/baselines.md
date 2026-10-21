# Baselines: Chapters next to ReacNetGenerator and fix reaxff/species

Roadmap milestone 0.4: run the published tools and Chapters on the same trajectory, and put
their outputs in one format so they can be compared.

## What runs

`tools/baselines/run_baselines.py` does everything in one go:

1. **LAMMPS** (pip wheel, 22 Jul 2025) runs a small ReaxFF methane combustion with the bundled
   `ffield.reax.cho`: 20 CH₄ and 40 O₂ in a 22 Å periodic box, NVT at 4000 K, 0.1 fs steps.
   Every 50 steps it writes, for the same frames:
   - a dump (`id element x y z`) for Chapters,
   - molecule counts from `fix reaxff/species` (bond order ≥ 0.3),
   - bond orders from `fix reaxff/bonds`, for ReacNetGenerator.
2. **ReacNetGenerator** (Zeng et al., PCCP 2020) reads the bond orders, filters noise with its
   hidden Markov model, and lists reactions between species (SMILES).
3. **Chapters** (`tools/baselines/chapters_events.ts`) detects events in the dump and writes, for
   each, its bond changes and a formula-level equation built from the molecules holding its atoms
   before and after (e.g. `CH4 + OH -> CH3 + H2O`), plus molecule counts per frame.
4. The script converts all three to Hill formulas and compares:
   - molecule counts per step, Chapters vs `fix reaxff/species`;
   - formula-level reactions, Chapters vs ReacNetGenerator (both directions counted separately).

The tools define a bond differently (Chapters: distance below 1.2 × the sum of covalent radii;
ReaxFF: bond order of at least 0.3), so they are not expected to agree exactly. This step makes
the gap measurable; explaining it is milestone 1.6.

## Run it

```bash
pip install lammps reacnetgenerator   # LAMMPS needs an MPI runtime (e.g. apt install libmpich12)
npm install
python tools/baselines/run_baselines.py                      # ~5 minutes on one CPU core
python tools/baselines/run_baselines.py --steps 3000         # quick check, ~20 s
```

Results go to `bench/baselines/methane-combustion/report.md` and `report.json`; scratch files
(trajectory, bond orders) to `tools/baselines/work/`, which is not committed.

## Results (21 Oct 2026)

180 atoms, 5 ps at 4000 K, 1001 frames. Full tables in
[bench/baselines/methane-combustion/report.md](../bench/baselines/methane-combustion/report.md).

| | Chapters | ReacNetGenerator | fix reaxff/species |
|---|---|---|---|
| Real reactions found (CH₄ + O₂ → CH₃ + HO₂, frame 760) | 1 of 1 | 1 of 1 | (counts only) |
| Other reported changes | 17 events, mostly C–H bonds breaking and re-forming | 6 "O₂ → O₂": one O₂ switching between two bond-order notations ([O][O] and [O]=[O]), no atom moves | |
| Molecule counts the same as fix reaxff/species | 85.7% per step on average (lowest 68.1%) | | reference |
| Run time | 0.5 s | 3 s | inside the 197 s LAMMPS run |

What this shows:

- **The one real reaction is found by both tools.** Chapters names it "H76 moves from C75 to
  O121". Split the way ReacNetGenerator counts reactions, it is the same three conversions:
  CH₄ → CH₃, CH₄ → HO₂, O₂ → HO₂.
- **Chapters reports bond flicker that ReacNetGenerator filters out.** At 4000 K, C–H bonds
  stretch past Chapters' 1.28 Å cutoff for longer than its 3-frame persistence (15 fs here):
  11 of the 18 events are "bond breaks and re-forms", and most of the molecule-count gap is
  the same stretching (extra H and CH₃, missing CH₄). ReacNetGenerator's hidden Markov model
  removes this noise. Two cutoffs (form below one distance, break above a larger one) and
  persistence set in femtoseconds are milestone 2.2; this run is now its first test case.
- **The rules call those flickers "ligand exchange"**, because the same atom loses and gains a
  partner. A break-and-re-form of the same bond should get its own category; that belongs with
  the decoy test (milestone 1.4).

So Phase 0's baseline step is in place, and the first comparison already points at the main
weakness to fix before liquids and gases: telling vibration from reaction.
