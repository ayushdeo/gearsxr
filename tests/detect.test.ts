// The bundled example (four Transition1x reactions side by side) must keep
// giving the four events the demo walks through.

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBondEvents } from "../src/chapterDetect";
import { loadXyz } from "./helpers";

test("example-reactions.xyz gives its four reactions", async () => {
  const t = await loadXyz("public/samples/example-reactions.xyz");
  const events = detectBondEvents(t).map((e) => [e.startFrame, e.endFrame, e.category, e.label]);
  assert.deepEqual(events, [
    [15, 23, "proton-transfer", "H11 moves from C4 to O0"],
    [27, 38, "ligand-exchange", "C14 swaps N15 for O17"],
    [44, 47, "ring-change", "C24–N29 and C25–C28 form, C24–C25 breaks"],
    [55, 63, "h2-elimination", "H44 and H45 form H2 (2 bonds break)"],
  ]);
});
