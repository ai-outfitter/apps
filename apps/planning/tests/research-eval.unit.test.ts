import assert from "node:assert/strict";
import test from "node:test";
import { cases } from "../evals/research/cases";
import { grade, negativeControls } from "../evals/research/grade";
function answer(index = 2) { const c = cases[index]; return { summary: "Offline inference follows the initial download.", sources: c.evidence, gaps: [], research: { outcome: c.expectedOutcome, conclusion: "Offline inference is supported after download.", stopReason: "Evidence sufficient", elapsedMinutes: 0.1, artifacts: [] } }; }
test("research eval accepts grounded offline answer", () => assert.equal(grade(cases[2], answer(), 1000).pass, true));
test("research eval rejects invented citations, wrong outcome, artifacts and overruns", () => {
  const a = answer();
  for (const change of [ { sources: [{ ...a.sources[0], url: "https://example.test/invented" }] }, { research: { ...a.research, outcome: "rejected" } }, { research: { ...a.research, artifacts: [{ title: "Invented", url: "https://example.test/report" }] } }, { research: { ...a.research, elapsedMinutes: 100 } } ]) assert.equal(grade(cases[2], { ...a, ...change }, 1000).pass, false);
  assert.equal(grade(cases[2], a, 300001).pass, false);
});
test("research eval requires grounded excerpts and schema", () => {
  assert.equal(grade(cases[2], {}, 1).pass, false);
  const a = answer(); assert.equal(grade(cases[2], { ...a, sources: [{ ...a.sources[0], excerpt: "Invented evidence" }] }, 1).pass, false);
});
test("research eval records contract limitation instead of hiding it", () => assert.equal(negativeControls().fabricatedEvidenceAndTimeOverrunAcceptedByProductionContract, true));
