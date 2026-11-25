// Run from apps/onto with node --import tsx evals/submission-agent.ts baseline|candidate.
// The agent has only an HTTP catalog and public documents on a disposable worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import catalog from "../graph/documents.json";
import baselineCatalog from "./fixtures/submission-baseline.json";
import { appWorker } from "../tests/fixtures/initialized-worker";

const mode = process.argv[2];
assert.ok(mode === "baseline" || mode === "candidate");
const docNames = ["ChangeBatchChanges", "ChangeBatches", "BatchSubmission", ...(mode === "candidate" ? ["MutateBatchSubmission"] : [])];
const armCatalog = mode === "baseline" ? baselineCatalog : catalog;
const docs = armCatalog.filter(doc => docNames.includes(doc.name));
assert.equal(docs.length, docNames.length);
const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "bounded-eval");
const identity = { userId: "agent", role: "owner", organizationId: "eval", actor: { kind: "app" as const, id: "forerunner" } };
async function execute(doc: Pick<typeof catalog[number], "name" | "kind" | "query">, variables: object) {
  const response = await app.call("/api/internal/actions/v1/call", identity, {
    method: "POST", body: { action: doc.kind === "mutation" ? "graph.mutate" : "graph.graphql",
      input: { query: doc.query, operationName: doc.name, variables } },
  });
  if (!response.ok) throw new Error(`Document returned HTTP ${response.status}`);
  return response.json();
}
const calls: string[] = [];
type BatchEvidence = { id: string; submittedVersion: number };
const submissions: { at: number; fingerprint: string; batch: BatchEvidence }[] = [];
const reads: { at: number; batches: BatchEvidence[] }[] = [];
const identifies = (row: BatchEvidence | undefined): row is BatchEvidence =>
  typeof row?.id === "string" && Number.isInteger(row.submittedVersion);
let discoveries = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  const name = req.url?.slice(1);
  if (!name && req.method === "GET") {
    discoveries++;
    return void send(docs.map(({ name, mcp }) => ({ name, description: mcp?.description })));
  }
  const doc = docs.find(doc => doc.name === name);
  if (!doc) { res.statusCode = 404; return void send("Unknown public document"); }
  if (req.method === "GET") { discoveries++; return void send(doc.inputSchema); }
  if (req.method !== "POST" || calls.length >= 10) { res.statusCode = 429; return void send("Call limit reached"); }
  const at = calls.push(doc.name);
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const variables = JSON.parse(Buffer.concat(chunks).toString());
    const result = await execute(doc, variables);
    if (!result.errors?.length) {
      const direct = result.data?.mutateBatchSubmission;
      if (doc.name === "MutateBatchSubmission" && identifies(direct))
        submissions.push({ at, fingerprint: canonicalActionValue(variables), batch: direct });
      if (doc.name === "ChangeBatchChanges") {
        const receipts = result.data?.changeBatchChanges?.items ?? [];
        for (const item of variables.input?.items ?? []) {
          if (item.action !== "submit") continue;
          const receipt = receipts.find((entry: { key: string }) => entry.key === item.key);
          if (receipt && !receipt.error && ["complete", "pending"].includes(receipt.status) && identifies(receipt.result))
            submissions.push({ at, fingerprint: canonicalActionValue(item), batch: receipt.result });
        }
      }
      const nodes = result.data?.changeBatches?.nodes;
      if (doc.name === "ChangeBatches" && Array.isArray(nodes))
        reads.push({ at, batches: nodes.filter(identifies) });
    }
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
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try { exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(timer); }
  const query = docs.find(doc => doc.name === "ChangeBatches")!;
  const result = await execute(query, { search: "Field notes", details: true });
  const rows = result.data.changeBatches.nodes;
  const row = rows[0];
  const sameBatch = (batch: BatchEvidence) => batch.id === row?.id && batch.submittedVersion === row?.submittedVersion;
  const replay = submissions.find((entry, i) => sameBatch(entry.batch) && submissions.slice(0, i).some(prior =>
    prior.at < entry.at && prior.fingerprint === entry.fingerprint && sameBatch(prior.batch)));
  const read = replay && reads.find(entry => entry.at > replay.at && entry.batches.some(sameBatch));
  const proposal = row?.operations[0];
  const evidence = proposal?.evidence[0];
  const passed = rows.length === 1 && row.submittedVersion === 1 && row.state === "awaiting_review" &&
    row.operations.length === 1 && proposal.state === "awaiting_review" && proposal.ref === "$pilot" &&
    proposal.operation.operation === "create" && proposal.operation.type === "graph-node" &&
    proposal.operation.attributes.typeId === "Person" && proposal.operation.attributes.title === "Ada Field" &&
    evidence?.provider === "meeting" && evidence.recordId === "demo" && evidence.quote === "Ada attended." && !!read;
  console.log(JSON.stringify({ mode, passed, discoveries, calls, batchCount: rows.length, version: row?.submittedVersion, exit,
    acceptedSubmissionCalls: submissions.map(entry => entry.at), replayCall: replay?.at, independentReadCall: read?.at }));
  assert.ok(passed);
} finally {
  server.close();
  await app.dispose();
  await rm(dir, { recursive: true, force: true });
}
