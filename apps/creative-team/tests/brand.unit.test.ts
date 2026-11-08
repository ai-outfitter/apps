import assert from "node:assert/strict";
import test from "node:test";
import { brandQuestions, brandSections, childLevel, mapLevels } from "../src/lib/brand";
import { mapTree } from "../src/server/store";

test("the interview covers every section of the intellectual signature with unique question ids", () => {
  assert.deepEqual(brandSections.map((section) => section.title), [
    "Who you help", "Your story", "Who shaped your mind", "Pillars and perspective", "Mission and beliefs", "What you're against", "Why it matters now",
    "Where you're taking them", "Rules and words",
  ]);
  assert.equal(new Set(brandQuestions.map((question) => question.id)).size, brandQuestions.length);
  for (const question of brandQuestions) assert.ok(question.id.startsWith(`${question.section}.`), question.id);
});

test("the map has four levels and builds a tree in saved order", () => {
  assert.deepEqual(mapLevels.map((level) => childLevel[level]), ["topic", "idea", "angle", null]);
  const row = (id: string, parentId: string | null, level: string, position: number) =>
    ({ id, parentId, level, title: id, notes: "", research: "", position, revision: 1, updatedBy: null, createdAt: 0, updatedAt: 0 });
  const tree = mapTree([row("p", null, "pillar", 0), row("t2", "p", "topic", 1), row("t1", "p", "topic", 0), row("i", "t1", "idea", 0)]);
  assert.deepEqual(tree.map((node) => [node.id, node.children.map((child) => [child.id, child.children.map((item) => item.id)])]), [["p", [["t2", []], ["t1", ["i"]]]]]);
});
