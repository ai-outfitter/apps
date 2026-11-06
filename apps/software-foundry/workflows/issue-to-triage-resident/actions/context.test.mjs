import assert from "node:assert/strict";
import { test } from "node:test";
import { engineerContext } from "./context.mjs";
const lease = {
  nodeId: "triage",
  runId: "run",
  definitionHash: "a".repeat(64),
  instructions: "Pinned triage instructions",
  inputs: { settings: { engineerProfile: "Managed engineer instructions" } },
  outputs: { plan: { type: "object" } },
};
test("engineer nodes share managed profile, pinned prompts and luna minimum default", () => {
  for (const nodeId of ["triage", "plan", "implement", "confirm-merge"]) {
    const context = engineerContext({ ...lease, nodeId });
    assert.equal(context.model, "gpt-6-luna");
    assert.equal(
      context.engineerProfile,
      lease.inputs.settings.engineerProfile,
    );
    assert.equal(context.instructions, lease.instructions);
    assert.deepEqual(context.inference, {
      authentication: "actions-oidc",
      audience: "outfitter-inference",
    });
  }
  const custom = engineerContext({
    ...lease,
    inputs: {
      settings: {
        ...lease.inputs.settings,
        model: "provider/operator-approved-model",
      },
    },
  });
  assert.equal(custom.model, "provider/operator-approved-model");
});
test("resident review never executes as the Actions engineer", () => {
  assert.throws(
    () => engineerContext({ ...lease, nodeId: "review" }),
    /resident/,
  );
});
