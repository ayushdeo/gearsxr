# GEARS XR: two extensions

This fork (`ayushdeo/gearsxr`) is a sandbox for showing what GEARS XR could become.
Nothing here goes to upstream. See "Keeping the fork separate" at the bottom.

---

## 1. Simulation Chapters: AI-flagged events on a timeline

**Pitch.** You load a trajectory and the viewer scans it, marking events like bond
formation or breakage, proton transfers, conformational flips, and phase changes. It
shows them as chapters on the frame slider. A scientist clicks a chapter, checks it in
3D or VR, and accepts, edits, or rejects it. Every correction is saved.

**What it produces.**
- A dataset of human-labeled trajectory events that other detectors can be benchmarked
  against. Labeled MD event data is scarce, so this is the publishable part.
- A human-in-the-loop event detector that gets better as people correct it.

**How it fits the current code.**
| Piece | Where it hooks in |
|---|---|
| Per-frame topology | `computeBonds` (`src/bonds.ts`) already runs on every frame. Diffing the bond sets between frames gives bond-change events for free. |
| Geometric signals | Per-atom RMSD and displacement, coordination numbers, and per-frame energy from the extended XYZ comment line (`Trajectory.comments`). |
| Timeline UI | Add markers to the frame slider driven by `Playback` (`src/playback.ts`). Clicking a marker seeks to that frame and highlights the atoms involved (reuse the `MeasurementTool` markers). |
| Correction UI | Accept / reject / relabel / move start-end, on desktop and through a VR controller ray (the raycast picking in `main.ts` already exists). |
| Shared review | `collaboration.ts` already syncs frame and playback. Add a `chapters` message so a whole room reviews the same events. |
| Storage | The Worker already uses R2 (`DROPS`). Store labels as JSON next to the trajectory hash. |

**Pipeline (cheap first, LLM last).**
1. **Deterministic detectors** in a Web Worker, the same pattern as `isosurfaceWorker.ts`.
   They cover bond-set diffs, coordination changes, and spikes in RMSD or energy, and they
   output candidate events with frame ranges and atom indices.
2. **Clustering and debouncing.** Bonds flicker near the cutoff, so merge events and
   require them to persist for N frames.
3. **LLM pass** through *your own* Worker route (for example `/chapters`, so the API key
   never reaches the browser). It gets the compact event list and nearby context, not raw
   coordinates. It names each chapter ("H transfer O12→O7"), groups related events,
   ranks them by interest, and writes a short summary.
4. **Human correction.** The edits are stored as `{trajectory_hash, event, label, action,
   annotator}`. That record is both the dataset and the feedback signal.

**Prior art to cite and differentiate from.** ChemTraYzer and reactive-MD reaction-network
extractors already detect reactions from bond orders. The new parts here are the
interactive, VR-capable review loop and the open human-labeled benchmark.

**MVP (about 1–2 weeks).** Bond-diff detector, timeline markers, accept/reject, and a
JSON export. No LLM needed for the first demo.

---

## 2. Touch & Talk: interactive MD with an agent that reasons over time

**Pitch.** Today GEARS XR only *plays back* trajectories. In Touch & Talk, the user grabs
an atom in VR and pulls. A machine-learned potential computes the forces live, the
simulation responds, and the user watches a bond stretch and break in real time. An AI
agent watches the whole session (not just the current frame) and coaches the user: "You
pulled that C–O bond 0.6 Å past equilibrium. The energy barrier was ~X eV. Notice the
H migrated first."

**Why VR is actually needed.** Pulling a specific atom along a 3D direction, at a chosen
rate, while watching the surroundings, is a spatial and haptic task. A mouse gives you two
degrees of freedom and VR gives you six. The pull path the user chose *is* the
experiment, and the agent's feedback is about that path.

**Architecture.**
```
Quest browser (GEARS XR)                 Your GPU box (cloud credits)
 ├─ grab atom i, controller pos ──WS──▶  sim server (Python)
 │                                        ├─ ASE + ML potential (MACE-MP-0 / ORB / UMA)
 │                                        ├─ Langevin MD, ~0.5 fs steps
 │                                        └─ adds spring force k·(target − x_i)
 ◀──── positions @ 30–60 Hz ──────────── stream frames (Float32, binary)
 │
 └─ event log ──────────────────────────▶ agent (Claude via your Worker or the sim server)
                                          reads: pull history, energies, bond events
                                          (same detectors as Chapters), speaks/labels in VR
```

**Hooks in the current code.**
- `VRObjectManipulator` (`src/vrInteraction.ts`) grabs the whole molecule. Add an
  "atom grab" mode that uses the existing atom raycast. While the trigger is held, send
  the controller position as the spring target for that atom.
- The renderer already consumes a `Trajectory` (a flat `Float32Array`). Make a "live"
  trajectory that grows as frames stream in, so playback, bonds, and measurements keep
  working unchanged.
- Run the jitter buffer from commit `8c9b256` on live frames as well.
- The bonds recomputed per frame from covalent radii already *show* breakage visually.

**Being honest about novelty.** Interactive MD in VR already exists: Narupa/NanoVer and
iMD-VR from the Glowacki group, and Nanome. The new parts here are:
1. *Reactive* ML potentials, which can break bonds (classical force fields can't), running
   in the **browser/WebXR** with no install.
2. An **agent that reasons over the time series** of the user's interaction, not a chatbot
   that only sees the current frame.
3. A link to Chapters. Every Touch & Talk session is a trajectory that Chapters can
   annotate, so users create labeled reactive events as they play.

**Latency budget.** For about 50–300 atoms, MACE or ORB on a single GPU does about 5–20 ms
per force call. If you run several MD steps per streamed frame, 30 Hz feels responsive.
Keep the systems small for the demo (for example ethanol + water, or a small peptide).

**MVP (about 2–3 weeks).** Python WebSocket sim server with ASE + an ML potential, atom grab
in VR, and streamed positions. Add the agent after the pull loop feels good.

---

## Suggested order

Build **Chapters first**. It runs fully in the browser on existing trajectories and needs no
GPU, and its event detectors are exactly what the Touch & Talk agent needs to "see" what
happened. Then Touch & Talk reuses them live.

**Where cloud credits go:**
- GPU instance for the sim server (Touch & Talk only).
- LLM calls for chapter naming and the agent.
- Your own Cloudflare Worker and R2 for rooms and labels (free tier is likely enough).

---

## Keeping the fork separate

Nothing in this fork uses the upstream project's resources. Development is local only until
we choose to ship our own production deployment.

- `origin` is `github.com/ayushdeo/gearsxr`. There is no `upstream` remote.
- **When opening a PR on GitHub, check the base repository.** GitHub defaults fork PRs to
  target the parent repo. Pick `ayushdeo/gearsxr`.
- Removed: upstream's Cloudflare Web Analytics beacon (it reported every page view to their
  account), the `gearsxr.space` CNAME, the demo URL on their hosted site, their origins in the
  Worker allow-list, and the hardcoded URL of their room server.
- The deploy workflow only runs by hand, only in `ayushdeo/gearsxr`, and only once the
  `COLLAB_WS_BASE` repo variable names our own Worker.
- The Worker and R2 bucket are renamed (`gearsxr-ayushdeo-room`, `gearsxr-ayushdeo-drops`) so
  a deploy can never overwrite upstream's, even from a shared Cloudflare login.
- Still contacted on purpose, as public third-party services rather than upstream's:
  the Materials Project OPTIMADE API, and the share-link hosts (Drive, Dropbox, OneDrive,
  GitHub), but only when you load from them.
