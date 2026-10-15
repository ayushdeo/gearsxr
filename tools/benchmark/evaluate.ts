// Scores Simulation Chapters against a known-answer benchmark made by
// t1x_to_benchmark.py. It runs the viewer's own detector, category rules and
// AI code, so the numbers describe exactly what the viewer does.
//
//   npm run bench -- bench/                               # detector + rules
//   npm run bench -- bench/ --models qwen2.5:7b,gemma2:9b # plus local models
//
// Options: --models a,b  --endpoint http://localhost:11434  --limit N  --persist N  --window N
// Writes bench/report.json (every reaction) and bench/report.md (summary).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listModels, suggestChapterLabels } from "../../src/chapterAI";
import { CHAPTER_CATEGORIES } from "../../src/chapterChemistry";
import { DEFAULT_DETECT_OPTIONS, detectBondEvents, type DetectedEvent } from "../../src/chapterDetect";
import { toChapters } from "../../src/chapterStore";
import { parseExtendedXYZ } from "../../src/xyzParser";

interface Answer {
  id: string;
  file: string;
  formula: string;
  symbols: string[];
  formed: [number, number][];
  broken: [number, number][];
  ambiguous: [number, number][];
  category: string;
}

interface ModelResult {
  model: string;
  /** Label of the chapter that best matches the true reaction. */
  label: string | null;
  confidence: number | null;
  /** Real events the model called artifacts. */
  falseArtifacts: number;
  realEvents: number;
  /** Fraction of truly changed atoms the main label names (e.g. "H5"). */
  atomMention: number | null;
  seconds: number;
  error?: string;
}

interface ReactionResult {
  id: string;
  formula: string;
  truthCategory: string;
  truthChanges: number;
  events: number;
  tp: number;
  fp: number;
  fn: number;
  exact: boolean;
  /** Rule category of the chapter that best matches the true reaction. */
  category: string | null;
  categoryCorrect: boolean;
  chapters: Array<{ startFrame: number; endFrame: number; atoms: number[]; category: string; label: string }>;
  models: ModelResult[];
}

function parseArgs(argv: string[]) {
  const args = { dir: "", models: [] as string[], endpoint: "http://localhost:11434", limit: Infinity, persist: 0, window: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") args.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--persist") args.persist = Number(argv[++i]);
    else if (a === "--window") args.window = Number(argv[++i]);
    else if (!a.startsWith("--")) args.dir = a;
  }
  if (!args.dir) {
    console.error("Usage: npm run bench -- <benchmark dir> [--models a,b] [--endpoint URL] [--limit N] [--persist N] [--window N]");
    process.exit(1);
  }
  return args;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Net bond changes across all events: a bond that forms then breaks cancels. */
function netChanges(events: DetectedEvent[]): Map<string, "formed" | "broken"> {
  const sorted = [...events].sort((x, y) => x.startFrame - y.startFrame);
  const net = new Map<string, "formed" | "broken">();
  for (const event of sorted) {
    for (const [list, kind] of [[event.formed, "formed"], [event.broken, "broken"]] as const) {
      for (const [a, b] of list) {
        const key = pairKey(a, b);
        if (net.has(key) && net.get(key) !== kind) net.delete(key);
        else net.set(key, kind);
      }
    }
  }
  return net;
}

function overlap(event: DetectedEvent, truthPairs: Set<string>): number {
  return [...event.formed, ...event.broken].filter(([a, b]) => truthPairs.has(pairKey(a, b))).length;
}

/** The chapter sharing the most bond changes with the true reaction. */
function mainIndex(events: DetectedEvent[], truthPairs: Set<string>): number {
  let best = -1;
  let bestOverlap = 0;
  events.forEach((event, i) => {
    const n = overlap(event, truthPairs);
    if (n > bestOverlap) {
      bestOverlap = n;
      best = i;
    }
  });
  return best;
}

