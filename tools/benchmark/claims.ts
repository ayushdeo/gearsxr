// Checks what a model's label actually claims against the answer key.
// "Atoms named" only asks whether the right atoms appear; this reads the
// label and checks each claim, so "N1 swaps C0 for C2" is caught as wrong
// when C0 really bonded to O3.
//
// Claim shapes (atom names like "H7", "C12"; unnamed "hydrogen"/"proton" too):
//   transfers   X [moves|transfers|proton transfer|...] from A to B,
//               proton transfer from A-H / H on A to B, hydrogen moves from A to B,
//               B accepts a proton from A|H, X transfers to B
//   swaps       X swaps|exchanges|switches (bonding partner) (from) A for|to B
//   bonding     X binds|bonds (to|with) Y, X forms bond(s) with Y (and Z),
//               X and Y form H2|a bond, X breaks its bond(s) with Y (and Z)
//   pairs       any other "A-B" takes the nearest verb: break/cleave/open/lose
//               means broken, form/close means formed
// Labels without any atom name are "vague"; labels with names but no
// recognizable claim are "unchecked". Neither counts as correct.

export interface ClaimResult {
  claims: number;
  correct: number;
  /** The false claims, for reading the misses. */
  wrong: string[];
  /** No atom names at all (e.g. "Nitrogen gains hydrogen"). */
  vague: boolean;
}

const A = String.raw`([A-Z][a-z]?\d+)`;
const H = String.raw`(H\d+)`;
const SEP = String.raw`\s*-\s*`;
const TRANSFER_VERB = String.raw`(?:proton\s+transfer|hydrogen\s+transfer|transfers?|moves?|migrates?|shifts?|hops?|jumps?)`;

const num = (name: string) => Number(name.replace(/^[A-Za-z]+/, ""));
const isH = (name: string) => /^H\d+$/.test(name);

