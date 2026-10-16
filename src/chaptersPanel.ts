// Simulation Chapters panel: runs bond-change detection on the loaded
// trajectory, lists the events, marks them on the playback timeline, and lets
// a scientist accept / reject / relabel each one and export the labels. An
// optional local LLM (Ollama) suggests names and flags likely artifacts.
//
// Layout follows the review workflow: select an event in the list, inspect
// its evidence, evaluate the model's suggestion, record a decision.

import ChapterWorker from "./chapterWorker?worker&inline";
import { DEFAULT_DETECT_OPTIONS, type BondPair, type DetectOptions, type DetectedEvent } from "./chapterDetect";
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
import { bracketFrames, type ChapterCategory } from "./chapterChemistry";
import type { ChapterHighlight } from "./chapterHighlight";
import type { Trajectory } from "./xyzParser";

export interface ChaptersPanelOptions {
  panelEl: HTMLElement;
  toggleBtn: HTMLButtonElement;
  listEl: HTMLElement;
  inspectorEl: HTMLElement;
  summaryEl: HTMLElement;
  progressEl: HTMLElement;
  progressTextEl: HTMLElement;
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
type AiState = "checking" | "ready" | "disconnected" | "busy" | "done" | "error";

const CATEGORY_NAME: Record<ChapterCategory, string> = {
  "h2-elimination": "H₂ elimination",
  "proton-transfer": "H transfer",
  "ring-change": "Ring change",
  "bond-formation": "Bond formation",
  "bond-cleavage": "Bond cleavage",
  "ligand-exchange": "Exchange",
  other: "Other",
};

const STATUS_NAME: Record<ReviewStatus, string> = { pending: "Not reviewed", accepted: "Accepted", rejected: "Rejected" };
const FILTER_NAME: Record<Filter, string> = { all: "All", pending: "To review", accepted: "Accepted", rejected: "Rejected" };

// Icons are fixed markup defined here, never built from data.
const ICON = {
  pending:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5"/></svg>',
  accepted:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#30d158"/><path d="m4.9 8.2 2.1 2.1 4.2-4.4" fill="none" stroke="#002a0d" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rejected:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#ff453a"/><path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  warning:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.3 15.2 14H.8zM7.25 6v4h1.5V6zm0 5.25v1.5h1.5v-1.5z"/></svg>',
  check:
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  spinner:
    '<svg class="spin" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" /></svg>',
} as const;

const BOND_ROWS = 8;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: keyof typeof ICON): Element {
  const holder = document.createElement("span");
  holder.innerHTML = ICON[name];
  return holder.firstElementChild!;
}

function frameRange(chapter: Chapter) {
  return chapter.endFrame > chapter.startFrame ? `Frames ${chapter.startFrame}–${chapter.endFrame}` : `Frame ${chapter.startFrame}`;
}

