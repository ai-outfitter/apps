import assert from "node:assert/strict";
import test from "node:test";
import { demoGraph } from "../fixtures/graph";
import { core, validateProperties } from "../src/lib/graph";
import { graphBundle } from "../src/lib/graph-export";

test("types and exports retain identity and direction", () => {
  assert.equal(
    demoGraph.types.find((t) => t.id === core.person)?.name,
    "Person",
  );
  assert.equal(
    demoGraph.types.find((t) => t.id === core.project)?.name,
    "Project",
  );
  const bundle = graphBundle(demoGraph);
  const project = bundle.notes.find((n) => n.path.includes("Meze--"))!;
  assert.match(project.markdown, /uses:\n {2}- "\[\[Nodes\/Apple Health--/);
  assert.ok(
    bundle.notes.some(
      (n) =>
        n.path.startsWith("Relationships/") &&
        n.markdown.includes('property_status: "proposed"'),
    ),
  );
  const type = demoGraph.types.find((t) => t.id === core.uses)!;
  assert.throws(
    () => validateProperties(type, { not_defined: true }),
    /Unknown property/,
  );
});
