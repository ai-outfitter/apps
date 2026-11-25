// Run from apps/onto with node --import tsx evals/submission-agent.ts baseline|candidate.
// The agent has only an HTTP catalog and public documents on a disposable worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import catalog from "../graph/documents.json";
import { appWorker } from "../tests/fixtures/initialized-worker";

const mode = process.argv[2];
assert.ok(mode === "baseline" || mode === "candidate");
const docNames = ["ChangeBatchChanges", "ChangeBatches", "BatchSubmission", ...(mode === "candidate" ? ["MutateBatchSubmission"] : [])];
const docs = catalog.filter(doc => docNames.includes(doc.name));
assert.equal(docs.length, docNames.length);
const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "bounded-eval");
const identity = { userId: "agent", role: "owner", organizationId: "eval", actor: { kind: "app" as const, id: "forerunner" } };
async function execute(doc: typeof catalog[number], variables: object) {
  const response = await app.call("/api/internal/actions/v1/call", identity, {
    method: "POST", body: { action: doc.kind === "mutation" ? "graph.mutate" : "graph.graphql",
      input: { query: doc.query, operationName: doc.name, variables } },
  });
  return response.json();
}
const calls: string[] = [];
const successfulWrites: string[] = [];
let discoveries = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  const name = req.url?.slice(1);
  if (!name && req.method === "GET") {
    discoveries++;
    return void send(docs.map(({ name, mcp }) => ({ name, description: mcp.description })));
  }
  const doc = docs.find(doc => doc.name === name);
  if (!doc) { res.statusCode = 404; return void send("Unknown public document"); }
  if (req.method === "GET") { discoveries++; return void send(doc.inputSchema); }
  if (req.method !== "POST" || calls.length >= 10) { res.statusCode = 429; return void send("Call limit reached"); }
  calls.push(doc.name);
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const variables = JSON.parse(Buffer.concat(chunks).toString());
    const result = await execute(doc, variables);
    if (doc.kind === "mutation" && !result.errors && !result.data?.changeBatchChanges?.items?.some((item: { error?: unknown }) => item.error))
      successfulWrites.push(JSON.stringify([doc.name, variables]));
    send(result);
  } catch (err) { res.statusCode = 400; send(String(err)); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const dir = await mkdtemp(join(tmpdir(), "onto-agent-"));
try {
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const prompt = `You have 180 seconds and ten document executions. Use only curl to ${url} from the shell. GET / lists public documents. GET /NAME gives the variables schema. POST /NAME takes JSON variables. Submit a member-review batch titled Field notes containing a single graph-node create proposal, ref $pilot, attributes typeId Person, title Ada Field, evidence [{provider:"meeting",recordId:"demo",quote:"Ada attended."}]. Do not approve. Replay the same submission as after a lost response; demonstrate one batch at version 1. Independently read saved state. Minimize calls; stop on success. Do not inspect files, code or use other services.`;
  const child = spawn("codex", ["exec", "--skip-git-repo-check", "-m", "gpt-6.2-sol", "-C", dir, "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", prompt], { stdio: ["ignore", "ignore", "inherit"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  try { await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); }); }
  finally { clearTimeout(timer); }
  const query = docs.find(doc => doc.name === "ChangeBatches")!;
  const result = await execute(query, { search: "Field notes", details: true });
  const rows = result.data.changeBatches.nodes;
  const row = rows[0];
  const passed = rows.length === 1 && row.submittedVersion === 1 && row.state === "awaiting_review" &&
    row.operations.length === 1 && row.operations[0].ref === "$pilot" && row.operations[0].operation.attributes.title === "Ada Field" &&
    row.operations[0].evidence[0]?.quote === "Ada attended." && calls.includes("ChangeBatches") &&
    new Set(successfulWrites).size < successfulWrites.length;
  console.log(JSON.stringify({ mode, passed, discoveries, calls, batchCount: rows.length, version: row?.submittedVersion }));
  assert.ok(passed);
} finally {
  server.close();
  await app.dispose();
  await rm(dir, { recursive: true, force: true });
}
