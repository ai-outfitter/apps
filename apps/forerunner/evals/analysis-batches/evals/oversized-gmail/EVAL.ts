import { expect, test } from "vitest";
import { analysisBatches, type AnalysisInput } from "./src/analysis-batches";

const budget = 56 * 1024;
function input(count: number, text = "Long synthetic message. ".repeat(150)): AnalysisInput {
  return {
    evidence: [...Array.from({ length: count }, (_, i) => ({ ref: `e${i}`, title: `Message ${i}`, excerpt: text.slice(0, 3000) })), { ref: "operating-user", title: "Trusted identity", excerpt: "Synthetic User <user@example.test>" }],
    existing: Array.from({ length: 80 }, (_, i) => ({ id: `wiki-${i}`, name: `Candidate ${i}`, type: "Person" })),
    limits: "First 40 records. Do not infer from omitted content.",
  };
}
function check(original: AnalysisInput) {
  const snapshot = structuredClone(original);
  const batches = analysisBatches(original);
  expect(batches.length).toBeGreaterThan(0);
  for (const batch of batches) {
    expect(JSON.stringify(batch).length).toBeLessThanOrEqual(budget);
    expect(batch.existing).toEqual(original.existing);
    expect(batch.limits).toBe(original.limits);
    expect(batch.evidence.filter(e => e.ref === "operating-user")).toEqual(original.evidence.filter(e => e.ref === "operating-user"));
  }
  expect(batches.flatMap(b => b.evidence.filter(e => e.ref !== "operating-user"))).toEqual(original.evidence.filter(e => e.ref !== "operating-user"));
  expect(original).toEqual(snapshot);
  return batches;
}

test("40 full excerpts cross the old limit and are preserved in bounded requests", () => {
  const data = input(40);
  expect(JSON.stringify(data).length).toBeGreaterThan(65_536);
  expect(check(data)).toHaveLength(3);
});
test("serialized escaping and multibyte text are measured with complete context", () => {
  expect(check(input(40, '\\"\n😀'.repeat(800))).length).toBeGreaterThan(1);
});
test("small runs remain one call", () => { expect(check(input(1))).toHaveLength(1); });
test("a single oversized record or fixed context fails explicitly", () => {
  const record = input(1);
  record.evidence[0].excerpt = "x".repeat(budget);
  expect(() => analysisBatches(record)).toThrow(/record.*budget/i);
  const context = input(1);
  context.limits = "x".repeat(budget);
  expect(() => analysisBatches(context)).toThrow(/context.*budget/i);
});
