// Checks what a model's label actually claims against the answer key.
// "Atoms named" only asks whether the right atoms appear; this reads the
// label's verbs and checks each claim, so "N1 swaps C0 for C2" is caught as
// wrong when C0 really bonded to O3.
//
// Recognized claim shapes (atom names like "H7", "C12"):
//   X moves|transfers|migrates|shifts|hops from A to B  -> A-X broken, B-X formed
//   A-B (bond) breaks|opens|cleaves|dissociates          -> A-B broken
//   A-B (bond) forms|closes                               -> A-B formed
//   X binds|bonds to Y                                    -> X-Y formed
//   breaking (its) bond(s) with Y        (subject X)      -> X-Y broken
//   X swaps A for B                                       -> X-A broken, X-B formed
//   X and Y form H2                                       -> X-Y formed
// Unrecognized wording yields no claims; such labels are counted separately.

export interface ClaimResult {
  claims: number;
  correct: number;
  /** The false claims, for reading the misses. */
  wrong: string[];
}

const ATOM = String.raw`([A-Z][a-z]?\d+)`;
const DASH = String.raw`\s*[-–—]\s*`;

function index(name: string): number {
  return Number(name.replace(/^[A-Za-z]+/, ""));
}

export function checkClaims(label: string, formed: [number, number][], broken: [number, number][]): ClaimResult {
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const formedSet = new Set(formed.map(([a, b]) => key(a, b)));
  const brokenSet = new Set(broken.map(([a, b]) => key(a, b)));
  const result: ClaimResult = { claims: 0, correct: 0, wrong: [] };
  const claim = (text: string, ok: boolean) => {
    result.claims++;
    if (ok) result.correct++;
    else result.wrong.push(text);
  };
  const isFormed = (x: string, y: string) => formedSet.has(key(index(x), index(y)));
  const isBroken = (x: string, y: string) => brokenSet.has(key(index(x), index(y)));

  for (const m of label.matchAll(new RegExp(`${ATOM}\\s+(?:moves|transfers|migrates|shifts|hops)\\s+from\\s+${ATOM}\\s+to\\s+${ATOM}`, "gi"))) {
    claim(m[0], isBroken(m[1], m[2]) && isFormed(m[1], m[3]));
  }
  for (const m of label.matchAll(new RegExp(`${ATOM}\\s+swaps\\s+${ATOM}\\s+for\\s+${ATOM}`, "gi"))) {
    claim(m[0], isBroken(m[1], m[2]) && isFormed(m[1], m[3]));
  }
  for (const m of label.matchAll(new RegExp(`${ATOM}${DASH}${ATOM}(?:\\s+bond)?\\s+(?:breaks|opens|cleaves|dissociates|is broken)`, "gi"))) {
    claim(m[0], isBroken(m[1], m[2]));
  }
  for (const m of label.matchAll(new RegExp(`${ATOM}${DASH}${ATOM}(?:\\s+bond)?\\s+(?:forms|closes|is formed)`, "gi"))) {
    claim(m[0], isFormed(m[1], m[2]));
  }
  for (const m of label.matchAll(new RegExp(`${ATOM}\\s+(?:binds|bonds)\\s+(?:to|with)\\s+${ATOM}`, "gi"))) {
    claim(m[0], isFormed(m[1], m[2]));
  }
  for (const m of label.matchAll(new RegExp(`${ATOM}\\s+and\\s+${ATOM}\\s+form\\s+H2`, "gi"))) {
    claim(m[0], isFormed(m[1], m[2]));
  }
  // "X binds to Y, breaking its bond with Z": Z's partner is the sentence subject.
  const subject = label.match(new RegExp(`^\\s*${ATOM}`))?.[1];
  for (const m of label.matchAll(new RegExp(`breaking\\s+(?:its\\s+)?bonds?\\s+with\\s+${ATOM}`, "gi"))) {
    if (subject) claim(m[0], isBroken(subject, m[1]));
  }
  return result;
}