function clock(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/** Human label wins, then the model's suggestion, then the detector's label. */
function displayLabel(chapter: Chapter): string {
  return chapter.humanLabel ?? chapter.ai?.label ?? chapter.label;
}

function nameSource(chapter: Chapter): string {
  if (chapter.humanLabel) return "Your name";
  if (chapter.ai) return "Suggested name";
  return "Detector name";
}

export class ChaptersPanel {
  private opts: ChaptersPanelOptions;
  private trajectory: Trajectory | null = null;
  private info: TrajectoryInfo | null = null;
  private chapters: Chapter[] = [];
  private selectedIndex = -1;
  private filter: Filter = "all";
  private showAllBonds = false;
  private worker: Worker | null = null;
  private token = 0;
  private detectOptions: DetectOptions = { ...DEFAULT_DETECT_OPTIONS };
  private llm: LlmSettings = loadLlmSettings();
  private aiRun: AbortController | null = null;
  private aiState: AiState = "checking";
  private modelsLoaded = false;
  private scanning: number | null = null;
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
      this.setAiStatus("ready", `Connected · ${this.llm.model}`);
    });
    opts.aiRefreshBtn.addEventListener("click", () => void this.refreshModels());
    opts.aiBtn.addEventListener("click", () => {
      if (this.aiRun) this.aiRun.abort();
      else if (this.aiState === "disconnected" || this.aiState === "checking") void this.refreshModels();
      else void this.runAi();
    });
    opts.persistInput.value = String(this.detectOptions.minPersistFrames);
    opts.persistInput.addEventListener("change", () => {
      const value = Math.round(Number(opts.persistInput.value));
      this.detectOptions.minPersistFrames = Number.isFinite(value) ? Math.min(Math.max(value, 1), 100) : 3;
      opts.persistInput.value = String(this.detectOptions.minPersistFrames);
      void this.detect();
    });
    this.setAiStatus("checking", "Checking for a local model…");
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
    this.scanning = 0;
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
    this.scanning = 0;
    this.render();

    let events: DetectedEvent[];
    try {
      events = await this.runWorker(trajectory, token);
    } catch (err) {
      if (token !== this.token) return;
      this.scanning = null;
      this.opts.detectBtn.disabled = false;
      this.notice = `Detection failed: ${(err as Error).message}`;
      this.render();
      return;
    }
    if (token !== this.token) return;
    this.worker?.terminate();
    this.worker = null;
    this.scanning = null;

    this.chapters = toChapters(events);
    const restored = restoreReviews(info, this.chapters);
    this.selectedIndex = -1;
    this.opts.highlight.show(null);
    this.opts.detectBtn.disabled = false;
    this.notice = restored > 0 ? `Restored ${restored} saved review${restored === 1 ? "" : "s"}` : "";
    this.render();
    // Keep the assistant's button label in step with whether names exist.
    if (this.aiState === "ready" || this.aiState === "done") this.setAiStatus(this.aiState, this.opts.aiStatusEl.textContent ?? "");
  }

  private runWorker(trajectory: Trajectory, token: number): Promise<DetectedEvent[]> {
    return new Promise((resolve, reject) => {
      const worker = new ChapterWorker();
      this.worker = worker;
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.token !== token) return;
        if (msg.type === "progress") {
          this.scanning = Math.round((msg.framesDone / msg.totalFrames) * 100);
          this.renderSummary();
          this.renderList();
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

  // --- Model suggestions ---------------------------------------------------

  private setAiStatus(state: AiState, text: string) {
    const { aiStatusEl, aiBtn, aiProgressEl } = this.opts;
    this.aiState = state;
    aiStatusEl.dataset.state = state;
    const ico = el("span", "ico");
    if (state === "busy" || state === "checking") ico.append(icon("spinner"));
    else if (state === "error" || state === "disconnected") ico.append(icon("warning"));
    else if (state === "ready" || state === "done") ico.append(icon("check"));
    aiStatusEl.replaceChildren(ico, el("span", undefined, text));

    const busy = state === "busy";
    aiBtn.textContent = busy
      ? "Stop"
      : state === "disconnected"
        ? "Retry connection"
        : this.chapters.some((c) => c.ai)
          ? "Suggest again"
          : "Suggest names";
    aiBtn.disabled = state === "checking" || (!busy && state !== "disconnected" && this.chapters.length === 0);
    aiProgressEl.hidden = !busy;
    if (!busy) (aiProgressEl.firstElementChild as HTMLElement).style.width = "0";
  }

  private async refreshModels() {
    const { aiModelSelect } = this.opts;
    this.setAiStatus("checking", "Checking for a local model…");
    let models: string[];
    try {
      models = await listModels(this.llm.endpoint, AbortSignal.timeout(5000));
    } catch {
      const none = document.createElement("option");
      none.textContent = "No models found";
      none.value = "";
      aiModelSelect.replaceChildren(none);
      this.setAiStatus("disconnected", `Not connected. Ollama isn't answering at ${this.llm.endpoint}.`);
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
      this.setAiStatus("ready", `Connected · ${this.llm.model}`);
    } else {
      this.setAiStatus("disconnected", "Ollama is running but has no models. Install one with: ollama pull gemma2:9b");
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
    this.setAiStatus("busy", `Requesting names for ${chapters.length} event${chapters.length === 1 ? "" : "s"} from ${this.llm.model}…`);
    const started = performance.now();
    try {
      const result = await suggestChapterLabels(
        this.llm,
        trajectory,
        chapters,
        (done, total) => {
          if (run.signal.aborted || chapters !== this.chapters) return;
          this.setAiStatus("busy", `Received ${done} of ${total} from ${this.llm.model}…`);
          bar.style.width = `${(100 * done) / total}%`;
          this.persist();
          this.render();
        },
        run.signal,
      );
      if (this.aiRun === run) this.aiRun = null;
      const seconds = Math.round((performance.now() - started) / 1000);
      const notes: string[] = [];
      if (result.ungrounded) notes.push(`${result.ungrounded} discarded for not naming the event's atoms`);
      if (result.failedBatches) notes.push(`${result.failedBatches} request${result.failedBatches === 1 ? "" : "s"} failed: ${result.lastError?.message ?? ""}`);
      const summary = `${result.named} of ${chapters.length} named by ${this.llm.model} in ${seconds} s`;
      if (result.failedBatches) this.setAiStatus("error", `${summary}. ${notes.join("; ")}`);
      else this.setAiStatus("done", notes.length ? `${summary}. ${notes.join("; ")}.` : summary);
    } catch (err) {
      if (this.aiRun === run) this.aiRun = null;
      if (run.signal.aborted) this.setAiStatus("ready", "Stopped. Names received so far are kept.");
      else this.setAiStatus("error", `Suggestions failed: ${(err as Error).message}`);
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
    if (index !== this.selectedIndex) this.showAllBonds = false;
    this.selectedIndex = index;
    const chapter = this.chapters[index];
    // Keep the selection visible: drop a filter that would hide it.
    if (this.filter !== "all" && chapter.status !== this.filter) this.filter = "all";
    this.opts.highlight.show(chapter);
    this.opts.seek(chapter.startFrame);
    this.render();
    this.opts.listEl.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
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
    this.renderInspector();
    const empty = this.chapters.length === 0;
    this.opts.exportBtn.disabled = empty;
    this.opts.prevBtn.disabled = empty;
    this.opts.nextBtn.disabled = empty;
    if (!this.aiRun && this.aiState !== "checking" && this.aiState !== "disconnected") this.opts.aiBtn.disabled = empty;
  }

  private counts() {
    const counts: Record<ReviewStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
    for (const c of this.chapters) counts[c.status]++;
    return counts;
  }

  private renderSummary() {
    if (!this.trajectory || !this.info) return;
    const { summaryEl, progressEl, progressTextEl } = this.opts;
    const file = `${this.info.name} · ${this.info.numAtoms.toLocaleString()} atoms · ${this.info.numFrames} frames`;
    summaryEl.textContent = file;
    summaryEl.title = file;

    const n = this.chapters.length;
    const counts = this.counts();
    const [acc, rej] = Array.from(progressEl.children) as HTMLElement[];
    acc.style.width = n ? `${(100 * counts.accepted) / n}%` : "0";
    rej.style.width = n ? `${(100 * counts.rejected) / n}%` : "0";
    progressEl.setAttribute("aria-label", `${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.pending} not reviewed`);

    const parts: Array<string | Node> = [];
    if (this.scanning !== null) {
      parts.push(el("span", undefined, `Scanning for bond changes… ${this.scanning}%`));
    } else if (n === 0) {
      parts.push(el("span", undefined, "No bond changes found"));
    } else {
      parts.push(el("span", undefined, `${counts.accepted + counts.rejected} of ${n} reviewed`));
      const a = el("span");
      a.append(icon("accepted"), `${counts.accepted} accepted`);
      const r = el("span");
      r.append(icon("rejected"), `${counts.rejected} rejected`);
      parts.push(a, r);
    }
    if (this.notice) parts.push(el("span", undefined, this.notice));
    progressTextEl.replaceChildren(...parts);
    for (const svg of Array.from(progressTextEl.querySelectorAll("svg"))) {
      svg.setAttribute("width", "12");
      svg.setAttribute("height", "12");
    }
  }

  private renderFilter() {
    const counts = this.counts();
    for (const button of Array.from(this.opts.filterEl.querySelectorAll<HTMLButtonElement>("button[data-filter]"))) {
      const filter = button.dataset.filter as Filter;
      const n = filter === "all" ? this.chapters.length : counts[filter];
      button.setAttribute("aria-pressed", String(filter === this.filter));
      button.replaceChildren(FILTER_NAME[filter], el("span", "count", String(n)));
      button.setAttribute("aria-label", `${FILTER_NAME[filter]}, ${n}`);
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
    if (this.scanning !== null) {
      const row = el("div", "chEmpty");
      row.append(icon("spinner"), ` Scanning ${this.trajectory.numFrames} frames… ${this.scanning}%`);
      list.append(row);
      return;
    }
    if (this.chapters.length === 0) {
      list.append(el("div", "chEmpty", "No bond changes were found. Lower the minimum duration under Detection settings to search for shorter events."));
      return;
    }
    const visible = this.visibleIndices();
    if (visible.length === 0) {
      list.append(el("div", "chEmpty", `No ${FILTER_NAME[this.filter].toLowerCase()} events.`));
      return;
    }
    for (const index of visible) list.append(this.renderRow(this.chapters[index], index));
  }

  private renderRow(chapter: Chapter, index: number): HTMLElement {
    const row = el("div", `chRow ${chapter.status}`);
    row.setAttribute("role", "listitem");
    const head = el("button", "chRowHead");
    head.type = "button";
    if (index === this.selectedIndex) head.setAttribute("aria-current", "true");
    head.addEventListener("click", () => this.select(index));

    const status = el("span", "statusIcon");
    status.append(icon(chapter.status));
    status.setAttribute("role", "img");
    status.setAttribute("aria-label", STATUS_NAME[chapter.status]);

    const title = el("span", "chRowTitle", displayLabel(chapter));
    title.title = displayLabel(chapter);
    const meta = el("span", "chRowMeta", `${CATEGORY_NAME[chapter.category] ?? chapter.category} · ${frameRange(chapter)} · ${nameSource(chapter)}`);
    head.append(status, title, meta);
    if (chapter.ai?.artifact) {
      const warn = el("span", "chWarn");
      warn.append(icon("warning"), "Possible artifact");
      head.append(warn);
    }
    row.append(head);
    return row;
  }

  private atomName(chapter: Chapter, atom: number): string {
    const t = this.trajectory;
    const symbol = t ? (t.frameSymbols[chapter.startFrame * t.numAtoms + atom] ?? t.symbols[atom]) : "";
    return `${symbol ?? ""}${atom}`;
  }

  private distance(frame: number, [a, b]: BondPair): number {
    const t = this.trajectory!;
    const base = frame * t.numAtoms * 3;
    const p = t.positions;
    return Math.hypot(p[base + a * 3] - p[base + b * 3], p[base + a * 3 + 1] - p[base + b * 3 + 1], p[base + a * 3 + 2] - p[base + b * 3 + 2]);
  }

  private renderInspector() {
    const inspector = this.opts.inspectorEl;
    const chapter = this.chapters[this.selectedIndex];
    if (!chapter || !this.trajectory || this.scanning !== null) {
      inspector.hidden = true;
      inspector.replaceChildren();
      return;
    }
    inspector.hidden = false;
    const ai = chapter.ai;

    // 1. What was selected, and its current decision.
    const head = el("div", "chInspectorHead");
    head.append(
      el("h3", "chInspectorTitle", displayLabel(chapter)),
      el("div", "chInspectorMeta", `${CATEGORY_NAME[chapter.category] ?? chapter.category} · ${frameRange(chapter)} · ${chapter.atoms.length} atoms`),
    );
    const state = el("span", `chDecisionState ${chapter.status}`);
    state.append(
      icon(chapter.status),
      chapter.status === "pending" ? "Not reviewed" : `${STATUS_NAME[chapter.status]} at ${clock(chapter.reviewedAt)}`,
    );
    head.append(state);
    inspector.replaceChildren(head);

    // Warnings stay visible above the evidence.
    if (ai?.artifact) {
      const notice = el("div", "chNotice");
      notice.setAttribute("role", "note");
      notice.append(icon("warning"), el("span", undefined, `Possible artifact. ${ai.model} judged that this may not be real chemistry. Check the distances below before accepting.`));
      inspector.append(notice);
    }

    // 2. Evidence.
    const evidence = el("div", "chSub");
    evidence.append(el("h4", undefined, "Evidence"), el("p", "chText", `Detector: ${chapter.label}`));
    const { before, after } = bracketFrames(this.trajectory, chapter, this.detectOptions.minPersistFrames);
    const bonds = [
      ...chapter.formed.map((pair) => ({ pair, formed: true })),
      ...chapter.broken.map((pair) => ({ pair, formed: false })),
    ];
    const table = el("table", "bondTable");
    const caption = el("caption", undefined, `Bond changes, distances in Å at frames ${before} and ${after}`);
    caption.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
    const thead = el("thead");
    const hr = el("tr");
    for (const [text, cls] of [["Change", ""], ["Atoms", ""], [`Frame ${before}`, "num"], [`Frame ${after}`, "num"]]) {
      const th = el("th", cls || undefined, text);
      th.scope = "col";
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el("tbody");
    const shown = this.showAllBonds ? bonds : bonds.slice(0, BOND_ROWS);
    for (const { pair, formed } of shown) {
      const tr = el("tr");
      const change = el("td");
      const tag = el("span", `chg ${formed ? "formed" : "broken"}`, formed ? "+ Formed" : "− Broken");
      change.append(tag);
      tr.append(
        change,
        el("td", "pair", `${this.atomName(chapter, pair[0])}–${this.atomName(chapter, pair[1])}`),
        el("td", "num", this.distance(before, pair).toFixed(2)),
        el("td", "num", this.distance(after, pair).toFixed(2)),
      );
      tbody.append(tr);
    }
    table.append(caption, thead, tbody);
    evidence.append(table);
    if (bonds.length > BOND_ROWS) {
      const more = el("button", "btn link", this.showAllBonds ? "Show fewer bonds" : `Show all ${bonds.length} bonds`);
      more.type = "button";
      more.addEventListener("click", () => {
        this.showAllBonds = !this.showAllBonds;
        this.renderInspector();
      });
      evidence.append(more);
    }
    inspector.append(evidence);

    // 3. Suggestion.
    const suggestion = el("div", "chSub");
    suggestion.append(el("h4", undefined, "Suggestion"));
    if (ai) {
      suggestion.append(el("p", "chText", ai.label));
      if (ai.rationale) suggestion.append(el("p", "chTextSecondary", ai.rationale));
      suggestion.append(el("p", "chTextSecondary", `${ai.model} · stated confidence ${Math.round(ai.confidence * 100)}%`));
      if (chapter.humanLabel !== ai.label) {
        const use = el("button", "btn link", "Use suggested name");
        use.type = "button";
        use.addEventListener("click", () => {
          chapter.humanLabel = ai.label;
          this.persist();
          this.render();
        });
        suggestion.append(use);
      }
    } else {
      suggestion.append(el("p", "chTextSecondary", "No model suggestion for this event. Use Suggest names above to request one."));
    }
    inspector.append(suggestion);

    // 4. Decision.
    const decision = el("div", "chSub");
    decision.append(el("h4", undefined, "Decision"));
    const id = chapter.id.replace(/[^a-z0-9]/gi, "_");
    const nameField = el("div", "chField");
    const nameLabel = el("label", undefined, "Name");
    nameLabel.htmlFor = `chName-${id}`;
    const name = el("input");
    name.id = `chName-${id}`;
    name.type = "text";
    name.placeholder = ai?.label ?? chapter.label;
    name.value = chapter.humanLabel ?? "";
    name.addEventListener("change", () => {
      chapter.humanLabel = name.value.trim() || null;
      this.persist();
      this.render();
    });
    nameField.append(nameLabel, name);
    const noteField = el("div", "chField");
    const noteLabel = el("label", undefined, "Note");
    noteLabel.htmlFor = `chNote-${id}`;
    const note = el("textarea");
    note.id = `chNote-${id}`;
    note.rows = 2;
    note.value = chapter.note;
    note.addEventListener("change", () => {
      chapter.note = note.value;
      this.persist();
    });
    noteField.append(noteLabel, note);

    const bar = el("div", "decisionBar");
    const decide = (text: string, key: string, status: ReviewStatus, cls: string) => {
      const button = el("button", `btn decision ${cls}`);
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

    const foot = el("div", "decisionFoot");
    const clear = el("button", "btn link", "Clear decision");
    clear.type = "button";
    clear.disabled = chapter.status === "pending";
    clear.setAttribute("aria-keyshortcuts", "U");
    clear.title = "Mark as not reviewed (U)";
    clear.addEventListener("click", () => this.review("pending"));
    foot.append(el("span", "chTextSecondary", "Decisions save automatically."), clear);

    decision.append(nameField, noteField, bar, foot);
    inspector.append(decision);
  }
}
