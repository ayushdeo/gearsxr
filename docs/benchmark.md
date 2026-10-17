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

## Second run (same 200 reactions, detector + rules)

| | First run | Second run |
|---|---|---|
| Bond-change recall / precision | 100% / 99.2% | **100% / 100%** |
| Reactions found exactly | 98% | **100%** |
| Reactions as a single chapter | 73.5% | **98%** |
| Category accuracy | 5% / 32.5% (models) | **99%** (rules) |

What the inputs showed, and what changed:

- **The answer key missed H₂ eliminations.** The 10 "bond-cleavage" reactions were really
  two H atoms leaving and bonding to each other. The H–H bond (0.74 Å) fell in the key's
  ambiguous band, and a converter bug skipped pairs moving from unbonded into that band.
  Fixed: H–H pairs use 0.80 / 1.00 Å bounds, any change into or out of the band counts as
  ambiguous, and there's a new `h2-elimination` category (14 reactions). `--rekey` rebuilds
  `answers.json` from the `.xyz` files, so this didn't need the dataset again.
- **The viewer never drew H₂ properly.** The generic rule (1.2 × radius sum = 0.744 Å) sits
  exactly at H₂'s bond length. `bonds.ts` now uses a fixed 0.85 Å H–H cutoff. This affects
  the 3D view too.
- **Concerted changes on neighboring atoms split.** Split chapters were almost always one
  bond apart, not sharing an atom. Changes on bonded neighbors now link within the group
  window, now 10 frames (sweep: 5 → 92.5%, 8 → 95.5%, 10 → 98%, 15 → 98.5% single
  chapter).
- **Over-merging check.** The benchmark has one reaction per file, so it rewards merging.
  So we also built 180 files with two different reactions on molecules 3 Å apart, at several
  time offsets. At windows of 5, 10 and 15 frames, no chapter mixed the two molecules,
  because linking follows bonds, not distance.
- **"O0 swaps H7 for H7"** is now labeled as a transient break and re-form.

Still open:

- 4 reactions still split. Their changes are two bonds apart and 6–14 frames apart in time.
- In a fully bonded network such as a crystal, every bond change counts as a ring change,
  and the generic distance rule bonds metal pairs like Ca–Ca. The rules are validated on
  small gas-phase molecules. Solids need their own bonding rules.

## Third run: models with bonding context (Oct 2026)

With the rule category and each atom's neighbors in the prompt:

| | gemma2:9b | qwen2.5:7b |
|---|---|---|
| False-artifact rate (was 2.0% / 13.5%) | 0% | 0% |
| Atoms named in label (was 84.1% / 80.5%) | 91.0% | 84.3% |
| **Labels fully correct** (new check, scored offline from this run) | **96.7%** (147/152) | 77.0% (147/191) |
| Ligand exchanges described correctly | 20/21 | 7/36 |
| Seconds per reaction | 15.9 | 5.5 |

- "Atoms named" was too generous. A label can name the right atoms in the wrong roles.
  `tools/benchmark/claims.ts` now reads each label's claims ("X moves from A to B",
  "A-B breaks", "X binds to Y", "X swaps A for B", "X and Y form H2") and checks every one
  against the answer key. gemma is clearly more accurate. qwen mostly fails on exchanges,
  writing "X swaps A for B" with the wrong atoms; that wording came from an example in
  the prompt.
- Changes: the prompt now includes the detector's own summary, which names the exact roles
  for single transfers and swaps. The copyable example is gone, and the model is told to
  claim only bonds that appear in the formed / broken lists.
- gemma's 9 errors were Ollama dropping the connection, not model failures. Requests now
  retry twice (after 2 s and 5 s) on a dropped connection or a 5xx.
- **Caveats.** The benchmark has no real artifacts, so a 0% false-artifact rate only shows
  the models don't dismiss real chemistry. It doesn't show they can spot an artifact; that
  needs decoy events. Confidence is ~0.95 on everything, so it says nothing yet.

## Fourth run: role summary in the prompt (Oct 2026)

