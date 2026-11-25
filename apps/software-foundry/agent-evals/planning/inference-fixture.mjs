import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { dotted, repositories } from "./box-fixture.mjs";

const requests = JSON.parse(readFileSync(new URL("./fixtures/requests.json", import.meta.url)));
const citations = repositories.map(repo => `${repo}:README.md`);

function planFor(prompt) {
  const selected = ["ambiguous", "feature", "bug"].find((id) => prompt.includes(requests[id].title));
  assert.ok(selected, "inference received a named synthetic planning case");
  assert.match(prompt, /KEYSTONE_CHARTS_FIXTURE/);
  assert.match(prompt, /KEYSTONE_NATIVE_APPLE_FIXTURE/);
  if (dotted) {
    assert.match(prompt, /KEYSTONE_OS_FIXTURE/);
    assert.match(prompt, /KEYSTONE_SERVICES_FIXTURE/);
  }
  const bug = selected === "bug";
  const issueTemplate = bug ? null : ".forgejo/ISSUE_TEMPLATE/feature.md";
  if (issueTemplate) assert.ok(prompt.includes(issueTemplate), "anchor's issue template reaches inference");
  const scenario = requests[selected];
  const result = {
    kind: bug ? "bug" : "feature",
    title: scenario.title,
    goal: bug ? "Preserve Grafana datasource placeholders from preview through local install." :
      "Let operators preview and install a Grafana dashboard into the iOS and macOS Charts catalog.",
    changes: bug
      ? ["Carry the datasource placeholder through the shared Charts persistence model.", "Resolve the placeholder against the current installation on both app shells."]
      : ["Validate dashboard UID, title and panel list in shared Charts code.", "Use a confirmation screen in the iOS and macOS shells, then persist once by UID."],
    verification: scenario.acceptanceCriteria ?? [
      "Replay the planning request after Forgejo commits the issue and the response is lost.",
    ],
    gaps: ["This local fixture supplies synthetic source evidence. Validate the proposal on actual devices during implementation."],
    citations,
    issueTemplate,
    issueBody: issueTemplate
      ? "## User-visible outcome\n\nPreview and install a Grafana dashboard in Charts.\n\n## Acceptance criteria\n\nA UID is installed once after explicit confirmation.\n\n## Verification\n\nExercise preview, cancel, confirm, and invalid input on iOS and macOS."
      : null,
  };
  return { selected, result };
}

export async function startInferenceFixture() {
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, "Bearer local-planning-fixture");
      const input = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
      assert.equal(input.text?.format?.type, "json_schema", "Foundry uses structured inference");
      const { selected, result } = planFor(JSON.stringify(input.input));
      appendFileSync("/out/inference.jsonl", JSON.stringify({ case: selected, kind: result.kind, sources: citations }) + "\n");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: `fixture-${selected}`, created_at: 1, model: input.model,
        output: [{ type: "message", id: `message-${selected}`, role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] }],
        usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
      }));
    } catch (error) {
      console.error("Inference fixture:", error.message);
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(3303, "127.0.0.1");
  await once(server, "listening");
  return server;
}
