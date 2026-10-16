// AI naming pass for Simulation Chapters. The browser talks straight to a
// local Ollama server (default http://localhost:11434), so beta testing needs
// no API key and nothing leaves the machine. The model only *suggests*: it
// names and explains each detected event and flags likely cutoff artifacts;
// the scientist still accepts or rejects every chapter.
//
// The reaction category is not the model's job. It comes from geometry rules
// (chapterChemistry.ts), which beat qwen2.5:7b (5%) and gemma2:9b (33%) on the
// Transition1x benchmark; the model gets the category and the bonding around
// each atom as context, so its label and its artifact call are grounded.

import { BOND_TOLERANCE, HH_BOND_CUTOFF, bondCutoff } from "./bonds";
import { localGraph, neighborContext } from "./chapterChemistry";
import { DEFAULT_DETECT_OPTIONS } from "./chapterDetect";
import type { Chapter } from "./chapterStore";
import type { Trajectory } from "./xyzParser";

export interface AiSuggestion {
  label: string;
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
  const settle = DEFAULT_DETECT_OPTIONS.minPersistFrames;
  const before = Math.max(chapter.startFrame - 1, 0);
  const after = Math.min(chapter.endFrame + settle - 1, trajectory.numFrames - 1);
  const bond = ([a, b]: [number, number]) => {
    const cutoff = bondCutoff(symbol(a), symbol(b));
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
    category: chapter.category,
    summary: chapter.label,
    formed: chapter.formed.map(bond),
    broken: chapter.broken.map(bond),
    atoms: neighborContext(trajectory, chapter, localGraph(trajectory, chapter, settle)),
  };
}

