// Simulation Chapters panel: runs bond-change detection on the loaded
// trajectory, lists the events, marks them on the playback timeline, and lets
// a scientist accept / reject / relabel each one and export the labels.

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
import type { ChapterHighlight } from "./chapterHighlight";
import type { Trajectory } from "./xyzParser";

export interface ChaptersPanelOptions {
  panelEl: HTMLElement;
  toggleBtn: HTMLButtonElement;
  listEl: HTMLElement;
  summaryEl: HTMLElement;
  trackEl: HTMLElement;
  detectBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  persistInput: HTMLInputElement;
  highlight: ChapterHighlight;
  /** Jump playback to a frame (and pause). */
  seek: (frame: number) => void;
  annotator: () => string;
}

const KIND_ICON: Record<Chapter["kind"], string> = {
  "bond-break": "✂",
  "bond-form": "🔗",
  transfer: "⇄",
  rearrangement: "✱",
};

export class ChaptersPanel {
  private opts: ChaptersPanelOptions;
  private trajectory: Trajectory | null = null;
  private info: TrajectoryInfo | null = null;
  private chapters: Chapter[] = [];
  private selectedIndex = -1;
  private worker: Worker | null = null;
  private token = 0;
  private detectOptions: DetectOptions = { ...DEFAULT_DETECT_OPTIONS };

  constructor(opts: ChaptersPanelOptions) {
    this.opts = opts;
    opts.detectBtn.addEventListener("click", () => void this.detect());
    opts.exportBtn.addEventListener("click", () => this.exportLabels());
    opts.prevBtn.addEventListener("click", () => this.selectRelative(-1));
    opts.nextBtn.addEventListener("click", () => this.selectRelative(1));
    opts.toggleBtn.addEventListener("click", () => {
      const collapsed = opts.panelEl.classList.toggle("collapsed");
      opts.toggleBtn.textContent = collapsed ? "Show" : "Hide";
    });
    opts.persistInput.value = String(this.detectOptions.minPersistFrames);
    opts.persistInput.addEventListener("change", () => {
      const value = Math.round(Number(opts.persistInput.value));
      this.detectOptions.minPersistFrames = Number.isFinite(value) ? Math.min(Math.max(value, 1), 100) : 3;
      opts.persistInput.value = String(this.detectOptions.minPersistFrames);
      void this.detect();
    });
  }

