import assert from "node:assert/strict";
import test from "node:test";
import { demoGraph } from "../fixtures/graph";
import { core } from "../src/lib/graph";
import { organizationDuplicates } from "../src/server/organization-duplicates";

const existing = { ...demoGraph.nodes[0], id: crypto.randomUUID(), typeId: core.organization, archived: false,
  title: "Artera", slug: "artera", website: "https://outfitter.ncrmro.com/o/artera", properties: {} };
const citation = { provider: "gmail", recordId: "fixture@artera.space/thread" };
function review(title: string, evidence: unknown[] = [], attrs: Record<string, unknown> = {}, nodes = [existing]) {
  return organizationDuplicates({ ...demoGraph, nodes }, [{
    ref: "$org", state: "pending", evidence, operation: { type: "graph-node", operation: "create",
      attributes: { typeId: core.organization, title, ...attrs } },
  }]);
}

test("match normalized names, saved slugs and exact organization domains", () => {
  assert.equal(review("  ARTERA! ")[0].organizationCandidates?.[0].id, existing.id);
  assert.equal(review("old-name", [], {}, [{ ...existing, slug: "old-name" }]).length, 1);
  assert.equal(review("Different trading name", [], { website: "https://WWW.artera.space/" },
    [{ ...existing, website: "https://artera.space/" }]).length, 1);
  assert.equal(review("Artera Space", [citation])[0].organizationCandidates?.[0].id, existing.id);
});

test("an ambiguous lookup presents candidates for review without choosing an ID", () => {
  const other = {...existing, id: crypto.randomUUID(), title: "Artera Space"};
  const [found] = review("Artera Space", [citation], {}, [existing, other]);
  assert.deepEqual(found.organizationCandidates?.map(c=>c.id), [existing.id,other.id]);
  assert.match(found.message,/2 possible/);
  assert.ok(!found.fix?.includes(existing.id) && !found.fix?.includes(other.id));
});

test("shared hosts, unrelated citations, lookalikes, inactive nodes and self matches do not resolve", () => {
  assert.deepEqual(review("Another company", [citation], {website:"https://outfitter.ncrmro.com/o/another"}), []);
  assert.deepEqual(review("Artera Space", [{...citation,recordId:"other@gmail.com/id",quote:"contact foo@artera.space"}]), []);
  assert.deepEqual(review("Artera Space", [{...citation,provider:"github"}]), []);
  assert.deepEqual(review("Artera Space", [{...citation,recordId:"someone@artera.space.evil.test/id"}]), []);
  assert.deepEqual(review("Artera Research", [citation]), []);
  assert.deepEqual(review("Artera", [], {}, [{...existing,archived:true}]), []);
  assert.deepEqual(review("Artera", [], {}, [{...existing,typeId:core.person}]), []);
  assert.deepEqual(review("Artera", [], {id:existing.id}), []);
});
