import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
const endpoint = process.env.SPARK_BASE_URL;
assert.ok(out && endpoint, "Usage: SPARK_BASE_URL=<local v1 endpoint> node spark-agent.mjs <new output directory>");
mkdirSync(out);
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const fixtures = new URL("fixtures/", import.meta.url);
const repos = Object.fromEntries(["charts", "ks-config", "native-apple", "os"].map(name =>
  ["box/" + name, { "README.md": name + ".md" }]));
Object.assign(repos["box/native-apple"], {
  ".forgejo/ISSUE_TEMPLATE/feature.md": "feature-template.md",
  ".forgejo/ISSUE_TEMPLATE/bug.md": "bug-template.md",
});
const tools = ["list_files", "read_file"].map(name => ({
  type: "function", function: { name, description: name === "list_files" ? "List tracked files of a scoped repository." : "Read a tracked file.",
    parameters: { type: "object", properties: { repository: { type: "string", enum: Object.keys(repos) },
      ...(name === "read_file" ? { path: { type: "string" } } : {}) },
      required: name === "read_file" ? ["repository", "path"] : ["repository"], additionalProperties: false } },
}));
const messages = [
  { role: "system", content: "You are Keystone's planning agent. Inspect the available repository evidence. Independently propose the work, its dependencies, and milestones. Distinguish observed facts from proposed changes and gaps. Return a JSON object with goal, requirements (each with key, title, statement, acceptanceCriteria string array, dependsOn key array, target object with repository), milestones (each with title and a keys array), citations (repository:path strings) and gaps (strings). Choose the number and content yourself." },
  { role: "user", content: "I want to install Forgejo and Grafana from the Keystone iOS and macOS apps and get the standard Grafana dashboards. Plan this feature. Your repositories are " + Object.keys(repos).join(", ") + "." }
];
const models = await fetch(endpoint + "/models").then(r => r.json());
const model = process.env.SPARK_MODEL || models.data[0].id;
const trace = { model, startedAt: new Date().toISOString(), prompt: [...messages], tools, turns: [] };
const started = Date.now();
for (let turn = 0; turn < 28; turn++) {
  const response = await fetch(endpoint + "/chat/completions", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages, tools, temperature: 0, max_tokens: 8192,
      chat_template_kwargs: { enable_thinking: false } }), signal: AbortSignal.timeout(600000) });
  assert.ok(response.ok, "Spark HTTP " + response.status);
  const body = await response.json();
  const { message, finish_reason } = body.choices[0];
  const { content, tool_calls } = message;
  messages.push({ role: "assistant", content, ...(tool_calls?.length && { tool_calls }) });
  const receipt = { model: body.model, finish_reason, usage: body.usage, content, calls: [] };
  trace.turns.push(receipt);
  for (const call of tool_calls ?? []) {
    let result;
    try {
      const { repository, path } = JSON.parse(call.function.arguments);
      assert.ok(Object.hasOwn(repos, repository));
      if (call.function.name === "list_files") result = Object.keys(repos[repository]);
      else {
        assert.ok(call.function.name === "read_file" && Object.hasOwn(repos[repository], path));
        result = readFileSync(new URL(repos[repository][path], fixtures), "utf8");
      }
    } catch { result = { error: "Unknown operation, repository or path" }; }
    receipt.calls.push({ name: call.function.name, arguments: call.function.arguments, result });
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
  trace.wallSeconds = (Date.now() - started) / 1000;
  save("trace.json", trace);
  if (!tool_calls?.length) {
    writeFileSync(join(out, "completion.txt"), content ?? "");
    assert.equal(finish_reason, "stop");
    break;
  }
  assert.ok(turn < 27, "Agent reached turn limit");
}
