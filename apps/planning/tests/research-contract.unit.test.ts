import assert from "node:assert/strict";
import test from "node:test";
import { researchBrief, researchConclusion, validateResearchResult } from "../src/server/research-contract";
const brief = researchBrief.parse({ question: "Can competitor X run offline?", decision: "Whether to investigate interoperability", owner: "Product owner", scope: ["Published product documentation"], exclusions: ["Contacting vendors"], stoppingCriteria: ["Official source found or timebox exhausted"], timeboxMinutes: 30, successMeasure: "A cited answer within 30 minutes" });
const conclusion = researchConclusion.parse({ outcome: "supported", conclusion: "Documentation describes offline operation", stopReason: "Official source found", elapsedMinutes: 12, artifacts: [{ title: "Report", url: "https://example.test/report" }] });
const invalid = (error: unknown) => error instanceof Response && error.status === 422;
test("bounded brief requires explicit bounds, owner and measurable success", () => {
  assert.equal(researchBrief.safeParse({ ...brief, stoppingCriteria: [] }).success, false);
  assert.equal(researchBrief.safeParse({ ...brief, timeboxMinutes: 0 }).success, false);
  assert.equal(researchBrief.safeParse({ ...brief, successMeasure: " " }).success, false);
  assert.equal(researchConclusion.safeParse({ ...conclusion, artifacts: [{ title: "Local", url: "file:///secret" }] }).success, false);
});
test("new research needs a conclusion, evidence for claims and gaps for uncertainty", () => {
  assert.throws(() => validateResearchResult(brief, { sources: [], gaps: [] }), invalid);
  for (const outcome of ["supported", "rejected"] as const) {
    assert.throws(() => validateResearchResult(brief, { research: { ...conclusion, outcome }, sources: [], gaps: [] }), invalid);
    validateResearchResult(brief, { research: { ...conclusion, outcome }, sources: [{}], gaps: [] });
  }
  for (const outcome of ["inconclusive", "blocked"] as const) {
    assert.throws(() => validateResearchResult(brief, { research: { ...conclusion, outcome }, sources: [], gaps: [] }), invalid);
    validateResearchResult(brief, { research: { ...conclusion, outcome }, sources: [], gaps: ["Public documentation unavailable"] });
  }
  validateResearchResult(undefined, { sources: [], gaps: [] });
});