const SYSTEM_PROMPT = `You are a computational chemist naming events that a detector found in a molecular simulation trajectory.
Bonds are inferred from distance: two atoms are bonded when closer than cutoff_A (sum of covalent radii x ${BOND_TOLERANCE}; ${HH_BOND_CUTOFF} Å for H-H).
Each event gives:
- category: computed from the bond graph and reliable. h2-elimination = two H atoms leave their partners and form H2; proton-transfer = an H moves from one partner to another; ring-change = a ring forms or opens; ligand-exchange = an atom swaps one bonding partner for another; bond-formation / bond-cleavage = bonds only form / only break.
- summary: the detector's own description. For a single transfer or swap it states exactly which atom moved between which partners; for larger rearrangements it only counts bonds.
- formed / broken: the bonds that changed, with distances before and after.
- atoms: each involved atom's bonded neighbors before and after.
For every event return:
- label: at most 12 words saying what happens, always naming atoms by their given names (H7, C2), never just "hydrogen" or "nitrogen", consistent with the category and with the formed / broken lists. Only state a bond as formed or broken if it is in those lists, and keep the roles in the summary when it names them. Use the atom names given.
- artifact: true only if this is probably not chemistry, e.g. two atoms of the same element touching in a dense phase, or distances barely crossing the cutoff and staying near it. Ordinary reactions in small molecules are not artifacts.
- confidence: 0 to 1, how sure you are the label is right.
- rationale: one short sentence citing distances or neighbors.
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
          artifact: { type: "boolean" },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["id", "label", "artifact", "confidence", "rationale"],
      },
    },
  },
  required: ["events"],
};

interface RawSuggestion {
  id?: unknown;
  label?: unknown;
  artifact?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

/** Validates one model output entry; small models drift, so be forgiving. */
function toSuggestion(raw: RawSuggestion, model: string): AiSuggestion | null {
  if (typeof raw.label !== "string" || !raw.label.trim()) return null;
  const confidence = Number(raw.confidence);
  return {
    label: raw.label.trim().slice(0, 120),
    artifact: raw.artifact === true || raw.artifact === "true",
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
    rationale: typeof raw.rationale === "string" ? raw.rationale.trim().slice(0, 400) : "",
    model,
    at: new Date().toISOString(),
  };
}

const RETRY_DELAYS_MS = [2000, 5000];
// Output budget per event (label + rationale + JSON). With a JSON schema some
// models (gemma2 on Ollama) can emit whitespace forever; a cap turns that 2-minute
// hang into a quick, retryable "incomplete answer".
const TOKENS_PER_EVENT = 160;

/** One request, retried after a dropped connection or a 5xx (Ollama reloading a model). */
async function chat(settings: LlmSettings, userContent: string, events: number, signal: AbortSignal): Promise<RawSuggestion[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatOnce(settings, userContent, events, signal);
    } catch (err) {
      const retryable = (err as { retryable?: boolean }).retryable === true;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length || signal.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

function retryable(err: Error): Error {
  return Object.assign(err, { retryable: true });
}

async function chatOnce(settings: LlmSettings, userContent: string, events: number, signal: AbortSignal): Promise<RawSuggestion[]> {
  // Each attempt gets its own time limit, so a retry isn't born already expired.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl(settings.endpoint)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, timeout]),
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        format: RESPONSE_SCHEMA,
        options: { temperature: 0.2, num_predict: 64 + TOKENS_PER_EVENT * events },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (err) {
    if (signal.aborted) throw err; // the user stopped the run
    if (timeout.aborted) {
      // Usually the model is still loading into GPU memory, so try again.
      throw retryable(new Error(`${settings.model} didn't answer within ${REQUEST_TIMEOUT_MS / 1000} s.`));
    }
    throw retryable(unreachable(settings.endpoint, err));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`Ollama returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    throw response.status >= 500 ? retryable(error) : error;
  }
  const body = (await response.json()) as { message?: { content?: string }; done_reason?: string };
  let parsed: { events?: unknown };
  try {
    parsed = JSON.parse(body.message?.content ?? "");
  } catch {
    const why = body.done_reason === "length" ? "it ran past the length limit" : "it wasn't valid JSON";
    throw retryable(new Error(`${settings.model} returned an incomplete answer (${why}).`));
  }
  return Array.isArray(parsed.events) ? (parsed.events as RawSuggestion[]) : [];
}

/**
 * A suggestion must be about the event: it names at least one atom that
 * changed, and only atoms from the event or their bonded neighbors. Vague
 * ("Nitrogen gains hydrogen") or ungrounded labels are dropped instead of
 * being shown as if they were evidence-based.
 */
function grounded(label: string, eventAtoms: Set<string>, allowed: Set<string>): boolean {
  const named = label.match(/\b[A-Z][a-z]?\d+\b/g) ?? [];
  return named.some((n) => eventAtoms.has(n)) && named.every((n) => allowed.has(n));
}

export interface SuggestResult {
  /** Chapters that received a grounded suggestion. */
  named: number;
  /** Suggestions dropped for naming no event atom, or atoms outside the event. */
  ungrounded: number;
  /** Batches that failed after retries; the run continues past them. */
  failedBatches: number;
  lastError: Error | null;
}

/**
 * Asks the model to name each chapter, in small batches (small local models
 * lose track of long lists). Calls onBatch after each batch so the panel can
 * show suggestions as they arrive. A batch that fails after its retries is
 * skipped so one bad answer doesn't end the run; three failures in a row stop
 * it. If every batch tried failed, the last error is thrown.
 */
export async function suggestChapterLabels(
  settings: LlmSettings,
  trajectory: Trajectory,
  chapters: Chapter[],
  onBatch: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<SuggestResult> {
  if (!settings.model) throw new Error("Pick an Ollama model first.");
  const header = `System: ${trajectory.numAtoms} atoms (${composition(trajectory)}), ${trajectory.numFrames} frames.`;
  const result: SuggestResult = { named: 0, ungrounded: 0, failedBatches: 0, lastError: null };
  let batches = 0;
  let failedInARow = 0;

  for (let start = 0; start < chapters.length; start += BATCH_SIZE) {
    const batch = chapters.slice(start, start + BATCH_SIZE);
    const events = batch.map((chapter, i) => describeEvent(trajectory, chapter, `e${start + i}`));
    batches++;
    let results: RawSuggestion[];
    try {
      results = await chat(settings, `${header}\nEvents:\n${JSON.stringify(events)}`, batch.length, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      result.failedBatches++;
      result.lastError = err as Error;
      onBatch(Math.min(start + BATCH_SIZE, chapters.length), chapters.length);
      // A server that keeps failing won't recover mid-run; stop and keep what we have.
      if (++failedInARow >= 3) break;
      continue;
    }
    failedInARow = 0;

    results.forEach((raw, i) => {
      // Match by id; fall back to position when the model mangles ids.
      const index = typeof raw.id === "string" && /^e\d+$/.test(raw.id) ? Number(raw.id.slice(1)) : start + i;
      const chapter = chapters[index];
      if (!chapter || index < start || index >= start + batch.length) return;
      const suggestion = toSuggestion(raw, settings.model);
      if (!suggestion) return;
      const described = events[index - start];
      const eventAtoms = new Set(described.atoms.map((a) => a.atom));
      const allowed = new Set(described.atoms.flatMap((a) => [a.atom, ...a.bonded_before, ...a.bonded_after]));
      if (!grounded(suggestion.label, eventAtoms, allowed)) {
        result.ungrounded++;
        return;
      }
      chapter.ai = suggestion;
      result.named++;
    });
    onBatch(Math.min(start + BATCH_SIZE, chapters.length), chapters.length);
  }
  if (result.failedBatches === batches && result.lastError) throw result.lastError;
  return result;
}
