import assert from "node:assert/strict";
import test from "node:test";
import { partSchema, threadOperations, threadTypeDescriptor } from "@ai-outfitter/app-sdk/threads";
import { historyTypes, progressPart, runType } from "../src/server/history";

test("Foundry publishes the schema of its progress data part with its run history type", () => {
  for (const type of historyTypes) assert.equal(threadTypeDescriptor.safeParse(type).success, true, type.type);
  const published = threadOperations["threads.types"].output.parse(historyTypes.map((type) => ({ ...type, installationId: "foundry" })));
  const run = published.find((type) => type.type === runType);
  const schema = partSchema(run?.schemas, progressPart, 1);
  assert.ok(schema, "the progress part schema is published");
  assert.equal(schema.title, "Workspace progress (run creator only)");
  assert.deepEqual((schema.schema as { required: string[] }).required, ["workspace", "run", "toolCount", "tools", "observedAt"]);
});
