# Running Chapters with a local model (Ollama)

During beta, the AI step runs entirely on your own machine. The viewer in your browser
talks straight to Ollama at `http://localhost:11434`. There's no API key, no cost, and the
trajectory data never leaves your laptop.

## What the model does

The detector finds bond changes. When you click **✨ AI name**, the model receives a compact
description of each event, in batches of 6:
- the element and index of each atom involved
- bond distances just before and after the event
- the bonding cutoff
- the system's composition

Each event also carries its reaction category, computed from the bond graph by
`src/chapterChemistry.ts` rather than by the model, plus each atom's bonded neighbors before
and after. For each event the model returns a short label, an "artifact" flag, a confidence
and a one-line rationale. Ollama enforces the response format with a JSON schema.

On the Transition1x benchmark, the models picked the right category only 5% (qwen2.5:7b) and
33% (gemma2:9b) of the time, so that job moved to rules (see [benchmark.md](benchmark.md)).

When Ollama is connected, names are suggested automatically for any event that doesn't
have one yet, once per loaded file. You can turn this off under **Model and connection**.

The model only **suggests**:
- **Model suggestions** in the Chapters panel shows the connection state: Connected, a
  request in progress (with Stop), Not connected, or the error Ollama returned. **Suggest
  names** sends every event; it reads **Retry connection** when Ollama isn't reachable. The
  model and Ollama address are under **Model and connection**, which opens by itself when
  something needs fixing.
- Each row says where its name came from: Detector name, Suggested name or Your name. Events
  the model doubts show **Possible artifact** with a warning icon, in the list and at the
  top of the inspector.
- Selecting an event jumps to it, turns the camera to its atoms and opens three numbered steps
  below the list:
  1. **What changed:** the detector's description and a table of the bonds that formed or
     broke, with distances (Å) before and after and the bonding cutoff for each pair.
     **Play this event** replays it slowly from just before to just after.
  2. **What the model suggests:** the model's name, its reasoning, the model, and its stated
     confidence. **Use suggested name** copies it into your field.
  3. **Your review:** an optional name and note, then **Accept** or **Reject** (**A** / **R**),
     and **Clear decision** (**U**).
- **Show** filters the list: all events, still to review, accepted or rejected.
- Pointing at any atom in the 3D view shows its name (e.g. "O0 Oxygen") and what it is bonded
  to in the current frame.
- Suggestions that name none of the event's atoms (e.g. "Nitrogen gains hydrogen"), or that
  name atoms outside the event and its bonded neighbors, are dropped. The status line says
  how many.
- Every suggestion is checked against the detected bond changes. If it claims something the
  evidence contradicts, the row says **Suggested name contradicts the evidence**, and the
  inspector shows what was claimed and what happened (e.g. "Si3–Ca58 breaks (evidence:
  formed)"). On the benchmark, unflagged suggestions were about 97% fully correct.
- The model never accepts or rejects anything; that's always you.
- Exports keep the detector label, the AI suggestion (with the model name) and your label
  side by side. So the dataset also measures how often each model agrees with a human.

## One-time setup

1. Install Ollama (0.5 or newer, needed for schema-constrained output) and pull a model:
   ```bash
   ollama pull qwen2.5:7b     # best at following the JSON schema; ~4.7 GB, fits a laptop 4070
   ollama pull gemma2:9b      # good second opinion
   ```
2. Get the code (your fork, not upstream):
   ```bash
   git clone https://github.com/ayushdeo/gearsxr
   cd gearsxr
   git checkout claude/gears-xr-project-ideas-gzowvl
   npm install
   ```

## Every session

```bash
ollama serve            # skip if the Ollama tray app is already running
npm run dev:http        # then open http://localhost:5174
```

Click **Load URL** to load the bundled demo, or drop in your own `.xyz`. Then open the
**✨ AI name** row in the Chapters panel, pick a model, and click it. The model list comes
from `ollama list`, and your choice is remembered.

`npm run dev` (https on port 5173) works too. Browsers treat `http://localhost` as secure,
so the https page can still reach Ollama.

## Troubleshooting

- **"Can't reach Ollama at …"** means Ollama isn't running, or the endpoint in the panel is
  wrong.
- **The page is opened from another device or a LAN IP** (for example a Quest headset).
  Ollama only accepts requests from localhost pages by default. Allow the page's origin, and
  listen on the network:
  ```bash
  # macOS / Linux
  OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS="http://<laptop-ip>:5174" ollama serve
  ```
  ```powershell
  # Windows: set once, then quit and restart the Ollama tray app
  setx OLLAMA_HOST 0.0.0.0
  setx OLLAMA_ORIGINS "http://<laptop-ip>:5174"
  ```
  Then set the panel's endpoint to `http://<laptop-ip>:11434`. An **https** page on a LAN IP
  can't call plain-http Ollama (the browser blocks mixed content). For now, run the AI pass
  in the laptop browser. Reviews are stored per browser, so the headset won't see them until
  room sync for chapters lands.
- **Labels are vague, or every event is flagged as an artifact.** Small models (2B) struggle;
  try `qwen2.5:7b`. Comparing models on the same file is itself a useful benchmark: export
  once per model.

## Later: the cloud model

The request is built in `src/chapterAI.ts`. Switching to a hosted model later means one new
function that calls your own Cloudflare Worker route, which holds the API key. The panel,
store and export format stay the same.
