// Simulation Chapters panel: runs bond-change detection on the loaded
// trajectory, lists the events, marks them on the playback timeline, and lets
// a scientist accept / reject / relabel each one and export the labels. An
// optional local LLM (Ollama) suggests names and flags likely artifacts.

import ChapterWorker from "./chapterWorker?worker&inline";
import { DEFAULT_DETECT_OPTIONS, type DetectOptions, type DetectedEvent } from "./chapterDetect";
import {
  buildExport,
  fingerprint,
  restoreReviews,
  saveReviews,
  toChapters,
  type Chapter,
  type ReviewStatus,
  type TrajectoryInfo,
} from "./chapterStore";
import { listModels, loadLlmSettings, saveLlmSettings, suggestChapterLabels, type LlmSettings } from "./chapterAI";
import type { ChapterCategory } from "./chapterChemistry";
import type { ChapterHighlight } from "./chapterHighlight";
import type { Trajectory } from "./xyzParser";

export interface ChaptersPanelOptions {
  panelEl: HTMLElement;
  toggleBtn: HTMLButtonElement;
  listEl: HTMLElement;
  summaryEl: HTMLElement;
  progressEl: HTMLElement;
  filterEl: HTMLElement;
  trackEl: HTMLElement;
  detectBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  persistInput: HTMLInputElement;
  aiBtn: HTMLButtonElement;
  aiEndpointInput: HTMLInputElement;
  aiModelSelect: HTMLSelectElement;
  aiRefreshBtn: HTMLButtonElement;
  aiStatusEl: HTMLElement;
  aiProgressEl: HTMLElement;
  aiSettingsEl: HTMLDetailsElement;
  highlight: ChapterHighlight;
  /** Jump playback to a frame (and pause). */
  seek: (frame: number) => void;
  annotator: () => string;
}

type Filter = "all" | ReviewStatus;
type AiState = "idle" | "ready" | "busy" | "done" | "error";

const CATEGORY_NAME: Record<ChapterCategory, string> = {
  "h2-elimination": "H₂ elimination",
  "proton-transfer": "H transfer",
  "ring-change": "Ring change",
  "bond-formation": "Bond formation",
  "bond-cleavage": "Bond cleavage",
  "ligand-exchange": "Exchange",
  other: "Other",
};

const STATUS_NAME: Record<ReviewStatus, string> = { pending: "To review", accepted: "Accepted", rejected: "Rejected" };

// SF Symbols-style glyphs. Constant markup only; never built from data.
const GLYPH = {
  pending:
    '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="#ff9f0a" stroke-width="1.8"/></svg>',
  accepted:
    '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#30d158"/><path d="m5.4 9.2 2.4 2.4 4.8-5" fill="none" stroke="#00260b" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rejected:
    '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="rgba(255,69,58,0.9)"/><path d="m6.3 6.3 5.4 5.4m0-5.4-5.4 5.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  sparkle:
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4z"/></svg>',
  warning:
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.2 15.3 14H.7zM7.2 6v4.2h1.6V6zm0 5.4V13h1.6v-1.6z"/></svg>',
} as const;

const MAX_BOND_CHIPS = 10;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function glyph(name: keyof typeof GLYPH): HTMLElement {
  const span = el("span");
  span.innerHTML = GLYPH[name];
  return span.firstElementChild as HTMLElement;
}

function frameRange(chapter: Chapter) {
  return chapter.endFrame > chapter.startFrame
    ? `Frames ${chapter.startFrame}–${chapter.endFrame}`
    : `Frame ${chapter.startFrame}`;
}

export class ChaptersPanel {
  private opts: ChaptersPanelOptions;
  private trajectory: Trajectory | null = null;
  private info: TrajectoryInfo | null = null;
  private chapters: Chapter[] = [];
  private selectedIndex = -1;
  private filter: Filter = "all";
  private worker: Worker | null = null;
  private token = 0;
  private detectOptions: DetectOptions = { ...DEFAULT_DETECT_OPTIONS };
  private llm: LlmSettings = loadLlmSettings();
  private aiRun: AbortController | null = null;
  private modelsLoaded = false;
  private notice = "";

