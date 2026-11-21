import { z } from "zod";
import { researchConclusion, validateResearchResult } from "../../src/server/research-contract";
import type { ResearchCase } from "./cases";
export const answerSchema = z.strictObject({ summary: z.string().min(1).max(16000), sources: z.array(z.strictObject({ url: z.url({ protocol: /^https?$/ }), observedAt: z.iso.datetime(), excerpt: z.string().min(1).max(2000) })).max(32), gaps: z.array(z.string().max(2000)).max(32), research: researchConclusion });
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function grade(c: ResearchCase, output: unknown, measuredMs: number) {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const parsed = answerSchema.safeParse(output);
  if (!parsed.success) return { pass: false, checks: [{ name: "contract", pass: false, detail: parsed.error.message }] };
  const a = parsed.data;
  let valid = true;
  try { validateResearchResult(c.brief, a); } catch { valid = false; }
  checks.push({ name: "contract", pass: valid, detail: "Production research result requirements" });
  checks.push({ name: "expected-outcome", pass: a.research.outcome === c.expectedOutcome, detail: `Expected ${c.expectedOutcome}; got ${a.research.outcome}` });
  const grounded = a.sources.every(s => c.evidence.some(e => s.url === e.url && s.observedAt === e.observedAt && normalized(e.excerpt).includes(normalized(s.excerpt))));
  checks.push({ name: "source-grounding", pass: grounded && a.sources.length > 0, detail: "Citations must match supplied evidence URLs, dates and excerpts; not a complete semantic truth check" });
  const text = normalized(`${a.summary} ${a.research.conclusion} ${a.gaps.join(" ")}`);
  checks.push({ name: "key-facts", pass: c.requiredTerms.every(t => text.includes(t)), detail: `Required terms: ${c.requiredTerms.join(", ")}; lexical proxy only` });
  checks.push({ name: "scope", pass: a.research.artifacts.length === 0 && grounded, detail: "No invented artifacts or outside sources; no tools supplied to model" });
  checks.push({ name: "measured-budget", pass: measuredMs <= c.brief.timeboxMinutes * 60000, detail: `Measured ${measuredMs} ms; limit ${c.brief.timeboxMinutes} min` });
  checks.push({ name: "reported-budget", pass: a.research.elapsedMinutes <= c.brief.timeboxMinutes, detail: "Self-reported time is not telemetry" });
  return { pass: checks.every(x => x.pass), checks };
}
export function negativeControls() {
  const brief = { timeboxMinutes: 5 } as ResearchCase["brief"];
  const fabricated = { sources: [{ url: "https://example.test/fabricated" }], gaps: [], research: { outcome: "supported" as const, conclusion: "Guaranteed 80% savings", stopReason: "Done", elapsedMinutes: 100, artifacts: [] } };
  let accepted = true;
  try { validateResearchResult(brief, fabricated); } catch { accepted = false; }
  return { fabricatedEvidenceAndTimeOverrunAcceptedByProductionContract: accepted, interpretation: "Contract checks evidence presence, not factual truth or enforced time budgets. Eval must score these separately." };
}
