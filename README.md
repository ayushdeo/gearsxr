# GEARS XR

GEARS XR (Extended Reality) is a browser-based molecular dynamics trajectory viewer for extended XYZ files and LAMMPS dumps, with desktop controls and WebXR support for virtual reality headsets.

> **Fork notice.** This is `ayushdeo/gearsxr`, an independent fork used for local development of new
> features (see [docs/ideas.md](docs/ideas.md)). It uses none of the upstream project's hosted
> site, room server, storage, or analytics. Everything runs locally until this fork has its own
> production deployment.

- Tutorial: `public/tutorial.html` (served at `/tutorial.html` by the dev server)
- Simulation Chapters with a local AI model: [docs/local-ai.md](docs/local-ai.md)
- Known-answer benchmark for Chapters (no hand labeling): [docs/benchmark.md](docs/benchmark.md)
- Comparison with ReacNetGenerator and LAMMPS `fix reaxff/species`: [docs/baselines.md](docs/baselines.md)

![GEARS XR screenshot](docs/screenshot.png)

## Features

- Load extended XYZ trajectories and LAMMPS text dumps from a local file, drag-and-drop, or URL — including Google Drive, Dropbox, OneDrive, and GitHub share links.
- Periodic cells (extended-XYZ `Lattice`, LAMMPS box bounds, orthogonal or triclinic): bonds across cell walls are found and drawn, and atoms wrapping through a wall keep their bonds.
- Load crystal structures straight from the [Materials Project](https://next-gen.materialsproject.org/) by ID (e.g. `mp-149`) via its keyless OPTIMADE endpoint.
- Play multi-frame trajectories with a frame slider, step buttons, and FPS control.
- Color atoms by element and compute bonds per frame from covalent radii.
- Visualize a 3D isosurface of a scalar field (electron density, molecular orbitals) from a Gaussian Cube file, with an adjustable isovalue and signed ± lobes.
- Measure distances (2 atoms) and angles (3 atoms) on desktop and in VR.
- Choose bundled 360-degree VR backgrounds.
- Enter VR through WebXR; grab, move, and scale the molecule with controllers.
- Join a lightweight multiuser room that shares trajectory URL, frame, playback, and view state through a short room code.

## Quick Start

1. Run `npm run dev` and open the printed local URL. The URL field is prefilled with a validated example: four small-molecule reactions in one trajectory. More examples, including the tobermorite crystal, are in the **Examples** menu.
2. Click **Load URL**.
3. Click **Play** in the bottom-left playback panel.

Everything else — loading your own files, multiuser rooms, VR controls, measurements — is covered in the tutorial (`/tutorial.html`).

## File Format

The viewer reads standard XYZ and extended XYZ trajectory files:

```text
natoms
comment or Properties=...
Element x y z ...
Element x y z ...
```

For extended XYZ files, the parser reads `Properties=...` metadata to find species, position, and atom-ID columns. When atom IDs are present, each frame is reordered to the first frame's ID order so atom identity stays stable across the trajectory. Atom types are stored per frame, so color and bond-radius logic follow the current frame. When a frame has `Lattice="ax ay az bx by bz cx cy cz"` (and optionally `pbc="T T T"`), distances use the nearest periodic image. URL loads accept only `https://` links, and when the URL shows a file name it must end in `.xyz`, `.extxyz`, `.dump`, `.lammpstrj`, `.cube`, or `.cub`.

### LAMMPS dumps

Text dumps from `dump custom` or `dump atom` (`.dump`, `.lammpstrj`, or any file starting with `ITEM: TIMESTEP`). Positions are read from `x y z`, `xu yu zu`, `xs ys zs` or `xsu ysu zsu`; the box, orthogonal or triclinic, becomes the periodic cell. Atoms are kept in atom-ID order, so the dump needs an `id` column. Elements come from an `element` column (`dump_modify ... element Ca Si O H`); without one, the viewer asks once which element each atom type is (e.g. `1=Ca 2=Si 3=O 4=H`) and remembers the answer. The number of atoms must stay the same in every frame. For exact positions, write floats with more digits than LAMMPS's default six (`dump_modify ... format float %.10g`).

### Gaussian Cube (volumetric)

A `.cube` / `.cub` file carries both atom coordinates and a scalar field on a regular grid (electron density, a molecular orbital, electrostatic potential). GEARS XR renders the atoms plus a marching-cubes isosurface — a blue positive lobe and, in signed mode, a red negative lobe — with an adjustable isovalue and opacity. Bohr units (the cube default) are converted to Ångström; a negative voxel count is treated as Ångström. A cube is a single structure, so it loads without the playback timeline. Marching-cubes extraction runs in a Web Worker to keep the view responsive. Try the bundled sample at `samples/orbital.cube`. Note: very large cubes fetched through the room-server `/proxy` are still bounded by its size cap; direct URLs and local files use the larger 200 MB frontend limit.

## Development

```bash
npm install
npm run dev          # frontend dev server (https, for WebXR/Quest testing)
npm run dev:http     # frontend dev server over plain http
npm run build        # production build into dist/
npm run worker:dev   # room server (Cloudflare Worker) on :8787
npm run worker:deploy  # deploy the room server
npm test             # unit tests (claim checker, detector, periodic cells, LAMMPS dumps)
npm run bench -- bench/ --check   # detector benchmark against its published numbers
```

Every push to this fork runs the type check, `npm test` and the benchmark check in GitHub
Actions (`.github/workflows/ci.yml`).

Local only for now: `npm run dev` plus `npm run worker:dev` gives you the viewer and a local room
server on `ws://127.0.0.1:8787` with no remote services involved.

When this fork is ready for production, the GitHub Pages workflow is run by hand (Actions →
Deploy → Run workflow). It refuses to run until the `COLLAB_WS_BASE` repository variable holds
this fork's own Worker URL. The Worker (`gearsxr-ayushdeo-room`) and R2 bucket
(`gearsxr-ayushdeo-drops`) deploy to whichever Cloudflare account `wrangler` is logged in to;
add the production page's origin to `ALLOWED_ORIGINS` in `wrangler.toml` first.

The Worker also provides a `/proxy` route that fetches trajectories from known cloud-storage hosts when a provider blocks direct browser downloads (Google Drive usually does).

## Troubleshooting

Common issues (share-link permissions, room connection, VR support) are covered in the tutorial's help section (`/tutorial.html#troubleshooting`).

## License

MIT License. See [LICENSE](LICENSE).