  constructor(opts: ChaptersPanelOptions) {
    this.opts = opts;
    opts.detectBtn.addEventListener("click", () => void this.detect());
    opts.exportBtn.addEventListener("click", () => this.exportLabels());
    opts.prevBtn.addEventListener("click", () => this.selectRelative(-1));
    opts.nextBtn.addEventListener("click", () => this.selectRelative(1));
    opts.toggleBtn.addEventListener("click", () => {
      const collapsed = opts.panelEl.classList.toggle("collapsed");
      opts.toggleBtn.setAttribute("aria-expanded", String(!collapsed));
      opts.toggleBtn.setAttribute("aria-label", collapsed ? "Expand Chapters" : "Collapse Chapters");
      opts.toggleBtn.title = collapsed ? "Expand" : "Collapse";
    });
    opts.filterEl.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]");
      if (!button) return;
      this.filter = button.dataset.filter as Filter;
      this.render();
    });
    opts.aiEndpointInput.value = this.llm.endpoint;
    opts.aiEndpointInput.addEventListener("change", () => {
      this.llm.endpoint = opts.aiEndpointInput.value.trim() || "http://localhost:11434";
      opts.aiEndpointInput.value = this.llm.endpoint;
      saveLlmSettings(this.llm);
      void this.refreshModels();
    });
    opts.aiModelSelect.addEventListener("change", () => {
      this.llm.model = opts.aiModelSelect.value;
      saveLlmSettings(this.llm);
      this.setAiStatus("ready", `Ready · ${this.llm.model}`);
    });
    opts.aiRefreshBtn.addEventListener("click", () => void this.refreshModels());
    opts.aiBtn.addEventListener("click", () => {
      if (this.aiRun) this.aiRun.abort();
      else void this.runAi();
    });
    opts.persistInput.value = String(this.detectOptions.minPersistFrames);
    opts.persistInput.addEventListener("change", () => {
      const value = Math.round(Number(opts.persistInput.value));
      this.detectOptions.minPersistFrames = Number.isFinite(value) ? Math.min(Math.max(value, 1), 100) : 3;
      opts.persistInput.value = String(this.detectOptions.minPersistFrames);
      void this.detect();
    });
    this.setAiStatus("idle", "Checking for local models…");
  }

  /** Called for every XYZ load. Multi-frame trajectories are scanned at once. */
  async setTrajectory(trajectory: Trajectory, file: Blob, name: string) {
    this.cancel();
    this.trajectory = trajectory;
    this.chapters = [];
    this.selectedIndex = -1;
    this.notice = "";
    this.opts.highlight.setTrajectory(trajectory);
    this.info = { name, sha256: null, sizeBytes: file.size, numFrames: trajectory.numFrames, numAtoms: trajectory.numAtoms };
    if (trajectory.numFrames < 2) {
      this.hide();
      return;
    }
    this.opts.panelEl.style.display = "block";
    if (!this.modelsLoaded) void this.refreshModels();
    this.render();
    const token = this.token;
    const sha256 = await fingerprint(file);
    if (token !== this.token || !this.info) return;
    this.info.sha256 = sha256;
    await this.detect();
  }

  hide() {
    this.cancel();
    this.trajectory = null;
    this.info = null;
    this.chapters = [];
    this.selectedIndex = -1;
    this.opts.highlight.setTrajectory(null);
    this.opts.panelEl.style.display = "none";
    this.opts.trackEl.replaceChildren();
  }

  onFrame(frame: number) {
    this.opts.highlight.setFrame(frame);
  }

  /** Review shortcuts; returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.trajectory || this.chapters.length === 0) return false;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    switch (e.key) {
      case "]":
        this.selectRelative(1);
        return true;
      case "[":
        this.selectRelative(-1);
        return true;
      case "a":
      case "A":
        this.review("accepted");
        return true;
      case "r":
      case "R":
        this.review("rejected");
        return true;
      case "u":
      case "U":
        this.review("pending");
        return true;
    }
    return false;
  }

  private cancel() {
    this.aiRun?.abort();
    this.token++;
    this.worker?.terminate();
    this.worker = null;
  }

  private async detect() {
    const trajectory = this.trajectory;
    const info = this.info;
    if (!trajectory || !info) return;
    this.cancel();
    const token = this.token;
    this.opts.detectBtn.disabled = true;
    this.opts.summaryEl.textContent = "Scanning for bond changes…";

    let events: DetectedEvent[];
    try {
      events = await this.runWorker(trajectory, token);
    } catch (err) {
      if (token !== this.token) return;
      this.opts.summaryEl.textContent = `Detection failed: ${(err as Error).message}`;
      this.opts.detectBtn.disabled = false;
      return;
    }
    if (token !== this.token) return;
    this.worker?.terminate();
    this.worker = null;

    this.chapters = toChapters(events);
    const restored = restoreReviews(info, this.chapters);
    this.selectedIndex = -1;
    this.opts.highlight.show(null);
    this.opts.detectBtn.disabled = false;
    this.notice = restored > 0 ? `Restored ${restored} saved review${restored === 1 ? "" : "s"}.` : "";
    this.render();
  }

  private runWorker(trajectory: Trajectory, token: number): Promise<DetectedEvent[]> {
    return new Promise((resolve, reject) => {
      const worker = new ChapterWorker();
      this.worker = worker;
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.token !== token) return;
        if (msg.type === "progress") {
          const pct = Math.round((msg.framesDone / msg.totalFrames) * 100);
          this.opts.summaryEl.textContent = `Scanning for bond changes… ${pct}%`;
        } else if (msg.type === "result") {
          resolve(msg.events);
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (event) => reject(new Error(event.message || "worker error"));
      // Structured clone copies the trajectory; the main thread keeps its own.
      worker.postMessage({ type: "detect", token, trajectory, options: this.detectOptions });
    });
  }

  // --- AI assistant --------------------------------------------------------

  private setAiStatus(state: AiState, text: string) {
    const { aiStatusEl, aiBtn, aiProgressEl } = this.opts;
    aiStatusEl.dataset.state = state;
    aiStatusEl.textContent = text;
    aiStatusEl.title = text;
    const busy = state === "busy";
    aiBtn.textContent = busy ? "Stop" : this.chapters.some((c) => c.ai) ? "Rename" : "Name events";
    aiBtn.classList.toggle("stop", busy);
    aiBtn.setAttribute("aria-label", busy ? "Stop naming events" : "Name events with the local model");
    aiProgressEl.hidden = !busy;
    if (!busy) (aiProgressEl.firstElementChild as HTMLElement).style.width = "0";
  }

  private async refreshModels() {
    const { aiModelSelect } = this.opts;
    this.setAiStatus("idle", "Checking for local models…");
    let models: string[];
    try {
      models = await listModels(this.llm.endpoint, AbortSignal.timeout(5000));
    } catch {
      this.setAiStatus("error", "Ollama isn't running. Start it, then tap Refresh.");
      this.opts.aiSettingsEl.open = true;
      return;
    }
    this.modelsLoaded = true;
    aiModelSelect.replaceChildren(
      ...models.map((name) => {
        const option = document.createElement("option");
        option.value = option.textContent = name;
        return option;
      }),
    );
    if (!models.includes(this.llm.model)) {
      // Prefer models that follow a JSON schema well, in this order.
      const preferred = [/qwen2\.5/, /gemma/, /llama3/].map((re) => models.find((m) => re.test(m))).find(Boolean);
      this.llm.model = preferred ?? models[0] ?? "";
      saveLlmSettings(this.llm);
    }
    aiModelSelect.value = this.llm.model;
    if (models.length) {
      this.setAiStatus("ready", `Ready · ${this.llm.model}`);
    } else {
      this.setAiStatus("error", "No models installed. Run: ollama pull gemma2:9b");
      this.opts.aiSettingsEl.open = true;
    }
  }

  private async runAi() {
    const trajectory = this.trajectory;
    if (!trajectory || this.chapters.length === 0) return;
    const run = new AbortController();
    this.aiRun = run;
    const chapters = this.chapters;
    const bar = this.opts.aiProgressEl.firstElementChild as HTMLElement;
    this.setAiStatus("busy", `Naming ${chapters.length} event${chapters.length === 1 ? "" : "s"} with ${this.llm.model}…`);
    const started = performance.now();
    try {
      const named = await suggestChapterLabels(
        this.llm,
        trajectory,
        chapters,
        (done, total) => {
          if (run.signal.aborted || chapters !== this.chapters) return;
          this.setAiStatus("busy", `Naming ${done} of ${total}…`);
          bar.style.width = `${(100 * done) / total}%`;
          this.persist();
          this.render();
        },
        run.signal,
      );
      const seconds = Math.round((performance.now() - started) / 1000);
      if (this.aiRun === run) this.aiRun = null;
      this.setAiStatus("done", `Named ${named} of ${chapters.length} in ${seconds}s · ${this.llm.model}`);
    } catch (err) {
      if (this.aiRun === run) this.aiRun = null;
      if (run.signal.aborted) this.setAiStatus("ready", "Stopped. Suggestions so far are kept.");
      else this.setAiStatus("error", (err as Error).message);
    } finally {
      if (this.aiRun === run) this.aiRun = null;
      if (chapters === this.chapters) {
        this.persist();
        this.render();
      }
    }
  }

  // --- Review --------------------------------------------------------------

  private visibleIndices(): number[] {
    return this.chapters.map((_, i) => i).filter((i) => this.filter === "all" || this.chapters[i].status === this.filter);
  }

  private select(index: number) {
    if (index < 0 || index >= this.chapters.length) return;
    this.selectedIndex = index;
    const chapter = this.chapters[index];
    // Keep the selection visible: drop a filter that would hide it.
    if (this.filter !== "all" && chapter.status !== this.filter) this.filter = "all";
    this.opts.highlight.show(chapter);
    this.opts.seek(chapter.startFrame);
    this.render();
    this.opts.listEl.querySelector(".chRow.selected")?.scrollIntoView({ block: "nearest" });
  }

  private selectRelative(step: number) {
    const visible = this.visibleIndices();
    if (visible.length === 0) return;
    const at = visible.indexOf(this.selectedIndex);
    const next = at < 0 ? (step > 0 ? 0 : visible.length - 1) : Math.min(Math.max(at + step, 0), visible.length - 1);
    this.select(visible[next]);
  }

  private review(status: ReviewStatus) {
    const chapter = this.chapters[this.selectedIndex];
    if (!chapter) return;
    chapter.status = status;
    chapter.reviewedAt = status === "pending" ? null : new Date().toISOString();
    this.persist();
    // Accepting or rejecting moves on to the next unreviewed chapter.
    if (status !== "pending") {
      const next = this.chapters.findIndex((c, i) => i > this.selectedIndex && c.status === "pending");
      if (next >= 0) {
        this.select(next);
        return;
      }
    }
    this.render();
  }

  private persist() {
    if (this.info) saveReviews(this.info, this.chapters);
  }

  private exportLabels() {
    if (!this.info || this.chapters.length === 0) return;
    const doc = buildExport(this.info, this.detectOptions, this.chapters, this.opts.annotator());
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${this.info.name.replace(/\.[^.]+$/, "") || "trajectory"}.chapters.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // --- Rendering -----------------------------------------------------------

  private render() {
    this.renderSummary();
    this.renderFilter();
    this.renderTrack();
    this.renderList();
    const empty = this.chapters.length === 0;
    this.opts.exportBtn.disabled = empty;
    this.opts.aiBtn.disabled = empty && !this.aiRun;
    this.opts.prevBtn.disabled = empty;
    this.opts.nextBtn.disabled = empty;
  }

  private counts() {
    const counts: Record<ReviewStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
    for (const c of this.chapters) counts[c.status]++;
    return counts;
  }

  private renderSummary() {
    if (!this.trajectory) return;
    const counts = this.counts();
    const n = this.chapters.length;
    const reviewed = counts.accepted + counts.rejected;
    const base =
      n === 0
        ? "No bond changes found"
        : counts.pending === 0
          ? `All ${n} event${n === 1 ? "" : "s"} reviewed`
          : `${n} event${n === 1 ? "" : "s"} · ${reviewed} reviewed · ${counts.pending} to go`;
    this.opts.summaryEl.textContent = this.notice ? `${base}\n${this.notice}` : base;

    const [acc, rej] = Array.from(this.opts.progressEl.children) as HTMLElement[];
    acc.style.width = n ? `${(100 * counts.accepted) / n}%` : "0";
    rej.style.width = n ? `${(100 * counts.rejected) / n}%` : "0";
    this.opts.progressEl.setAttribute("aria-label", `${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.pending} to review`);
    this.opts.progressEl.hidden = n === 0;
  }

  private renderFilter() {
    const counts = this.counts();
    for (const button of Array.from(this.opts.filterEl.querySelectorAll<HTMLButtonElement>("button[data-filter]"))) {
      const filter = button.dataset.filter as Filter;
      button.setAttribute("aria-pressed", String(filter === this.filter));
      const n = filter === "all" ? this.chapters.length : counts[filter];
      const name = filter === "all" ? "All" : STATUS_NAME[filter];
      button.replaceChildren(name, el("span", "count", String(n)));
      button.setAttribute("aria-label", `${name}, ${n}`);
    }
  }

  private renderTrack() {
    const track = this.opts.trackEl;
    track.replaceChildren();
    const trajectory = this.trajectory;
    if (!trajectory) return;
    const lastFrame = Math.max(trajectory.numFrames - 1, 1);
    this.chapters.forEach((chapter, index) => {
      const marker = el("button", `chapterMarker ${chapter.status}${index === this.selectedIndex ? " selected" : ""}`);
      marker.type = "button";
      // Matches the range input's thumb inset so markers line up with frames.
      marker.style.left = `calc(8px + (100% - 16px) * ${chapter.startFrame / lastFrame})`;
      marker.title = `${frameRange(chapter)}: ${displayLabel(chapter)} (${STATUS_NAME[chapter.status]})`;
      marker.setAttribute("aria-label", marker.title);
      marker.addEventListener("click", () => this.select(index));
      track.append(marker);
    });
  }

  private renderList() {
    const list = this.opts.listEl;
    list.replaceChildren();
    if (!this.trajectory) return;
    if (this.chapters.length === 0) {
      list.append(el("div", "chEmpty", "No bond changes were found. Try a shorter duration under Detection settings."));
      return;
    }
    const visible = this.visibleIndices();
    if (visible.length === 0) {
      list.append(el("div", "chEmpty", `No ${STATUS_NAME[this.filter as ReviewStatus].toLowerCase()} events.`));
      return;
    }
    for (const index of visible) list.append(this.renderRow(this.chapters[index], index));
  }

  private renderRow(chapter: Chapter, index: number): HTMLElement {
    const selected = index === this.selectedIndex;
    const row = el("div", `chRow ${chapter.status}${selected ? " selected" : ""}`);
    row.setAttribute("role", "listitem");

    const head = el("button", "chRowHead");
    head.type = "button";
    head.setAttribute("aria-expanded", String(selected));
    head.addEventListener("click", () => {
      if (selected) {
        this.selectedIndex = -1;
        this.opts.highlight.show(null);
        this.render();
      } else {
        this.select(index);
      }
    });

    const status = el("span", "statusGlyph");
    status.append(glyph(chapter.status));
    status.setAttribute("aria-label", STATUS_NAME[chapter.status]);
    status.setAttribute("role", "img");

    const text = el("span", "chRowText");
    const title = el("span", "chRowTitle");
    if (!chapter.humanLabel && chapter.ai) {
      const mark = el("span", "aiMark");
      mark.append(glyph("sparkle"));
      mark.title = `Suggested by ${chapter.ai.model}`;
      title.append(mark);
    }
    title.append(displayLabel(chapter));

    const meta = el("span", "chRowMeta");
    meta.append(el("span", "pill", CATEGORY_NAME[chapter.category] ?? chapter.category), el("span", "frames", frameRange(chapter)));
    if (chapter.ai?.artifact) {
      const warn = el("span", "pill warn");
      warn.append(glyph("warning"), "Possible artifact");
      meta.append(warn);
    }
    text.append(title, meta);
    head.append(status, text);
    row.append(head);
    if (selected) row.append(this.renderDetail(chapter));
    return row;
  }

  private atomName(chapter: Chapter, atom: number): string {
    const t = this.trajectory;
    const symbol = t ? (t.frameSymbols[chapter.startFrame * t.numAtoms + atom] ?? t.symbols[atom]) : "";
    return `${symbol ?? ""}${atom}`;
  }

  private renderDetail(chapter: Chapter): HTMLElement {
    const detail = el("div", "chDetail");

    // AI suggestion first: it's what the reviewer is judging.
    const ai = chapter.ai;
    if (ai) {
      const box = el("div", "aiSuggestion");
      const src = el("div", "src");
      src.append(glyph("sparkle"), `Suggested by ${ai.model}`);
      box.append(src, el("div", "text", ai.label));
      if (ai.rationale) box.append(el("div", "why", ai.rationale));
      if (ai.artifact) {
        const warn = el("span", "pill warn");
        warn.append(glyph("warning"), "The model thinks this may not be real chemistry");
        box.append(warn);
      }
      if (chapter.humanLabel !== ai.label) {
        const use = el("button", "btn tinted", "Use this name");
        use.type = "button";
        use.addEventListener("click", () => {
          chapter.humanLabel = ai.label;
          this.persist();
          this.render();
        });
        box.append(use);
      }
      detail.append(box);
    }

    // What changed, as readable bond chips.
    const changes = el("div", "chSection");
    changes.append(el("div", "chSectionTitle", "What changed"));
    const chips = el("div", "bondChips");
    const bonds = [
      ...chapter.formed.map((p) => ({ pair: p, formed: true })),
      ...chapter.broken.map((p) => ({ pair: p, formed: false })),
    ];
    for (const { pair, formed } of bonds.slice(0, MAX_BOND_CHIPS)) {
      const chip = el("span", `bond ${formed ? "formed" : "broken"}`, `${formed ? "+" : "−"} ${this.atomName(chapter, pair[0])}–${this.atomName(chapter, pair[1])}`);
      chip.title = formed ? "Bond formed" : "Bond broken";
      chips.append(chip);
    }
    if (bonds.length > MAX_BOND_CHIPS) chips.append(el("span", "bond more", `+${bonds.length - MAX_BOND_CHIPS} more`));
    changes.append(chips, el("div", "detectorLine", `Detector: ${chapter.label} · ${CATEGORY_NAME[chapter.category] ?? chapter.category}`));
    detail.append(changes);

    // The reviewer's own words.
    const yours = el("div", "chSection");
    const labelId = `chLabel-${index(chapter)}`;
    const labelTitle = el("label", "chSectionTitle", "Your name for it");
    labelTitle.htmlFor = labelId;
    const label = el("input");
    label.id = labelId;
    label.type = "text";
    label.placeholder = ai?.label ?? chapter.label;
    label.value = chapter.humanLabel ?? "";
    label.addEventListener("change", () => {
      chapter.humanLabel = label.value.trim() || null;
      this.persist();
      this.render();
    });
    const note = el("textarea");
    note.placeholder = "Note (optional)";
    note.setAttribute("aria-label", "Note");
    note.rows = 1;
    note.value = chapter.note;
    note.addEventListener("change", () => {
      chapter.note = note.value;
      this.persist();
    });
    yours.append(labelTitle, label, note);
    detail.append(yours);

    // Decision.
    const bar = el("div", "reviewBar");
    const decide = (text: string, key: string, status: ReviewStatus, className: string) => {
      const button = el("button", `btn ${className}${chapter.status === status ? " on" : ""}`);
      button.type = "button";
      const hint = el("kbd", undefined, key);
      hint.setAttribute("aria-hidden", "true");
      button.append(text, hint);
      button.setAttribute("aria-label", text);
      button.setAttribute("aria-keyshortcuts", key);
      button.setAttribute("aria-pressed", String(chapter.status === status));
      button.addEventListener("click", () => this.review(status));
      return button;
    };
    bar.append(decide("Accept", "A", "accepted", "accept"), decide("Reject", "R", "rejected", "reject"));
    if (chapter.status !== "pending") {
      const undo = el("button", "btn plain undo", `Mark as not reviewed`);
      undo.type = "button";
      undo.addEventListener("click", () => this.review("pending"));
      bar.append(undo);
    }
    detail.append(bar);
    return detail;
  }
}

function index(chapter: Chapter): string {
  return chapter.id.replace(/[^a-z0-9]/gi, "_");
}

/** Human label wins, then the AI suggestion, then the detector's label. */
function displayLabel(chapter: Chapter): string {
  return chapter.humanLabel ?? chapter.ai?.label ?? chapter.label;
}
