# Known-answer benchmark

This measures how well Chapters works without anyone labeling events by hand.

It uses reactions from **Transition1x** (Schreiner et al., *Scientific Data* 2022), a public
set of about 10,000 small-molecule reactions. Each reaction comes with reactant,
transition-state and product geometries. Comparing the reactant and product bond graphs gives
the true answer, so the benchmark can score:

- **The detector:** did it find the bonds that really formed and broke (precision, recall,
  F1)? Did it show each reaction as one chapter?
- **The category rules** (`src/chapterChemistry.ts`): did each chapter get the right
  reaction type? The report includes a confusion table.
- **Each local model:** how often did it dismiss a real reaction as an "artifact"? Does its
  label name the atoms that actually changed? How confident was it?

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

## First real run (200 reactions, Oct 2026)

| | Result |
|---|---|
| Bond-change recall / precision | 100% / 99.2% |
| Reactions found exactly | 98% |
| Reactions as a single chapter | 73.5% |
| Category accuracy, qwen2.5:7b / gemma2:9b | 5% / 32.5% |
| False-artifact rate, qwen2.5:7b / gemma2:9b | 13.5% / 2.0% |

What we changed in response:

- **Categories come from rules now, not the model.** The confusion tables showed the models
  mostly echoing whether a bond formed or broke, which they were shown as a hint. They also
  had no way to see rings, and scored 0% on ring changes. `chapterChemistry.ts` now computes
  the category from the local bond graph, using the same rules as the answer key. The model
  receives that category plus each atom's neighbors before and after, and only writes the
  label, the rationale and the artifact call.
- **Exchanges link in either order.** A bond forming first and the old one breaking later
  (associative substitution) used to split into two chapters. Opposite-direction changes on
  the same atom now link within `transferWindowFrames`.
- **Split diagnostics.** The report now shows how far apart split chapters are and whether
  they share atoms. That tells us whether the remaining splits are concerted changes on
  different atoms, or a frame-spacing effect of the interpolated path.

The category accuracy in the next run measures the rules, not a model. Since the rules
mirror the answer key, expect it to be high. Misses point to detector or grouping errors
(a split reaction leaves the main chapter with only part of the change), not to the rules.
