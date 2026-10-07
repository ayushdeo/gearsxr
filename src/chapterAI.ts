// AI naming pass for Simulation Chapters. The browser talks straight to a
// local Ollama server (default http://localhost:11434), so beta testing needs
// no API key and nothing leaves the machine. The model only *suggests*: it
// names each detected event, picks a category, and flags likely cutoff
// artifacts; the scientist still accepts or rejects every chapter.

import { BOND_TOLERANCE } from "./bonds";
import { getElementInfo } from "./elements";
import type { Chapter } from "./chapterStore";
import type { Trajectory } from "./xyzParser";

export const AI_CATEGORIES = [
  "proton-transfer",
  "bond-cleavage",
  "bond-formation",
  "ligand-exchange",
  "coordination-change",
  "ring-change",
  "cutoff-artifact",
  "other",
] as const;

export type AiCategory = (typeof AI_CATEGORIES)[number];

export interface AiSuggestion {
  label: string;
  category: AiCategory;
  /** True when the model judges this a distance-cutoff artifact, not chemistry. */
  artifact: boolean;
  confidence: number;
  rationale: string;
  model: string;
  at: string;
}

export interface LlmSettings {
  endpoint: string;
  model: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = { endpoint: "http://localhost:11434", model: "" };

const SETTINGS_KEY = "gearsxr.llm";
const BATCH_SIZE = 6;
const REQUEST_TIMEOUT_MS = 120_000;

export function loadLlmSettings(): LlmSettings {
  try {
    return { ...DEFAULT_LLM_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export function saveLlmSettings(settings: LlmSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: settings just won't survive a reload.
  }
}

function baseUrl(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, "");
}

function unreachable(endpoint: string, err: unknown): Error {
  if ((err as Error).name === "AbortError") return err as Error;
  return new Error(
    `Can't reach Ollama at ${endpoint}. Is \`ollama serve\` running? ` +
      "If this page isn't on localhost, set OLLAMA_ORIGINS to its origin and OLLAMA_HOST=0.0.0.0.",
  );
}

/** Installed model names from Ollama's /api/tags. */
export async function listModels(endpoint: string, signal?: AbortSignal): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(endpoint)}/api/tags`, { signal });
  } catch (err) {
    throw unreachable(endpoint, err);
  }
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}.`);
  const body = (await response.json()) as { models?: Array<{ name: string }> };
  return (body.models ?? []).map((m) => m.name).sort();
}

// --- prompt construction ---------------------------------------------------

function composition(trajectory: Trajectory): string {
  const counts = new Map<string, number>();
  for (const s of trajectory.symbols) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}${n}`).join(" ");
}

function distance(trajectory: Trajectory, frame: number, a: number, b: number): number {
  const base = frame * trajectory.numAtoms * 3;
  const p = trajectory.positions;
  const dx = p[base + a * 3] - p[base + b * 3];
  const dy = p[base + a * 3 + 1] - p[base + b * 3 + 1];
  const dz = p[base + a * 3 + 2] - p[base + b * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function describeEvent(trajectory: Trajectory, chapter: Chapter, key: string) {
  const offset = chapter.startFrame * trajectory.numAtoms;
  const symbol = (atom: number) => trajectory.frameSymbols[offset + atom] ?? trajectory.symbols[atom] ?? "X";
  const name = (atom: number) => `${symbol(atom)}${atom}`;
  const before = Math.max(chapter.startFrame - 1, 0);
  const after = Math.min(chapter.endFrame + 2, trajectory.numFrames - 1);
  const bond = ([a, b]: [number, number]) => {
    const cutoff = (getElementInfo(symbol(a)).radius + getElementInfo(symbol(b)).radius) * BOND_TOLERANCE;
    return {
      pair: `${name(a)}-${name(b)}`,
      before_A: +distance(trajectory, before, a, b).toFixed(2),
      after_A: +distance(trajectory, after, a, b).toFixed(2),
      cutoff_A: +cutoff.toFixed(2),
    };
  };
  return {
    id: key,
    frames: chapter.endFrame > chapter.startFrame ? `${chapter.startFrame}-${chapter.endFrame}` : `${chapter.startFrame}`,
    detector_kind: chapter.kind,
    formed: chapter.formed.map(bond),
    broken: chapter.broken.map(bond),
  };
}

const SYSTEM_PROMPT = `You are a computational chemist reviewing events that a simple detector flagged in a molecular dynamics trajectory.
Bonds are inferred only from distance: two atoms are bonded when their distance is below cutoff_A (sum of covalent radii x ${BOND_TOLERANCE}).
So some events are cutoff artifacts rather than chemistry, e.g. same-element contacts such as O-O or H-H in condensed phases, or a distance hovering right at the cutoff.
For every event, return:
- label: at most 8 words, chemically specific, using the given atom names (e.g. "H62 hops from O12 to O7").
- category: one of ${AI_CATEGORIES.join(", ")}.
- artifact: true if this is probably not real chemistry.
- confidence: 0 to 1.
- rationale: one short sentence citing the distances.
Return one entry per input event, keeping its id.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          category: { type: "string", enum: [...AI_CATEGORIES] },
          artifact: { type: "boolean" },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["id", "label", "category", "artifact", "confidence", "rationale"],
      },
    },
  },
  required: ["events"],
};

