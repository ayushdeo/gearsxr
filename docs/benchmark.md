# Known-answer benchmark

This measures how well Chapters works without anyone labeling events by hand.

It uses reactions from **Transition1x** (Schreiner et al., *Scientific Data* 2022), a public
set of about 10,000 small-molecule reactions. Each reaction comes with reactant,
transition-state and product geometries. Comparing the reactant and product bond graphs gives
the true answer, so the benchmark can score:

- **The detector:** did it find the bonds that really formed and broke (precision, recall,
  F1)? Did it show each reaction as one chapter?
- **Each local model:** did it get the reaction category right? How often did it dismiss a
  real reaction as an "artifact"? Does its label name the atoms that actually changed?

## Run it on your laptop

1. **Get the dataset.** Download `Transition1x.h5` using the instructions in the official
   Transition1x repository (search "Transition1x Schreiner GitHub"). It's a multi-GB HDF5
   file. Keep it outside the repo; `*.h5` is git-ignored.
2. **Build the benchmark** (about 1 minute):
   ```bash
   pip install h5py numpy
   python tools/benchmark/t1x_to_benchmark.py path/to/Transition1x.h5 bench/ --limit 200
   ```
   This writes `bench/reactions/*.xyz` (one trajectory per reaction) and `bench/answers.json`
   (the answer key). Each trajectory holds the reactant, moves through the transition state
   to the product, then holds the product. Any of these files can also be opened in the
   viewer.
3. **Score it:**
   ```bash
   npm run bench -- bench/                                   # detector only, seconds
   npm run bench -- bench/ --models qwen2.5:7b,gemma2:9b     # plus models via Ollama
   ```
   The results go to `bench/report.md` (summary tables) and `bench/report.json` (every
   reaction, with each model's label, for digging into mistakes). `bench/` is git-ignored.

Options:
- `--limit N` scores only the first N reactions, for a quick check.
- `--persist N` changes the detector's persistence filter.
- `--endpoint URL` points at a different Ollama server.

## How the answer key works

- Bonds are covalent-radius based, with hysteresis. A pair is **bonded** below 1.15× the
  radius sum and **unbonded** above 1.25×.
- Pairs that end up between those bounds are recorded as *ambiguous* and not scored. This way
  borderline geometry can't make the detector look right or wrong.
- The category (proton-transfer, ring-change, bond-formation, bond-cleavage, ligand-exchange,
  other) is derived from the bond changes, with the same names the models are asked to use.
- Reactions with no unambiguous bond change are skipped.

## Caveats

- The path between geometries is a **linear interpolation**, not real dynamics. This tests
  the detector's logic (persistence, grouping, transfers) on clean data, not its robustness
  to thermal noise. A later step is to run short real-dynamics trajectories of the same
  reactions.
- The detector draws bonds at 1.2× the radius sum, which sits inside the answer key's
  1.15–1.25 band. Clear-cut changes are scored and borderline ones are ignored.
- Transition1x reactions are elementary steps in small gas-phase molecules (C, N, O, H). Good
  scores here don't automatically carry over to condensed-phase simulations like tobermorite.
- Category accuracy is only as good as the taxonomy. A model might give a correct chemical
  description under a different category.

## What it already caught

On a hand-made test set, the first run showed an H transfer split into two chapters: the H
broke from its donor, then bound to its acceptor 15 frames later, outside the 5-frame
grouping window. The detector now links an atom's bond break to its next bond formation
within 30 frames (`transferWindowFrames`). This is the kind of fix the benchmark is meant to
drive.
