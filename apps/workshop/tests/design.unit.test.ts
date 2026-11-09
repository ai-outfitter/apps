// The design agent's contract with the model: the answer schema the host
// validates against, the data it sends, and how an answer becomes a revision.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { makeProject } from "../src/lib/project";
import { answerSchema, designData, designedProject, parseAnswer } from "../src/model/design-answer";

const clip = { name: "Cable clip", rationale: "A block with a 12 mm hole.", plan: { version: 1, units: "mm", features: [
  { kind: "box", mode: "add", origin: [-30, -20, 0], size: [60, 40, 20] },
  { kind: "cylinder", mode: "cut", base: [0, 0, 0], radius: 6, height: 20, axis: "z" },
] } };

test("the answer schema the host validates against accepts a CAD plan and refuses what the contract refuses", () => {
  // The platform builds its validator from the JSON Schema the app sends.
  const host = z.fromJSONSchema(answerSchema as never);
  assert.equal(host.safeParse(clip).success, true);
  assert.equal(host.safeParse({ ...clip, plan: { ...clip.plan, features: [{ ...clip.plan.features[0], origin: [0, 0] }] } }).success, false);
  assert.equal(host.safeParse({ ...clip, extra: 1 }).success, false);
  assert.ok(JSON.stringify(answerSchema).length < 16 * 1024, "within the host's schema limit");
  // The app parses again under the CAD plan contract: a cut first is the model's error.
  assert.equal(parseAnswer(clip).plan.features.length, 2);
  assert.throws(() => parseAnswer({ ...clip, plan: { ...clip.plan, features: [clip.plan.features[1]] } }), (error) => error instanceof Response && error.status === 502);
});

test("a first request and a follow-up become the project's next revisions", () => {
  assert.deepEqual(designData("A cable clip"), { request: "A cable clip" });
  const first = designedProject("A cable clip", parseAnswer(clip), undefined);
  assert.deepEqual([first.name, first.revision, first.params.design, first.params.width, first.params.depth, first.params.height], ["Cable clip", 1, "custom", 60, 40, 20]);
  assert.equal(first.iterations.at(-1)?.prompt, "A cable clip");
  const data = designData("Make the hole 14 mm", first) as { currentModel: { plan: unknown }; priorMessages: unknown[]; followUp: string };
  assert.deepEqual([data.currentModel.plan, data.priorMessages.length, data.followUp], [first.cadPlan, 1, "Make the hole 14 mm"]);
  const next = designedProject("Make the hole 14 mm", parseAnswer({ ...clip, name: "Ignored" }), first);
  assert.deepEqual([next.name, next.revision, next.iterations.length], ["Cable clip", 2, 2]);
  // A preset project hands its starter shape to the model as a plan.
  assert.equal((designData("Taller", makeProject("holder")) as { currentModel: { plan: { features: unknown[] } } }).currentModel.plan.features.length, 2);
});
