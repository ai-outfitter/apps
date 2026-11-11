import assert from "node:assert/strict";
import test from "node:test";
import { configureRepository } from "../scripts/configure-repository.mjs";

test("configure-repository approves then inspects the named repository", async () => {
  const sent: any[] = [];
  const request = async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const inspected = { repository: "ai-outfitter/apps", configurationValid: true, reviewer: { login: "vega-unsup" } };
    return Response.json(body.input.operation === "configure" ? { subscriptionId: "s1", repository: "ai-outfitter/apps" } : inspected);
  };
  const result = await configureRepository({ repository: "ai-outfitter/apps", gatewayToken: "t", request: request as never });
  assert.deepEqual(sent.map((body) => [body.organization, body.input.operation, body.input.repository]), [
    ["outfitter", "configure", "ai-outfitter/apps"],
    ["outfitter", "inspect", "ai-outfitter/apps"],
  ]);
  assert.equal(result.inspection.configurationValid, true);
});

test("configure-repository refuses an invalid read-back and a malformed name", async () => {
  const request = async () => Response.json({ configurationValid: false });
  await assert.rejects(configureRepository({ repository: "ai-outfitter/apps", gatewayToken: "t", request: request as never }), /not valid/);
  await assert.rejects(configureRepository({ repository: "apps", gatewayToken: "t", request: request as never }), /Usage/);
});