async function evaluateModel(
  model: string,
  endpoint: string,
  trajectory: Awaited<ReturnType<typeof parseExtendedXYZ>>,
  events: DetectedEvent[],
  answer: Answer,
  truthPairs: Set<string>,
): Promise<ModelResult> {
  const result: ModelResult = {
    model, label: null, confidence: null, falseArtifacts: 0, realEvents: 0, atomMention: null, seconds: 0,
  };
  if (events.length === 0) return result;
  const chapters = toChapters(events);
  const started = performance.now();
  try {
    await suggestChapterLabels({ endpoint, model }, trajectory, chapters, () => {}, new AbortController().signal);
  } catch (err) {
    result.error = (err as Error).message;
  }
  result.seconds = (performance.now() - started) / 1000;

  for (const chapter of chapters) {
    if (overlap(chapter, truthPairs) === 0) continue;
    result.realEvents++;
    if (chapter.ai?.artifact) result.falseArtifacts++;
  }
  const main = chapters[mainIndex(chapters, truthPairs)]?.ai;
  if (main) {
    result.label = main.label;
    result.confidence = main.confidence;
    const changed = new Set([...answer.formed, ...answer.broken].flat());
    const names = [...changed].map((atom) => `${answer.symbols[atom]}${atom}`);
    const mentioned = names.filter((name) => new RegExp(`\\b${name}\\b`).test(main.label)).length;
    result.atomMention = names.length ? mentioned / names.length : null;
  }
  return result;
}

function pct(n: number, d: number) {
  return d === 0 ? "–" : `${((100 * n) / d).toFixed(1)}%`;
}

