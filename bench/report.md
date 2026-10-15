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

Labels are scored on the chapter that best matches the true reaction. A false artifact is a real event the model dismissed.

| Model | False-artifact rate | Atoms named in label | Mean confidence | Errors | Seconds / reaction |
|---|---|---|---|---|---|
| gemma2:9b | 0.0% | 91.0% | 0.95 | 9 | 15.9 |
| qwen2.5:7b | 0.0% | 84.3% | 0.97 | 0 | 5.5 |
