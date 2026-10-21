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

## Results

Pending: the first full run is in progress.
