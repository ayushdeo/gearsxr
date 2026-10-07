// Chapter labels: the detector's events plus the scientist's review of each
// one. Reviews persist in localStorage per trajectory fingerprint, so
// reloading the same file restores them. Exports as a versioned JSON document
// meant to be pooled into a human-labeled benchmark dataset.

import {
  DETECTOR_NAME,
  DETECTOR_VERSION,
  type BondPair,
  type ChapterKind,
  type DetectOptions,
  type DetectedEvent,
} from "./chapterDetect";
import type { AiSuggestion } from "./chapterAI";

export type ReviewStatus = "pending" | "accepted" | "rejected";

export interface Chapter extends DetectedEvent {
  id: string;
  status: ReviewStatus;
  /** Scientist's label; null keeps the detector's label. */
  humanLabel: string | null;
  note: string;
  reviewedAt: string | null;
  /** Model suggestion (label, category, artifact flag); never sets status. */
  ai: AiSuggestion | null;
}

export interface TrajectoryInfo {
  name: string;
  /** sha256 of the file bytes, or null when unavailable (insecure context, huge file). */
  sha256: string | null;
  sizeBytes: number;
  numFrames: number;
  numAtoms: number;
}

export interface ChaptersExport {
  format: "gearsxr-chapters";
  version: 1;
  exportedAt: string;
  annotator: string;
  trajectory: TrajectoryInfo;
  detector: { name: string; version: number; options: DetectOptions };
  summary: Record<ReviewStatus, number>;
  events: Array<{
    id: string;
    kind: ChapterKind;
    startFrame: number;
    endFrame: number;
    atoms: number[];
    formed: BondPair[];
    broken: BondPair[];
    detectorLabel: string;
    ai: AiSuggestion | null;
    humanLabel: string | null;
    status: ReviewStatus;
    note: string;
    reviewedAt: string | null;
  }>;
}

const STORAGE_PREFIX = "gearsxr.chapters.";
const MAX_HASH_BYTES = 256 * 1024 * 1024;

/** Stable across runs of the same detector on the same file. */
export function chapterId(event: DetectedEvent): string {
  const bonds = [...event.formed.map((p) => `+${p[0]}-${p[1]}`), ...event.broken.map((p) => `-${p[0]}-${p[1]}`)];
  return `f${event.startFrame}:${bonds.sort().join(",")}`;
}

export function toChapters(events: DetectedEvent[]): Chapter[] {
  return events.map((event) => ({
    ...event,
    id: chapterId(event),
    status: "pending",
    humanLabel: null,
    note: "",
    reviewedAt: null,
    ai: null,
  }));
}

export async function fingerprint(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle || file.size > MAX_HASH_BYTES) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function storageKey(info: TrajectoryInfo) {
  // Without a hash, fall back to name + shape; good enough for a local cache.
  return STORAGE_PREFIX + (info.sha256 ?? `${info.name}:${info.sizeBytes}:${info.numAtoms}x${info.numFrames}`);
}

type SavedReview = Pick<Chapter, "status" | "humanLabel" | "note" | "reviewedAt" | "ai">;

export function saveReviews(info: TrajectoryInfo, chapters: Chapter[]) {
  const reviews: Record<string, SavedReview> = {};
  for (const c of chapters) {
    if (c.status === "pending" && c.humanLabel === null && !c.note && !c.ai) continue;
    reviews[c.id] = { status: c.status, humanLabel: c.humanLabel, note: c.note, reviewedAt: c.reviewedAt, ai: c.ai };
  }
  try {
    if (Object.keys(reviews).length === 0) localStorage.removeItem(storageKey(info));
    else localStorage.setItem(storageKey(info), JSON.stringify(reviews));
  } catch {
    // Storage blocked or full: reviews still live in memory and in exports.
  }
}

export function restoreReviews(info: TrajectoryInfo, chapters: Chapter[]): number {
  let reviews: Record<string, SavedReview>;
  try {
    reviews = JSON.parse(localStorage.getItem(storageKey(info)) ?? "{}");
  } catch {
    return 0;
  }
  let restored = 0;
  for (const c of chapters) {
    const saved = reviews[c.id];
    if (!saved) continue;
    Object.assign(c, { ...saved, ai: saved.ai ?? null });
    restored++;
  }
  return restored;
}

export function buildExport(
  info: TrajectoryInfo,
  options: DetectOptions,
  chapters: Chapter[],
  annotator: string,
): ChaptersExport {
  const summary: Record<ReviewStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
  for (const c of chapters) summary[c.status]++;
  return {
    format: "gearsxr-chapters",
    version: 1,
    exportedAt: new Date().toISOString(),
    annotator,
    trajectory: info,
    detector: { name: DETECTOR_NAME, version: DETECTOR_VERSION, options },
    summary,
    events: chapters.map((c) => ({
      id: c.id,
      kind: c.kind,
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      atoms: c.atoms,
      formed: c.formed,
      broken: c.broken,
      detectorLabel: c.label,
      ai: c.ai,
      humanLabel: c.humanLabel,
      status: c.status,
      note: c.note,
      reviewedAt: c.reviewedAt,
    })),
  };
}
