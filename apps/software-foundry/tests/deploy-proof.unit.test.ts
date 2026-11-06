import assert from "node:assert/strict";
import test from "node:test";
import { deployFoundryProof } from "../scripts/deploy-proof.mjs";

test("branch proof upgrades only the fixed installation and rejects mismatched or skipped receipts", async () => {
  const hash = "a".repeat(64);
  const receipt = {organization: "outfitter", template: "software-foundry", hash, mode: "operational", url: "https://software-foundry.outfitter.ai-outfitter.com", status: "deployed"};
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    assert.ok(options);
    calls++;
    assert.equal(url, "https://ai-outfitter.com/api/internal/app-upgrades/outfitter/software-foundry");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(JSON.parse(String(options.body)), {expectedHash: hash});
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer test-key");
    return Response.json(receipt);
  };
  assert.deepEqual(await deployFoundryProof(hash, {token: "test-key", request}), receipt);
  assert.equal(calls, 1);
  for (const changed of [{organization: "other"}, {template: "other"}, {hash: "b".repeat(64)}, {mode: "demo"}, {url: "https://other.example"}, {status: "skipped"}]) {
    await assert.rejects(deployFoundryProof(hash, {token: "test-key", request: async () => Response.json({...receipt, ...changed})}), /Unexpected Foundry upgrade receipt/);
  }
  await assert.rejects(deployFoundryProof(hash, {token: "test-key", request: async () => new Response("private upstream error", {status: 401})}), /HTTP 401/);
  await assert.rejects(deployFoundryProof("bad", {token: "test-key", request}), /Invalid Foundry package hash/);
  await assert.rejects(deployFoundryProof(hash, {token: "", request}), /Missing DEMO_DEPLOY_KEY/);
  assert.equal(calls, 1);
});
