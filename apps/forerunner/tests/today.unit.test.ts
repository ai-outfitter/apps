import assert from "node:assert/strict";
import test from "node:test";
import today from "../fixtures/forerunner-today.json" with { type: "json" };
import { type BoardItem, blocksFromBoard } from "../src/scripts/today-blocks";

test("the Today fixture is synthetic, versioned and links only inside the app", () => {
  assert.equal(today.fixture, 1);
  assert.equal(today.synthetic, true);
  const ids = today.blocks.flatMap((block) => [block.id, ...("items" in block ? (block.items ?? []).map((item) => item.id) : [])]);
  assert.equal(new Set(ids).size, ids.length, "stable ids are unique");
  assert.equal(today.blocks.filter((block) => block.kind === "now").length, 1, "one current block");
  for (const block of today.blocks) {
    assert.match(block.time, /^\d{1,2}:\d{2}$/);
    for (const href of [...("items" in block ? (block.items ?? []).map((item) => item.href) : []), ...("action" in block && block.action ? [block.action.href] : [])])
      assert.match(href, /^[a-z]+(\?.*)?$/, `${href} is a relative app link`);
  }
});

const item = (overrides: Partial<BoardItem> & Pick<BoardItem, "id" | "category" | "title">): BoardItem =>
  ({ dueDate: null, status: "todo", parentId: null, position: 0, ...overrides });

test("the operational timeline leads with what is in progress, then due, next steps, small tasks and review", () => {
  const items = [
    item({ id: "s1", category: "stone", title: "Ship the alpha", position: 0 }),
    item({ id: "s2", category: "stone", title: "Teach yoga", position: 1 }),
    item({ id: "p1", category: "pebble", title: "Fix the install bugs", parentId: "s1", status: "in-progress" }),
    item({ id: "p2", category: "pebble", title: "Write the recap", parentId: "s1", position: 1, dueDate: "2026-11-02" }),
    item({ id: "p3", category: "pebble", title: "Record class #4", parentId: "s2" }),
    item({ id: "p4", category: "pebble", title: "Already done", parentId: "s2", status: "done" }),
    item({ id: "g1", category: "sand", title: "Order the turkey" }),
  ];
  const blocks = blocksFromBoard(items, 14, "2026-11-03");
  assert.deepEqual(blocks.map((block) => block.id), ["now:p1", "batch:due", "batch:next", "batch:small"]);
  assert.equal(blocks[0].title, "Fix the install bugs");
  assert.equal(blocks[0].action?.href, "board?item=p1");
  assert.deepEqual(blocks[1].items?.map((entry) => [entry.id, entry.action]), [["p2", "Overdue"]]);
  assert.deepEqual(blocks[2].items?.map((entry) => entry.id), ["p3"], "p2 is due, so the next step for s1 is not repeated");
  assert.deepEqual(blocks[3].items?.map((entry) => entry.id), ["g1", "review:graph"]);
  assert.equal(blocks[3].items?.[1].title, "Approve 14 changes to your knowledge graph");
  assert.equal(blocks[3].items?.[1].href, "graph?status=pending");
});

test("an empty board with nothing waiting draws nothing, so the page shows its empty state", () => {
  assert.deepEqual(blocksFromBoard([], 0, "2026-11-03"), []);
  assert.deepEqual(blocksFromBoard([item({ id: "d", category: "stone", title: "Done", status: "done" })], 1, "2026-11-03").map((block) => block.id), ["batch:small"]);
});

test("the knowledge graph filter narrows by status, type and search together", async () => {
  const { filterEntities } = await import("../src/scripts/entities-filter");
  const base = { foundIn: ["Gmail"], links: 0, addedAt: "2026-11-03T08:00:00Z", runId: "r", wikiSlug: "wiki-map" };
  const entities = [
    { ...base, id: "a", title: "Jordan Blake", kind: "Person", status: "pending" as const },
    { ...base, id: "b", title: "Salon dinner", kind: "Event", status: "accepted" as const },
    { ...base, id: "c", title: "Jordan's loft", kind: "Place", status: "accepted" as const },
  ];
  assert.deepEqual(filterEntities(entities, "", "all", null).map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(filterEntities(entities, "jordan", "all", null).map((e) => e.id), ["a", "c"]);
  assert.deepEqual(filterEntities(entities, "jordan", "accepted", null).map((e) => e.id), ["c"]);
  assert.deepEqual(filterEntities(entities, "", "all", "Event").map((e) => e.id), ["b"]);
});

test("the daily run's open suggestions are a small task before the graph review, which stays last", () => {
  const [small] = blocksFromBoard([], 2, "2026-11-03", 3);
  assert.deepEqual(small.items?.map((entry) => [entry.id, entry.title, entry.href]), [
    ["review:suggestions", "Look at 3 suggestions", "workflows#suggestions"],
    ["review:graph", "Approve 2 changes to your knowledge graph", "graph?status=pending"],
  ]);
  assert.equal(blocksFromBoard([], 0, "2026-11-03", 1)[0].items?.[0].title, "Look at 1 suggestion");
});
