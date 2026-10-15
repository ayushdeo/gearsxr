# Chapters benchmark

200 reactions · detector bond-diff (persist 3 frames)

## Detector

| Metric | Value |
|---|---|
| Bond-change precision | 99.2% (528 of 532 detected) |
| Bond-change recall | 100.0% (528 of 528 true) |
| F1 | 99.6% |
| Reactions found exactly | 98.0% |
| Reactions as a single chapter | 73.5% |
| Mean chapters per reaction | 1.28 |

## Models

Category is scored on the chapter that best matches the true reaction. A false artifact is a real event the model dismissed.

| Model | Category accuracy | False-artifact rate | Atoms named in label | Errors | Seconds / reaction |
|---|---|---|---|---|---|
| qwen2.5:7b | 5.0% | 13.5% | 80.5% | 0 | 6.4 |
| gemma2:9b | 32.5% | 2.0% | 84.1% | 0 | 11.7 |

### Category accuracy by true category

| True category | n | qwen2.5:7b | gemma2:9b |
|---|---|---|---|
| bond-cleavage | 10 | 30.0% | 20.0% |
| ligand-exchange | 36 | 0.0% | 0.0% |
| other | 2 | 0.0% | 0.0% |
| proton-transfer | 119 | 5.9% | 52.9% |
| ring-change | 33 | 0.0% | 0.0% |