export function checkClaims(rawLabel: string, formed: [number, number][], broken: [number, number][]): ClaimResult {
  const label = rawLabel.replace(/[–—−]/g, "-").replace(/→/g, " to ").replace(/\s+/g, " ").trim();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const formedSet = new Set(formed.map(([a, b]) => key(a, b)));
  const brokenSet = new Set(broken.map(([a, b]) => key(a, b)));
  const isFormed = (x: string, y: string) => formedSet.has(key(num(x), num(y)));
  const isBroken = (x: string, y: string) => brokenSet.has(key(num(x), num(y)));
  // An unnamed H moved from donor to acceptor.
  const someHMoved = (from: string, to: string) => {
    for (const k of brokenSet) {
      const [a, b] = k.split("-").map(Number);
      const h = a === num(from) ? b : b === num(from) ? a : null;
      if (h !== null && formedSet.has(key(h, num(to)))) return true;
    }
    return false;
  };

  const result: ClaimResult = { claims: 0, correct: 0, wrong: [], vague: !/[A-Z][a-z]?\d+/.test(label) };
  const consumed: Array<[number, number]> = [];
  const claim = (m: RegExpMatchArray, ok: boolean) => {
    result.claims++;
    if (ok) result.correct++;
    else result.wrong.push(m[0].trim());
    consumed.push([m.index!, m.index! + m[0].length]);
  };
  const each = (re: string, fn: (m: RegExpMatchArray) => boolean) => {
    for (const m of label.matchAll(new RegExp(re, "gi"))) {
      if (consumed.some(([s, e]) => m.index! < e && m.index! + m[0].length > s)) continue;
      claim(m, fn(m));
    }
  };
  const list = (text: string) => [...text.matchAll(/[A-Z][a-z]?\d+/g)].map((m) => m[0]);

  // Transfers with the donor written as a pair: "from N1-H9 to C0", "from H9 on O4 to C1".
  each(`from\\s+${A}${SEP}${A}\\s+to\\s+${A}`, (m) => {
    const [x, y, to] = [m[1], m[2], m[3]];
    const [h, donor] = isH(y) ? [y, x] : [x, y];
    return isBroken(donor, h) && isFormed(to, h);
  });
  each(`from\\s+${H}\\s+on\\s+${A}\\s+to\\s+${A}`, (m) => isBroken(m[2], m[1]) && isFormed(m[3], m[1]));
  // Named mover, optional verb: "H7 moves from C1 to N6", "H8 from C3 to C4", "H7 proton transfer from N0 to N2".
  each(`${A}\\s+(?:${TRANSFER_VERB}\\s+)?from\\s+${A}\\s+to\\s+${A}`, (m) => isBroken(m[2], m[1]) && isFormed(m[3], m[1]));
  // Detector style: "H11 transfer C4 to N6" (arrow already rewritten).
  // "C0 transfers H7 to C1" reads the other way round: the H is the mover.
  each(`${A}\\s+${TRANSFER_VERB}\\s+${A}\\s+to\\s+${A}`, (m) => {
    const [mover, donor] = isH(m[2]) && !isH(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    return isBroken(donor, mover) && isFormed(m[3], mover);
  });
  // "C1 transfers a proton to C6".
  each(`${A}\\s+(?:transfers|donates|gives|passes)\\s+(?:a\\s+)?(?:proton|hydrogen)\\s+to\\s+${A}`, (m) => someHMoved(m[1], m[2]));
  // Unnamed H: "Hydrogen moves from C4 to C3", "proton transfer from C1 to N6".
  each(`(?:hydrogen|proton|\\bH\\b)(?:\\s+${TRANSFER_VERB})?\\s+from\\s+${A}\\s+to\\s+${A}`, (m) => someHMoved(m[1], m[2]));
  // "N6 accepts a proton from C1" / "from H6".
  each(`${A}\\s+accepts\\s+(?:a\\s+)?(?:proton|hydrogen)\\s+from\\s+${A}`, (m) =>
    isH(m[2]) ? isFormed(m[1], m[2]) : someHMoved(m[2], m[1]),
  );
  // "H7 transfers to C2".
  each(`${A}\\s+${TRANSFER_VERB}\\s+to\\s+${A}`, (m) => isFormed(m[1], m[2]));
  // Swaps: "X swaps A for B", "X exchanges bonding partner from A to B".
  each(`${A}\\s+(?:swaps|exchanges|switches|trades)\\s+(?:its\\s+)?(?:bonding\\s+)?(?:partners?\\s+)?(?:from\\s+)?${A}\\s+(?:for|to|with)\\s+${A}`, (m) =>
    isBroken(m[1], m[2]) && isFormed(m[1], m[3]),
  );
  // "X and Y form H2 / a bond".
  each(`${A}\\s+and\\s+${A}\\s+form\\s+(?:H2|an?\\s+(?:new\\s+)?bond|a\\s+molecule)`, (m) => isFormed(m[1], m[2]));
  // "X binds to Y", "X bonds C4", "X forms (new) bond(s) with A and B".
  each(`${A}\\s+(?:binds|bonds)\\s+(?:to\\s+|with\\s+)?${A}`, (m) => isFormed(m[1], m[2]));
  for (const m of label.matchAll(new RegExp(`${A}\\s+forms?\\s+(?:an?\\s+)?(?:new\\s+)?bonds?\\s+(?:to|with)\\s+(${A.slice(1, -1)}(?:\\s+and\\s+${A.slice(1, -1)})*)`, "gi"))) {
    for (const partner of list(m[2])) claim(Object.assign([`${m[1]} forms bond with ${partner}`], { index: m.index! }) as RegExpMatchArray, isFormed(m[1], partner));
    consumed.push([m.index!, m.index! + m[0].length]);
  }
  // "X breaks its bond(s) with Y (and Z)" and "..., breaking its/their bond(s) with Y".
  for (const m of label.matchAll(new RegExp(`(?:${A}\\s+)?(?:breaks|breaking|loses|losing)\\s+(?:its|their)\\s+bonds?\\s+(?:to|with)\\s+(${A.slice(1, -1)}(?:\\s+and\\s+${A.slice(1, -1)})*)`, "gi"))) {
    const subjects = m[1] ? [m[1]] : list(label.slice(0, m.index!).split(/[.;]/).pop() ?? "").slice(0, /their/i.test(m[0]) ? 2 : 1);
    for (const partner of list(m[2])) {
      for (const s of subjects) claim(Object.assign([`${s} breaks bond with ${partner}`], { index: m.index! }) as RegExpMatchArray, isBroken(s, partner));
    }
    consumed.push([m.index!, m.index! + m[0].length]);
  }

  // Remaining "A-B" pairs take the polarity of the nearest verb.
  const verbs = [...label.matchAll(/\b(break\w*|broken|cleav\w*|open\w*|dissociat\w*|los\w*|form\w*|clos\w*)/gi)].map((m) => ({
    at: m.index!,
    broken: !/^(form|clos)/i.test(m[1]),
    ing: /ing$/i.test(m[1]),
  }));
  const PAIR = String.raw`[A-Z][a-z]?\d+\s*-\s*[A-Z][a-z]?\d+`;
  for (const m of label.matchAll(new RegExp(`${A}${SEP}${A}`, "g"))) {
    if (consumed.some(([s, e]) => m.index! < e && m.index! + m[0].length > s)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    // Ring paths like "C1-C4-O5-C1" are not bond claims.
    if (/^\s*-\s*[A-Z][a-z]?\d+/.test(label.slice(end)) || /[A-Z][a-z]?\d+\s*-\s*$/.test(label.slice(0, start))) continue;
    const sentenceStart = Math.max(label.lastIndexOf(".", start), label.lastIndexOf(";", start));
    const clauseEnd = label.slice(end).search(/[,.;]/);
    const limit = clauseEnd < 0 ? label.length : end + clauseEnd;
    // Precedence: "A-B (bond) breaks" > "breaking (the) A-B, C-D and A-B"
    // > a later verb in the clause ("A-B and C-D break") > an earlier verb in the sentence.
    const following = verbs.find((v) => v.at >= end && /^\s*(?:bonds?\s+)?$/i.test(label.slice(end, v.at)));
    const preceding = [...verbs].reverse().find(
      // Only "-ing" verbs lead a list ("breaking A-B, C-D"); "A-B forms, C-D ..." doesn't.
      (v) => v.ing && v.at < start && v.at > sentenceStart &&
        new RegExp(`^\\w*\\s*(?:(?:the|a|an|new|bonds?|and|,|\\s|${PAIR})\\s*)*$`, "i").test(label.slice(v.at, start)),
    );
    const verb =
      following ??
      preceding ??
      verbs.find((v) => v.at >= end && v.at < limit) ??
      [...verbs].reverse().find((v) => v.at < start && v.at > sentenceStart) ??
      verbs.find((v) => v.at >= end);
    if (!verb) continue;
    claim(m, verb.broken ? isBroken(m[1], m[2]) : isFormed(m[1], m[2]));
  }
  return result;
}
