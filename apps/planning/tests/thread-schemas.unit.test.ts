import assert from "node:assert/strict";
import test from "node:test";
import { threadOperations, threadTypeDescriptor } from "@ai-outfitter/app-sdk/threads";
import { claimKey, pageClaim, planningThreadTypes, projectContext } from "../src/server/conversations";

test("Planning publishes discoverable schemas for its contexts and page-claim metadata", () => {
  const [type] = planningThreadTypes;
  assert.equal(threadTypeDescriptor.safeParse(type).success, true);
  // What a threads.types caller receives from this provider.
  const [published] = threadOperations["threads.types"].output.parse([{ ...type, installationId: "planning" }]);
  assert.deepEqual(published.schemas?.map((schema) => `${schema.kind}:${schema.name}@${schema.version}`),
    ["context:planning.videos@1", `context:${projectContext}@1`, "context:planning.products@1", "context:planning.intake@1", `metadata:${claimKey}@1`]);
  const claim = published.schemas?.find((schema) => schema.name === claimKey)?.schema as { properties?: Record<string, unknown> };
  assert.ok(claim.properties?.focus, "the claim schema is generated from Planning's own validator");
  assert.equal(pageClaim.safeParse({ focus: { kind: "planning-project", id: crypto.randomUUID(), label: "P", revision: 1 } }).success, true);
});
