# Baselines: methane combustion (ReaxFF)

180 atoms, 50000 steps of 0.1 fs (5.0 ps), every 50 steps saved (1001 frames).
Written by tools/baselines/run_baselines.py. The tools define bonds differently (Chapters: covalent radii x 1.2;
ReaxFF: bond order >= 0.3), so this measures how far apart they are; explaining the gap is milestone 1.6.

## Molecule counts: Chapters vs fix reaxff/species

Share of molecules counted the same at each step: mean 85.7%, lowest 68.1% (1001 steps).

| Molecule | Total count difference over all steps |
|---|---|
| H | 4862 |
| CH4 | 4398 |
| CH3 | 4071 |
| CH2 | 376 |
| O2 | 85 |
| CH4O2 | 39 |
| HO2 | 32 |
| CH3O2 | 19 |
| CH | 7 |
| CH2O2 | 2 |

## Reactions: Chapters vs ReacNetGenerator

ReacNetGenerator lists a reaction as one species turning into another that shares atoms with it
("A -> B"), so each Chapters event is split the same way: CH4 + O2 -> CH3 + HO2 counts as
CH4 -> CH3, CH4 -> HO2 and O2 -> HO2.

Chapters found 18 events (6 distinct A -> B conversions);
ReacNetGenerator found 4 distinct conversions.
Of ReacNetGenerator's 4 most frequent conversions, Chapters found 3.

| ReacNetGenerator's top reactions | ReacNetGenerator count | Chapters count |
|---|---|---|
| O2 -> O2 | 6 | 0 |
| O2 -> HO2 | 1 | 1 |
| CH4 -> HO2 | 1 | 1 |
| CH4 -> CH3 | 1 | 4 |

| Chapters' top reactions | Chapters count | ReacNetGenerator count |
|---|---|---|
| CH4 -> CH3 | 4 | 1 |
| CH3 -> CH4 | 3 | 0 |
| CH4 -> HO2 | 1 | 1 |
| O2 -> HO2 | 1 | 1 |
| CH4 -> CH2 | 1 | 0 |
| CH4 -> H | 1 | 0 |

Chapters' events as whole equations:

| Equation | Events |
|---|---|
| CH4 -> CH4 | 7 |
| CH3 -> CH4 | 3 |
| CH3 + O2 -> CH3 + O2 | 3 |
| CH4 -> CH3 | 1 |
| CH4 + O2 -> CH3 + HO2 | 1 |
| CH4 -> CH2 | 1 |
| CH4 + O2 -> CH3 + O2 | 1 |
| CH4 -> CH3 + H | 1 |

Run times: LAMMPS 197 s, ReacNetGenerator 3 s, Chapters 0.5 s.
