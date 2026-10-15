# Chapters benchmark

200 reactions · detector bond-diff (persist 3 frames, group window 10 frames)

## Detector

| Metric | Value |
|---|---|
| Bond-change precision | 100.0% (542 of 542 detected) |
| Bond-change recall | 100.0% (542 of 542 true) |
| F1 | 100.0% |
| Reactions found exactly | 100.0% |
| Reactions as a single chapter | 98.0% |
| Mean chapters per reaction | 1.02 |
| Category accuracy (rules, main chapter) | 99.0% |

### Category confusion (rows: truth, columns: rules)

| Truth \ rules | n | h2-elimination | proton-transfer | ring-change | bond-cleavage | ligand-exchange | accuracy |
|---|---|---|---|---|---|---|---|
| h2-elimination | 14 | 14 | 0 | 0 | 0 | 0 | 100.0% |
| ligand-exchange | 36 | 0 | 0 | 0 | 0 | 36 | 100.0% |
| other | 2 | 0 | 0 | 0 | 2 | 0 | 0.0% |
| proton-transfer | 118 | 0 | 118 | 0 | 0 | 0 | 100.0% |
| ring-change | 30 | 0 | 0 | 30 | 0 | 0 | 100.0% |

### Split reactions

4 reactions became more than one chapter. Median gap between consecutive chapters: 9 frames (range -5–14). Chapters share an atom in 0.0% of them.

## Models

Labels are scored on the chapter that best matches the true reaction. A false artifact is a real event the model dismissed. "Labels fully correct" reads each label's claims (X moves from A to B, A-B breaks, X binds to Y, X swaps A for B, ...) and checks every one against the answer key; it covers labels with at least one recognizable claim.

| Model | Labels fully correct | Labels with a false claim | Checkable labels | False-artifact rate | Atoms named in label | Mean confidence | Errors | Seconds / reaction |
|---|---|---|---|---|---|---|---|---|
| gemma2:9b | 100.0% | 0 | 42 of 128 | 0.0% | 96.0% | 0.96 | 72 | 50.7 |
| qwen2.5:7b | 91.6% | 7 | 83 of 200 | 0.0% | 79.2% | 1.00 | 0 | 5.7 |

### Labels fully correct, by true category

| True category | gemma2:9b | qwen2.5:7b |
|---|---|---|
| h2-elimination | 1/1 | 5/7 |
| ligand-exchange | 3/3 | 24/26 |
| other | 0/0 | 2/2 |
| proton-transfer | 32/32 | 36/37 |
| ring-change | 6/6 | 9/11 |