interface RawSuggestion {
  id?: unknown;
  label?: unknown;
  category?: unknown;
  artifact?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

/** Validates one model output entry; small models drift, so be forgiving. */
function toSuggestion(raw: RawSuggestion, model: string): AiSuggestion | null {
  if (typeof raw.label !== "string" || !raw.label.trim()) return null;
  const category = AI_CATEGORIES.includes(raw.category as AiCategory) ? (raw.category as AiCategory) : "other";
  const confidence = Number(raw.confidence);
  return {
    label: raw.label.trim().slice(0, 120),
    category,
    artifact: raw.artifact === true || raw.artifact === "true" || category === "cutoff-artifact",
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
    rationale: typeof raw.rationale === "string" ? raw.rationale.trim().slice(0, 400) : "",
    model,
    at: new Date().toISOString(),
  };
}

async function chat(settings: LlmSettings, userContent: string, signal: AbortSignal): Promise<RawSuggestion[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(settings.endpoint)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        format: RESPONSE_SCHEMA,
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (err) {
    throw unreachable(settings.endpoint, err);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const body = (await response.json()) as { message?: { content?: string } };
  try {
    const parsed = JSON.parse(body.message?.content ?? "{}");
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

/**
 * Asks the model to name each chapter, in small batches (small local models
 * lose track of long lists). Calls onBatch after each batch so the panel can
 * show suggestions as they arrive. Returns how many chapters got a suggestion.
 */
export async function suggestChapterLabels(
  settings: LlmSettings,
  trajectory: Trajectory,
  chapters: Chapter[],
  onBatch: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<number> {
  if (!settings.model) throw new Error("Pick an Ollama model first.");
  const header = `System: ${trajectory.numAtoms} atoms (${composition(trajectory)}), ${trajectory.numFrames} frames.`;
  let named = 0;

  for (let start = 0; start < chapters.length; start += BATCH_SIZE) {
    const batch = chapters.slice(start, start + BATCH_SIZE);
    const events = batch.map((chapter, i) => describeEvent(trajectory, chapter, `e${start + i}`));
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const results = await chat(
      settings,
      `${header}\nEvents:\n${JSON.stringify(events)}`,
      AbortSignal.any([signal, timeout]),
    );

    results.forEach((raw, i) => {
      // Match by id; fall back to position when the model mangles ids.
      const index = typeof raw.id === "string" && /^e\d+$/.test(raw.id) ? Number(raw.id.slice(1)) : start + i;
      const chapter = chapters[index];
      if (!chapter || index < start || index >= start + batch.length) return;
      const suggestion = toSuggestion(raw, settings.model);
      if (!suggestion) return;
      chapter.ai = suggestion;
      named++;
    });
    onBatch(Math.min(start + BATCH_SIZE, chapters.length), chapters.length);
  }
  return named;
}