function median(values: number[]) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(results: ReactionResult[], models: string[], persist: number, window: number): string {
  const n = results.length;
  const sum = (f: (r: ReactionResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const tp = sum((r) => r.tp), fp = sum((r) => r.fp), fn = sum((r) => r.fn);
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const f1 = (2 * precision * recall) / Math.max(precision + recall, 1e-9);
  const scored = results.filter((r) => r.category !== null);

  const lines = [
    `# Chapters benchmark`,
    ``,
    `${n} reactions · detector bond-diff (persist ${persist} frames, group window ${window} frames)`,
    ``,
    `## Detector`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Bond-change precision | ${(precision * 100).toFixed(1)}% (${tp} of ${tp + fp} detected) |`,
    `| Bond-change recall | ${(recall * 100).toFixed(1)}% (${tp} of ${tp + fn} true) |`,
    `| F1 | ${(f1 * 100).toFixed(1)}% |`,
    `| Reactions found exactly | ${pct(results.filter((r) => r.exact).length, n)} |`,
    `| Reactions as a single chapter | ${pct(results.filter((r) => r.events === 1).length, n)} |`,
    `| Mean chapters per reaction | ${(sum((r) => r.events) / Math.max(n, 1)).toFixed(2)} |`,
    `| Category accuracy (rules, main chapter) | ${pct(scored.filter((r) => r.categoryCorrect).length, scored.length)} |`,
  ];

  // Category confusion: rows are the truth, columns what the rules said.
  const truthCats = [...new Set(results.map((r) => r.truthCategory))].sort();
  const predicted = CHAPTER_CATEGORIES.filter((c) => results.some((r) => r.category === c));
  lines.push(``, `### Category confusion (rows: truth, columns: rules)`, ``);
  lines.push(`| Truth \\ rules | n | ${predicted.join(" | ")} | accuracy |`, `|---|---|${predicted.map(() => "---|").join("")}---|`);
  for (const truth of truthCats) {
    const rows = scored.filter((r) => r.truthCategory === truth);
    const cells = predicted.map((c) => String(rows.filter((r) => r.category === c).length));
    lines.push(`| ${truth} | ${rows.length} | ${cells.join(" | ")} | ${pct(rows.filter((r) => r.categoryCorrect).length, rows.length)} |`);
  }

  // Why reactions split: how far apart their chapters start, and whether they share atoms.
  const split = results.filter((r) => r.events > 1);
  if (split.length) {
    const gaps: number[] = [];
    let sharing = 0;
    for (const r of split) {
      const sorted = [...r.chapters].sort((a, b) => a.startFrame - b.startFrame);
      for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].startFrame - sorted[i - 1].endFrame);
      const seen = new Set<number>();
      let shares = false;
      for (const c of sorted) {
        if (c.atoms.some((a) => seen.has(a))) shares = true;
        c.atoms.forEach((a) => seen.add(a));
      }
      if (shares) sharing++;
    }
    lines.push(
      ``,
      `### Split reactions`,
      ``,
      `${split.length} reactions became more than one chapter. Median gap between consecutive chapters: ${median(gaps)} frames (range ${Math.min(...gaps)}–${Math.max(...gaps)}). Chapters share an atom in ${pct(sharing, split.length)} of them.`,
    );
  }

  if (models.length) {
    lines.push(
      ``,
      `## Models`,
      ``,
      `Labels are scored on the chapter that best matches the true reaction. A false artifact is a real event the model dismissed.`,
      ``,
      `| Model | False-artifact rate | Atoms named in label | Mean confidence | Errors | Seconds / reaction |`,
      `|---|---|---|---|---|---|`,
    );
    for (const model of models) {
      const rows = results.map((r) => r.models.find((m) => m.model === model)!).filter(Boolean);
      const labeled = rows.filter((m) => m.atomMention !== null);
      const real = rows.reduce((s, m) => s + m.realEvents, 0);
      const falseArtifacts = rows.reduce((s, m) => s + m.falseArtifacts, 0);
      const mention = labeled.reduce((s, m) => s + (m.atomMention ?? 0), 0) / Math.max(labeled.length, 1);
      const confidence = labeled.reduce((s, m) => s + (m.confidence ?? 0), 0) / Math.max(labeled.length, 1);
      const seconds = rows.reduce((s, m) => s + m.seconds, 0) / Math.max(rows.length, 1);
      lines.push(
        `| ${model} | ${pct(falseArtifacts, real)} | ${(mention * 100).toFixed(1)}% | ${confidence.toFixed(2)} | ${rows.filter((m) => m.error).length} | ${seconds.toFixed(1)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(args.dir, "answers.json"), "utf8"));
  const answers: Answer[] = manifest.reactions.slice(0, args.limit);
  const options = {
    ...DEFAULT_DETECT_OPTIONS,
    ...(args.persist ? { minPersistFrames: args.persist } : {}),
    ...(args.window ? { groupWindowFrames: args.window } : {}),
  };
  const results: ReactionResult[] = [];

  if (args.models.length) {
    // Fail fast instead of erroring on every reaction.
    let installed: string[];
    try {
      installed = await listModels(args.endpoint, AbortSignal.timeout(5000));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    const missing = args.models.filter((m) => !installed.includes(m));
    if (missing.length) {
      console.error(`Not installed in Ollama: ${missing.join(", ")}. Installed: ${installed.join(", ") || "none"}.`);
      process.exit(1);
    }
  }

  for (const [index, answer] of answers.entries()) {
    const trajectory = await parseExtendedXYZ(new Blob([readFileSync(join(args.dir, answer.file))]) as File, () => {});
    const events = detectBondEvents(trajectory, options);

    const truth = new Map<string, "formed" | "broken">();
    for (const [a, b] of answer.formed) truth.set(pairKey(a, b), "formed");
    for (const [a, b] of answer.broken) truth.set(pairKey(a, b), "broken");
    const truthPairs = new Set(truth.keys());
    const ambiguous = new Set(answer.ambiguous.map(([a, b]) => pairKey(a, b)));

    let tp = 0, fp = 0;
    for (const [key, kind] of netChanges(events)) {
      if (ambiguous.has(key)) continue;
      if (truth.get(key) === kind) tp++;
      else fp++;
    }
    const main = events[mainIndex(events, truthPairs)];

    const models: ModelResult[] = [];
    for (const model of args.models) {
      models.push(await evaluateModel(model, args.endpoint, trajectory, events, answer, truthPairs));
    }

    results.push({
      id: answer.id, formula: answer.formula, truthCategory: answer.category, truthChanges: truth.size,
      events: events.length, tp, fp, fn: truth.size - tp, exact: fp === 0 && tp === truth.size,
      category: main?.category ?? null, categoryCorrect: main?.category === answer.category,
      chapters: events.map((e) => ({ startFrame: e.startFrame, endFrame: e.endFrame, atoms: e.atoms, category: e.category, label: e.label })),
      models,
    });
    process.stdout.write(`\r${index + 1}/${answers.length} reactions`);
  }
  process.stdout.write("\n");

  const report = summarize(results, args.models, options.minPersistFrames, options.groupWindowFrames);
  writeFileSync(join(args.dir, "report.json"), JSON.stringify({ options, models: args.models, results }, null, 1));
  writeFileSync(join(args.dir, "report.md"), report);
  console.log(report);
  console.log(`Details: ${join(args.dir, "report.json")}`);
}

void main();