The claim checker was widened (transfers written as "proton transfer from N1-H9 to C0",
"N6 accepts a proton from C1", "C0 transfers H7 to C1", swaps written as "exchanges bonding
partner from A to B", bond lists after "breaking"/"forming", ring paths skipped). It's now
covered by 27 test cases, and spot checks against the answer key confirmed the flagged
labels. Both runs were re-scored with it:

| | gemma2:9b run 3 | gemma2:9b run 4 | qwen2.5:7b run 3 | qwen2.5:7b run 4 |
|---|---|---|---|---|
| Labels fully correct | 90.2% (166/184) | 87.3% (110/126) | 76.8% (149/194) | 86.9% (133/153) |
| Labels with a false claim | 18 | 16 | 45 | 20 |
| Vague (no atom names) | 0 | 0 | 0 | 16 |
| Ligand exchanges correct | 25/33 | 18/18 | 7/36 | 24/28 |
| Errors | 9 | 72 | 0 | 0 |

On the 123 reactions gemma labeled in both runs, it was correct 104 → 106 times and wrong
14 → 15 times, so the prompt change made no difference to gemma. qwen's false claims more
than halved, mostly on exchanges, but it got vaguer: 47 labels had nothing checkable, up
from 6.

Why gemma had 72 errors and took 51 s per reaction: the evaluator alternated models on every
reaction. On an 8 GB GPU the two models don't fit together, so Ollama reloaded one on every
call and some requests passed the 120 s limit. The retry inherited the already-expired
timer, so it couldn't help, and the error wrongly said "Can't reach Ollama".

Fixes:
- `npm run bench` now runs each model over every reaction before starting the next.
- Each attempt gets its own time limit, and a timeout says so.
- The prompt requires atom names (H7, C2) rather than "hydrogen" or "nitrogen".
- The report has a "Vague" column.

## Fifth run: models one at a time (Oct 2026)

| | gemma2:9b | qwen2.5:7b |
|---|---|---|
| Labels fully correct | 85.8% (139/162) | 77.3% (102/132) |
| Labels with a false claim | 23 | 30 |
| Vague (no atom names) | 0 | 33 |
| Errors | 31 (timeouts) | 0 |
| Seconds / reaction | 125.8 | 1.9 |

On the 163 reactions gemma labeled in both run 3 and this run, it was correct 140 vs 134 times.
That's within run-to-run noise at temperature 0.2, so gemma is steady at roughly 86–90%.

What the timings showed: a normal gemma request took about 8 s, but some hung until the
120 s limit. 128 s means one hang and a retry, 253 s two, and 367 s three, which became an
error. With a JSON schema, gemma2 on Ollama can keep emitting whitespace with nothing to
stop it. qwen ignored the new "name atoms" instruction and got vaguer: 33 labels such as
"Nitrogen gains hydrogen, loses carbon bond".

Fixes in the model client (`src/chapterAI.ts`):

- Output is capped at `num_predict` = 64 + 160 tokens per event. An answer that hits the cap,
  or isn't valid JSON, is retried, so it doesn't hang.
- Suggestions must be grounded. A label has to name at least one atom that changed, and only
  atoms in the event or bonded to it. Others are dropped and counted; the report's column is
  "Dropped as ungrounded".
- A failed batch no longer ends a run. Three failures in a row stop it, keeping what was
  named. The panel reports how many requests failed and why.

## Sixth run: bounded output (Oct 2026)

| | gemma2:9b | qwen2.5:7b |
|---|---|---|
| Labels fully correct | 85.6% (119/139) | 77.6% (90/116) |
| Dropped as ungrounded | 8 | 42 |
| Errors | 46 | 0 |
| Seconds / reaction | 19.2 (was 125.8) | 1.9 |

The output cap ended the 2-minute hangs, and gemma's median request is now 18 s. All 46 of its
errors are the same: three attempts, each hitting the cap (224 tokens for one event, when an
answer needs about 80). So gemma isn't being verbose. Schema-constrained decoding lets it
emit whitespace indefinitely, and the same request reproduces the loop.

Fix (`src/chapterAI.ts`):
- Once a reply is cut off, the rest of the run uses plain decoding. The prompt states the
  JSON shape, and the reply is parsed leniently: code fences are tolerated, and complete
  suggestion objects are recovered from a reply that stopped part-way.
- If a cut-off reply still recovered some suggestions, the missing ones are requested again
  without the schema, and the more complete answer is kept.

Accuracy is unchanged at about 86% for gemma and 78% for qwen. qwen's 42 drops are labels
with no atom names.

## Seventh run: no errors, and a self-check (Oct 2026)

| | gemma2:9b | qwen2.5:7b |
|---|---|---|
| Errors | 0 (was 46) | 0 |
| Seconds / reaction | 3.9 (was 19.2) | 1.9 |
| Reactions with a suggestion | 192 | 177 |
| Labels fully correct | 83.7% (144/172) | 77.2% (112/145) |
| Dropped as ungrounded | 8 | 23 |

Switching to plain decoding after a loop removed every error. On the 144 reactions gemma
labeled in both run 6 and this one, it was correct 117 vs 112 times and wrong 20 vs 21 times,
so accuracy didn't change; the plain-decoded labels are just longer.

The remaining wrong labels follow two patterns. One is an H transfer described in reverse
("N0 transfers H7 to C2" when H7 moved from C2 to N0). The other is an extra bond invented in
multi-bond events ("breaking O0-C1 and C1-C5" when C1-C5 never changed). Both contradict the
detector's own evidence, so the viewer now checks them.

**Self-check.** The claim checker moved into the app (`src/chapterClaims.ts`). Each
suggestion's claims are checked against the event's detected bond changes. A contradiction is
flagged in the list and in the inspector, for example "Si3–Ca58 breaks (evidence: formed)".
Flagged suggestions stay visible rather than being removed. Applied offline to this run's
labels:

| | gemma2:9b | qwen2.5:7b |
|---|---|---|
| Flagged | 23, all really wrong | 29, all really wrong |
| Wrong labels caught | 23 of 28 | 29 of 33 |
| Fully correct among unflagged | **96.6%** | **96.6%** |

On this benchmark the detector's evidence equals the answer key, so the check is as good as
it can be. On real simulations it's only as reliable as the detector.

`npm run bench` now reports this as "Self-check against the detector's evidence".

## Note before the next run: H₂ names were being dropped

The grounding filter read "H2" in "H6 and H8 form H2" as an atom named H2. That atom wasn't in
the event, so every correct H₂-elimination name was discarded as ungrounded. That explains
gemma's low H₂ counts (3 of 6 checkable in run 7). Molecule formulas (H2, O2, N2, …) that
aren't atom names in the event are now ignored by the filter. The detector's own names are
also in plain language now ("H11 moves from C4 to O0", "12 bonds change around Si9: 9 form,
3 break"), and all 166 checkable ones agree with their bonds under the claim checker.
