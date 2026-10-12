// Scores Simulation Chapters against a known-answer benchmark made by
// t1x_to_benchmark.py. It runs the viewer's own detector and AI code, so the
// numbers describe exactly what the viewer does.
//
//   npm run bench -- bench/                               # detector only
//   npm run bench -- bench/ --models qwen2.5:7b,gemma2:9b # plus local models
//
// Options: --models a,b  --endpoint http://localhost:11434  --limit N  --persist N
// Writes bench/report.json (every reaction) and bench/report.md (summary).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listModels, suggestChapterLabels, type AiCategory } from "../../src/chapterAI";
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
  category: AiCategory;
}

interface ModelResult {
  model: string;
  /** AI category for the event that best matches the true reaction. */
  category: string | null;
  categoryCorrect: boolean;
  /** Real events the model called artifacts. */
  falseArtifacts: number;
  realEvents: number;
  /** Fraction of truly changed atoms the main label names (e.g. "H5"). */
  atomMention: number;
  label: string | null;
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
  models: ModelResult[];
}

function parseArgs(argv: string[]) {
  const args = { dir: "", models: [] as string[], endpoint: "http://localhost:11434", limit: Infinity, persist: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") args.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--persist") args.persist = Number(argv[++i]);
    else if (!a.startsWith("--")) args.dir = a;
  }
  if (!args.dir) {
    console.error("Usage: npm run bench -- <benchmark dir> [--models a,b] [--endpoint URL] [--limit N] [--persist N]");
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

function eventPairs(event: DetectedEvent): string[] {
  return [...event.formed, ...event.broken].map(([a, b]) => pairKey(a, b));
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
    model, category: null, categoryCorrect: false, falseArtifacts: 0, realEvents: 0, atomMention: 0, label: null, seconds: 0,
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

  let main = null as (typeof chapters)[number] | null;
  let bestOverlap = 0;
  for (const chapter of chapters) {
    const overlap = eventPairs(chapter).filter((p) => truthPairs.has(p)).length;
    if (overlap === 0) continue;
    result.realEvents++;
    if (chapter.ai?.artifact) result.falseArtifacts++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      main = chapter;
    }
  }
  if (main?.ai) {
    result.category = main.ai.category;
    result.categoryCorrect = main.ai.category === answer.category;
    result.label = main.ai.label;
    const changed = new Set([...answer.formed, ...answer.broken].flat());
    const names = [...changed].map((atom) => `${answer.symbols[atom]}${atom}`);
    const mentioned = names.filter((name) => new RegExp(`\\b${name}\\b`).test(main!.ai!.label)).length;
    result.atomMention = names.length ? mentioned / names.length : 0;
  }
  return result;
}

function pct(n: number, d: number) {
  return d === 0 ? "–" : `${((100 * n) / d).toFixed(1)}%`;
}

function summarize(results: ReactionResult[], models: string[], persist: number): string {
  const sum = (f: (r: ReactionResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const tp = sum((r) => r.tp), fp = sum((r) => r.fp), fn = sum((r) => r.fn);
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const f1 = (2 * precision * recall) / Math.max(precision + recall, 1e-9);
  const single = results.filter((r) => r.events === 1).length;

  const lines = [
    `# Chapters benchmark`,
    ``,
    `${results.length} reactions · detector bond-diff (persist ${persist} frames)`,
    ``,
    `## Detector`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Bond-change precision | ${(precision * 100).toFixed(1)}% (${tp} of ${tp + fp} detected) |`,
    `| Bond-change recall | ${(recall * 100).toFixed(1)}% (${tp} of ${tp + fn} true) |`,
    `| F1 | ${(f1 * 100).toFixed(1)}% |`,
    `| Reactions found exactly | ${pct(results.filter((r) => r.exact).length, results.length)} |`,
    `| Reactions as a single chapter | ${pct(single, results.length)} |`,
    `| Mean chapters per reaction | ${(sum((r) => r.events) / Math.max(results.length, 1)).toFixed(2)} |`,
  ];

  if (models.length) {
    lines.push(
      ``,
      `## Models`,
      ``,
      `Category is scored on the chapter that best matches the true reaction. A false artifact is a real event the model dismissed.`,
      ``,
      `| Model | Category accuracy | False-artifact rate | Atoms named in label | Errors | Seconds / reaction |`,
      `|---|---|---|---|---|---|`,
    );
    for (const model of models) {
      const rows = results.map((r) => r.models.find((m) => m.model === model)!).filter(Boolean);
      const scored = rows.filter((m) => m.category !== null);
      const real = rows.reduce((s, m) => s + m.realEvents, 0);
      const falseArtifacts = rows.reduce((s, m) => s + m.falseArtifacts, 0);
      const mention = scored.reduce((s, m) => s + m.atomMention, 0) / Math.max(scored.length, 1);
      const seconds = rows.reduce((s, m) => s + m.seconds, 0) / Math.max(rows.length, 1);
      lines.push(
        `| ${model} | ${pct(scored.filter((m) => m.categoryCorrect).length, scored.length)} | ${pct(falseArtifacts, real)} | ${(mention * 100).toFixed(1)}% | ${rows.filter((m) => m.error).length} | ${seconds.toFixed(1)} |`,
      );
    }

    const categories = [...new Set(results.map((r) => r.truthCategory))].sort();
    lines.push(``, `### Category accuracy by true category`, ``, `| True category | n | ${models.join(" | ")} |`, `|---|---|${models.map(() => "---|").join("")}`);
    for (const category of categories) {
      const rows = results.filter((r) => r.truthCategory === category);
      const cells = models.map((model) => {
        const scored = rows.map((r) => r.models.find((m) => m.model === model)).filter((m) => m && m.category !== null);
        return pct(scored.filter((m) => m!.categoryCorrect).length, scored.length);
      });
      lines.push(`| ${category} | ${rows.length} | ${cells.join(" | ")} |`);
    }
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(args.dir, "answers.json"), "utf8"));
  const answers: Answer[] = manifest.reactions.slice(0, args.limit);
  const options = { ...DEFAULT_DETECT_OPTIONS, ...(args.persist ? { minPersistFrames: args.persist } : {}) };
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
    const ambiguous = new Set(answer.ambiguous.map(([a, b]) => pairKey(a, b)));

    let tp = 0, fp = 0;
    for (const [key, kind] of netChanges(events)) {
      if (ambiguous.has(key)) continue;
      if (truth.get(key) === kind) tp++;
      else fp++;
    }
    const fn = truth.size - tp;

    const models: ModelResult[] = [];
    for (const model of args.models) {
      models.push(await evaluateModel(model, args.endpoint, trajectory, events, answer, new Set(truth.keys())));
    }

    results.push({
      id: answer.id, formula: answer.formula, truthCategory: answer.category, truthChanges: truth.size,
      events: events.length, tp, fp, fn, exact: fp === 0 && fn === 0, models,
    });
    process.stdout.write(`\r${index + 1}/${answers.length} reactions`);
  }
  process.stdout.write("\n");

  const report = summarize(results, args.models, options.minPersistFrames);
  writeFileSync(join(args.dir, "report.json"), JSON.stringify({ options, models: args.models, results }, null, 1));
  writeFileSync(join(args.dir, "report.md"), report);
  console.log(report);
  console.log(`Details: ${join(args.dir, "report.json")}`);
}

void main();
