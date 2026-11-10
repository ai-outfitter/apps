import assert from "node:assert/strict";
import test from "node:test";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readOrganizationGoals } from "../src/server/organization-goals";

test("organization goals expose an incomplete Onto instead of treating it as empty", async () => {
  const host = workflowHost<"interactive">({ props: { workflowHost: {
    async call() { return { ok: false, status: 409, message: "The legacy Wiki must be migrated" }; },
  } } });
  await assert.rejects(readOrganizationGoals(host, { organizationId: "org" }),
    (error: unknown) => error instanceof Response && error.status === 409);
});