  /** Called for every XYZ load. Multi-frame trajectories are scanned at once. */
  async setTrajectory(trajectory: Trajectory, file: Blob, name: string) {
    this.cancel();
    this.trajectory = trajectory;
    this.chapters = [];
    this.selectedIndex = -1;
    this.opts.highlight.setTrajectory(trajectory);
    this.info = { name, sha256: null, sizeBytes: file.size, numFrames: trajectory.numFrames, numAtoms: trajectory.numAtoms };
    if (trajectory.numFrames < 2) {
      this.hide();
      return;
    }
    this.opts.panelEl.style.display = "block";
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
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return false;
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
    this.render(restored > 0 ? `Restored ${restored} saved review${restored === 1 ? "" : "s"}.` : "");
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

  private select(index: number) {
    if (index < 0 || index >= this.chapters.length) return;
    this.selectedIndex = index;
    const chapter = this.chapters[index];
    this.opts.highlight.show(chapter);
    this.opts.seek(chapter.startFrame);
    this.render();
    this.opts.listEl.querySelector(".chapterRow.selected")?.scrollIntoView({ block: "nearest" });
  }

  private selectRelative(step: number) {
    if (this.chapters.length === 0) return;
    const next = this.selectedIndex < 0 ? (step > 0 ? 0 : this.chapters.length - 1) : this.selectedIndex + step;
    this.select(Math.min(Math.max(next, 0), this.chapters.length - 1));
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

  private render(notice = "") {
    this.renderSummary(notice);
    this.renderTrack();
    this.renderList();
    const empty = this.chapters.length === 0;
    this.opts.exportBtn.disabled = empty;
    this.opts.prevBtn.disabled = empty;
    this.opts.nextBtn.disabled = empty;
  }

  private renderSummary(notice: string) {
    if (!this.trajectory) return;
    const counts = { pending: 0, accepted: 0, rejected: 0 };
    for (const c of this.chapters) counts[c.status]++;
    const n = this.chapters.length;
    const base =
      n === 0
        ? "No bond changes detected."
        : `${n} event${n === 1 ? "" : "s"} · ${counts.accepted} accepted · ${counts.rejected} rejected · ${counts.pending} to review`;
    this.opts.summaryEl.textContent = notice ? `${base}\n${notice}` : base;
  }

  private renderTrack() {
    const track = this.opts.trackEl;
    track.replaceChildren();
    const trajectory = this.trajectory;
    if (!trajectory) return;
    const lastFrame = Math.max(trajectory.numFrames - 1, 1);
    this.chapters.forEach((chapter, index) => {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `chapterMarker ${chapter.status}${index === this.selectedIndex ? " selected" : ""}`;
      // Matches the range input's thumb inset so markers line up with frames.
      marker.style.left = `calc(8px + (100% - 16px) * ${chapter.startFrame / lastFrame})`;
      marker.title = `Frame ${chapter.startFrame}: ${chapter.humanLabel ?? chapter.label}`;
      marker.addEventListener("click", () => this.select(index));
      track.append(marker);
    });
  }

  private renderList() {
    const list = this.opts.listEl;
    list.replaceChildren();
    this.chapters.forEach((chapter, index) => {
      const row = document.createElement("div");
      row.className = `chapterRow ${chapter.status}${index === this.selectedIndex ? " selected" : ""}`;

      const head = document.createElement("div");
      head.className = "chapterHead";
      head.addEventListener("click", () => this.select(index));
      const dot = document.createElement("span");
      dot.className = "chapterDot";
      const title = document.createElement("span");
      title.className = "chapterTitle";
      title.textContent = `${KIND_ICON[chapter.kind]} ${chapter.humanLabel ?? chapter.label}`;
      const frames = document.createElement("span");
      frames.className = "chapterFrames";
      frames.textContent =
        chapter.endFrame > chapter.startFrame ? `f${chapter.startFrame}–${chapter.endFrame}` : `f${chapter.startFrame}`;
      head.append(dot, title, frames);
      row.append(head);

      if (index === this.selectedIndex) row.append(this.renderEditor(chapter));
      list.append(row);
    });
  }

  private renderEditor(chapter: Chapter): HTMLElement {
    const editor = document.createElement("div");
    editor.className = "chapterEditor";

    const detail = document.createElement("div");
    detail.className = "chapterDetail";
    const pairs = (list: [number, number][]) => list.map(([a, b]) => `${a}–${b}`).join(", ");
    const parts = [`Detector: ${chapter.label}`];
    if (chapter.formed.length) parts.push(`Formed: ${pairs(chapter.formed)}`);
    if (chapter.broken.length) parts.push(`Broken: ${pairs(chapter.broken)}`);
    detail.textContent = parts.join("\n");

    const label = document.createElement("input");
    label.type = "text";
    label.placeholder = "Your label (leave empty to keep the detector's)";
    label.value = chapter.humanLabel ?? "";
    label.addEventListener("change", () => {
      chapter.humanLabel = label.value.trim() || null;
      this.persist();
      this.render();
    });

    const note = document.createElement("textarea");
    note.placeholder = "Note (optional)";
    note.rows = 2;
    note.value = chapter.note;
    note.addEventListener("change", () => {
      chapter.note = note.value;
      this.persist();
    });

    const actions = document.createElement("div");
    actions.className = "chapterActions";
    const button = (text: string, status: ReviewStatus) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.className = `review-${status}`;
      b.addEventListener("click", () => this.review(status));
      return b;
    };
    actions.append(button("✓ Accept (A)", "accepted"), button("✗ Reject (R)", "rejected"), button("Undo (U)", "pending"));

    editor.append(detail, label, note, actions);
    return editor;
  }
}
