import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { cases } from "../evals/daily-brief/cases";
import { grade } from "../evals/daily-brief/grade";
import { answerSchema, gatherEvidence } from "../src/server/daily-brief-synthesis";

const find = (id: string) => cases.find(item => item.id === id) ?? assert.fail(id);
const refs = (id: string) => Object.fromEntries(gatherEvidence(find(id).inputs).evidence.map(row => [row.label, row.ref]));

test("every eval morning has evidence and a schema a strict provider accepts", () => {
  for (const item of cases) {
    const { evidence } = gatherEvidence(item.inputs);
    assert.ok(evidence.length, item.id);
    // A morning with no goals once produced `not: {}`, which strict JSON Schema output refuses.
    assert.doesNotMatch(JSON.stringify(z.toJSONSchema(answerSchema(evidence))), /"not":/, item.id);
  }
});

test("the grader passes an honest brief and names what a poor one gets wrong", async () => {
  const ref = refs("full-day");
  const due = ref["Priority: Send Brightline the pricing proposal"], done = ref["Completed: Send Tidewater the pilot agreement"], goal = ref["Goal: Sign three design partners by December"];
  const good = {
    opening: { text: "Today is about getting Brightline the pricing proposal they asked for.", evidence: [due] },
    highlights: [{ text: "The Tidewater pilot agreement went out yesterday.", kind: "fact", evidence: [done] }],
    attention: [{ text: "Send Brightline the pricing proposal", why: "It is due today and they are waiting.", evidence: [due], goal }],
    unsupported: [],
  };
  const passed = await grade(find("full-day"), good);
  assert.equal(passed.pass, true, JSON.stringify(passed.checks));
  assert.match(passed.document ?? "", /## Sources/);

  const failed = async (answer: unknown) => (await grade(find("full-day"), answer)).checks.filter(check => !check.pass).map(check => check.name);
  assert.deepEqual(await failed({ ...good, opening: { text: "Hello", evidence: ["p99"] } }), ["contract"]);
  assert.deepEqual(await failed({ ...good, highlights: [{ text: "Signups rose 37% yesterday.", kind: "fact", evidence: [due] }], attention: [{ ...good.attention[0], evidence: [ref["Priority: Renew the team's design tool licence"]], goal: null }] }),
    ["points-at-what-is-due", "says-what-got-done", "ties-work-to-a-goal", "no-invented-numbers"]);

  const quiet = refs("missing-report");
  const missing = await grade(find("missing-report"), {
    opening: { text: "Northwind was quiet yesterday, so focus on the deploy work.", evidence: [quiet["Priority: Profile the slowest deploy step"]] },
    highlights: [{ text: "Deploys take 14 minutes after the build cache landed.", kind: "fact", evidence: [quiet["Cedar Works daily report for 2026-11-15"]] }],
    attention: [{ text: "Write the Northwind incident review", why: "It is due today.", evidence: [quiet["Priority: Write the Northwind incident review"]], goal: null }],
    unsupported: [],
  });
  assert.deepEqual(missing.checks.filter(check => !check.pass).map(check => check.name), ["no-unsupported-claims"]);
});
