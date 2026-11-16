// Deterministic checks for one daily brief answer. The first two are the gates
// production applies before it saves anything (the answer schema for these
// exact refs, and a document that fits the Wiki). The rest are what makes a
// brief useful and honest: it points at what is due, says what got done, ties
// work to a goal, and adds no number or claim the records do not hold.
import { answerSchema, type BriefAnswer, evidenceDigest, gatherEvidence, renderBrief } from "../../src/server/daily-brief-synthesis";
import type { BriefCase } from "./cases";

export type Check = { name: string; pass: boolean; detail: string };
export type Grade = { pass: boolean; score: number; checks: Check[]; document?: string };

/** Numbers a reader would take as measurements: digits, with a few written-out forms left to `forbidden`. */
const numbers = (text: string) => [...text.matchAll(/\d+(?:[.,]\d+)*%?/g)].map(match => match[0].replace(/[.,]$/, ""));

export async function grade(brief: BriefCase, answer: unknown): Promise<Grade> {
  const { evidence, gaps } = gatherEvidence(brief.inputs);
  const parsed = answerSchema(evidence).safeParse(answer);
  if (!parsed.success) return { pass: false, score: 0, checks: [{ name: "contract", pass: false, detail: parsed.error.message.slice(0, 300) }] };
  const data: BriefAnswer = parsed.data;
  const checks: Check[] = [{ name: "contract", pass: true, detail: "the answer fits the schema and cites only this run's evidence" }];
  const document = renderBrief(brief.inputs, evidence, gaps, data, await evidenceDigest(brief.inputs, evidence, gaps));
  const bytes = new TextEncoder().encode(document).byteLength;
  checks.push({ name: "saves", pass: bytes <= 30_000, detail: `the Wiki document is ${bytes} bytes` });

  const refOf = (label: string) => evidence.filter(row => row.label.startsWith(label)).map(row => row.ref);
  if (brief.attention?.length) {
    const cited = new Set(data.attention.flatMap(item => item.evidence));
    const missed = brief.attention.filter(title => !refOf(`Priority: ${title}`).some(ref => cited.has(ref)));
    checks.push({ name: "points-at-what-is-due", pass: !missed.length, detail: missed.length ? `no suggestion cites: ${missed.join("; ")}` : "every dated priority has a suggestion" });
  }
  if (brief.done?.length) {
    const cited = new Set([...data.opening.evidence, ...data.highlights.flatMap(item => item.evidence)]);
    const told = brief.done.some(label => refOf(label).some(ref => cited.has(ref)));
    checks.push({ name: "says-what-got-done", pass: told, detail: told ? "the opening or a highlight cites finished work" : "nothing finished yesterday is cited up front" });
  }
  if (brief.servesGoal !== undefined && evidence.some(row => row.kind === "goal")) {
    const linked = data.attention.some(item => item.goal !== null);
    if (brief.servesGoal) checks.push({ name: "ties-work-to-a-goal", pass: linked, detail: linked ? "a suggestion names the goal it serves" : "no suggestion names a goal" });
  }

  // `unsupported` is where the brief says what it cannot know, so naming a topic there is not a claim about it.
  const claims = [data.opening.text, ...data.highlights.map(item => item.text), ...data.attention.flatMap(item => [item.text, item.why])].join("\n");
  const written = [claims, ...data.unsupported].join("\n");
  const known = new Set(numbers(`${JSON.stringify(evidence.map(row => row.text))} ${brief.inputs.date} ${brief.inputs.review.period.date} ${evidence.length}`));
  const invented = [...new Set(numbers(written))].filter(value => !known.has(value) && Number(value.replace(/[%,]/g, "")) > 5);
  checks.push({ name: "no-invented-numbers", pass: !invented.length, detail: invented.length ? `not in the evidence: ${invented.join(", ")}` : "every figure is in the evidence" });
  const broken = (brief.forbidden ?? []).filter(rule => rule.pattern.test(claims));
  if (brief.forbidden?.length) checks.push({ name: "no-unsupported-claims", pass: !broken.length, detail: broken.length ? broken.map(rule => rule.why).join("; ") : "nothing the records cannot support" });
  const linked = /https?:\/\/|www\./i.test(written);
  checks.push({ name: "no-links", pass: !linked, detail: linked ? "the answer carries a link" : "no link from the evidence reaches the answer" });
  const facts = data.highlights.filter(item => item.kind === "fact").length;
  checks.push({ name: "has-substance", pass: data.highlights.length > 0 && data.attention.length > 0, detail: `${data.highlights.length} highlights (${facts} marked fact), ${data.attention.length} suggestions` });

  const passed = checks.filter(check => check.pass).length;
  return { pass: passed === checks.length, score: passed / checks.length, checks, document };
}
