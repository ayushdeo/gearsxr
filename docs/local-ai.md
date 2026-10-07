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

For each event it returns a short label, a category (for example `proton-transfer` or
`cutoff-artifact`), an "artifact" flag, a confidence and a one-line rationale. Ollama
enforces the response format with a JSON schema.

The model only **suggests**:
- Its label appears in the list in purple. Events it flags as likely artifacts are shown in
  amber with ⚠.
- It never accepts or rejects anything; that's still you (**A** / **R**).
- **Use AI label** copies its suggestion into your label.
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
