// Claim checker: each case is a label, the event's formed and broken bonds,
// and the expected "correct/claims" count. The cases come from real model
// labels on the Transition1x benchmark that the checker once misread.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClaims } from "../src/chapterClaims";

type P = [number, number];
const cases: Array<[string, P[], P[], string]> = [
  // [label, formed, broken, expected "correct/claims"]
  ["H9 moves from C4 to O5", [[5, 9]], [[4, 9]], "1/1"],
  ["H9 moves from C4 to N6", [[5, 9]], [[4, 9]], "0/1"],
  ["H8 from C3 to C4", [[4, 8]], [[3, 8]], "1/1"],
  ["H7 proton transfer from N0 to N2", [[2, 7]], [[0, 7]], "1/1"],
  ["Proton transfer: H7 from C1 to N6", [[6, 7]], [[1, 7]], "1/1"],
  ["Proton transfer from N1-H9 to C0, breaking N1-C0 and C2-C4 bonds.", [[0, 9]], [[1, 9], [0, 1], [2, 4]], "3/3"],
  ["Proton transfer from H9 on O4 to C1, breaking C1-C3 bonds.", [[1, 9]], [[4, 9], [1, 3]], "2/2"],
  ["Hydrogen moves from C4 to C3", [[3, 10]], [[4, 10]], "1/1"],
  ["O3 accepts a proton from H6, forming O3-H6. C2-O3 and C2-H8 break.", [[3, 6]], [[2, 3], [2, 8]], "4/4"],
  ["N6 accepts a proton from C1, forming N6-H7.", [[6, 7]], [[1, 7]], "2/2"],
  ["C2 exchanges bonding partner from C1 to O0", [[0, 2]], [[1, 2]], "1/1"],
  ["N1 swaps C0 for C2", [[0, 3]], [[0, 1], [2, 3]], "0/1"],
  ["H7 and H8 form a bond, breaking their bonds with C2", [[7, 8]], [[2, 7], [2, 8]], "3/3"],
  ["C1 forms bonds with O3 and N0, C2 forms bond with N0, breaking C2-O3", [[1, 3], [0, 1], [0, 2]], [[2, 3]], "4/4"],
  ["O0 bonds C4, C1-C4 and O0-C1 break", [[0, 4]], [[1, 4], [0, 1]], "3/3"],
  ["O2 breaks its bond with C3.", [], [[2, 3]], "1/1"],
  ["C0-C3 bond closes a 4-membered ring", [[0, 3]], [], "1/1"],
  ["H7 transfers to C2", [[2, 7]], [[0, 7]], "1/1"],
  ["H11 transfer C4 → N6", [[6, 11]], [[4, 11]], "1/1"],
  ["H8 transfers from C1 to O5, forming O5-H8 and breaking C1-H8", [[5, 8]], [[1, 8]], "3/3"],
  ["H9 transfers from C5 to N1, breaking C5-H9 and forming N1-H9", [[1, 9]], [[5, 9]], "3/3"],
  ["O5-H6 forms, N3-O5 breaks", [[5, 6]], [[3, 5]], "2/2"],
  ["C0 transfers H7 to C1", [[1, 7]], [[0, 7]], "1/1"],
  ["C1 transfers a proton to C6, breaking C1-H8 and forming C6-H8", [[6, 8]], [[1, 8]], "3/3"],
  ["Ring forms: C1-C4-O5-C1", [[1, 4]], [], "0/0"],
  ["breaking C1-C3, C2-C4 and N1-O2", [], [[1, 3], [2, 4], [1, 2]], "3/3"],
  ["C4-H10 bond forms, C4-C5 and C5-H10 break", [[4, 10]], [[4, 5], [5, 10]], "3/3"],
];

for (const [label, formed, broken, want] of cases) {
  test(`claims: ${label}`, () => {
    const r = checkClaims(label, formed, broken);
    assert.equal(`${r.correct}/${r.claims}`, want, `wrong: ${r.wrong.join("; ")}`);
  });
}

test("a label with no atom names is vague", () => {
  assert.equal(checkClaims("Nitrogen gains hydrogen, loses carbon bond", [], []).vague, true);
});
