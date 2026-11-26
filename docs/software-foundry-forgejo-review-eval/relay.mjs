import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

let candidateCommitted = false;
let draftPublished = false;
let refusedDraftRead = false;
let refusedReviewPreflight = false;
const draftReadCase = process.env.FOUNDRY_REVIEW_CASE === "draft-read-refusal";

const journal = entry => appendFileSync("/out/forgejo-requests.jsonl", JSON.stringify(entry) + "\n");

async function hold(path, status) {
  if (!existsSync("/out/provider-hold.json") || existsSync("/out/provider-held.json")) return;
  const rule = JSON.parse(readFileSync("/out/provider-hold.json", "utf8"));
  if (path !== rule.path || status !== 200) return;
  writeFileSync("/out/provider-held.json", JSON.stringify({ path, status }));
  const deadline = Date.now() + 45_000;
  while (!existsSync("/out/provider-release") && Date.now() < deadline) await sleep(40);
  if (!existsSync("/out/provider-release")) throw new Error("Fixture barrier timed out");
}

async function holdBefore(path) {
  if (!existsSync("/out/forgejo-hold-before.json") || existsSync("/out/forgejo-held-before")) return;
  const rule = JSON.parse(readFileSync("/out/forgejo-hold-before.json", "utf8"));
  if (path !== rule.path || (rule.requireCommit && !candidateCommitted)) return;
  if (rule.requireRun) {
    const { database, installationId, workflowId } = JSON.parse(readFileSync("/out/provider-context.json", "utf8"));
    const db = new DatabaseSync(database, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    try {
      if (!db.prepare("SELECT 1 FROM workflow_runs WHERE installationId = ? AND workflowId = ?").get(installationId, workflowId)) return;
    } finally { db.close(); }
  }
  writeFileSync("/out/forgejo-held-before", JSON.stringify({ path }));
  const deadline = Date.now() + 25_000;
  while (!existsSync("/out/forgejo-release-before") && Date.now() < deadline) await sleep(40);
  if (!existsSync("/out/forgejo-release-before")) throw new Error("Fixture barrier timed out");
}

export async function relay(incoming, outgoing) {
  const url = new URL(incoming.url, "http://127.0.0.1");
  const path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const method = incoming.method;
  const read = method === "GET" || method === "HEAD";
  const open = method === "POST" && path === "/api/v1/repos/box/review-fixture/pulls";
  const review = method === "POST" && /^\/api\/v1\/repos\/box\/review-fixture\/pulls\/\d+\/reviews$/.test(path);
  const git = method === "POST" && /^\/box\/review-fixture\.git\/git-(receive|upload)-pack$/.test(path);
  const setup = !existsSync("/out/fixture-ready") && (
    method === "POST" && (path === "/api/v1/orgs" || path === "/api/v1/orgs/box/repos") ||
    method === "PUT" && /^\/api\/v1\/repos\/box\/(?:review-fixture|grant-a|grant-b|grant-c|grant-d)\/collaborators\/(outfitter|reviewer)$/.test(path) ||
    method === "PATCH" && path === "/api/v1/repos/box/review-fixture"
  );
  const coordinator = method === "POST" && /^\/api\/v1\/repos\/box\/review-fixture\/(?:branches|contents)$/.test(path);
  const allowed = read || open || review || git || setup || coordinator;
  if (!allowed) {
    journal({ method, path, blocked: true });
    outgoing.writeHead(403).end("Fixture write refused");
    return;
  }
  if (draftReadCase && draftPublished && !refusedDraftRead && method === "GET" &&
      path === "/api/v1/repos/box/review-fixture/pulls") {
    refusedDraftRead = true;
    journal({ method, path, status: 403, injected: "generic-draft-read-refusal" });
    outgoing.writeHead(403).end("Fixture temporarily refuses draft reconciliation");
    return;
  }
  if (process.env.FOUNDRY_REVIEW_CASE === "review-not-sent" && !refusedReviewPreflight &&
      method === "GET" && /^\/api\/v1\/repos\/box\/review-fixture\/pulls\/\d+\/reviews$/.test(path)) {
    const reviewer = readFileSync(`${process.env.BOX_STATE ?? "/box"}/secrets/forgejo-reviewer-token`, "utf8").trim();
    if (incoming.headers.authorization === `token ${reviewer}`) {
      refusedReviewPreflight = true;
      journal({ method, path, status: 403, injected: "reviewer-preflight-refusal" });
      outgoing.writeHead(403).end("Fixture refuses the first reviewer preflight read");
      return;
    }
  }
  if (read) await holdBefore(path);
  const upstream = request({
    host: "127.0.0.1", port: 3301, path: incoming.url, method, headers: incoming.headers,
  }, async response => {
    try {
      if (read) await hold(path, response.statusCode);
    } catch {
      response.resume();
      outgoing.writeHead(504).end("Fixture barrier timed out");
      return;
    }
    if (coordinator && path.endsWith("/contents") && response.statusCode >= 200 && response.statusCode < 300)
      candidateCommitted = true;
    const success = response.statusCode >= 200 && response.statusCode < 300;
    if (open && success) draftPublished = true;
    const discard = success && ((draftReadCase && open) ||
      (existsSync("/out/drop-publication-responses") && (open || review || coordinator)));
    journal({ method, path, status: response.statusCode, ...(discard ? { dropped: true } : {}) });
    if (discard) {
      response.resume();
      outgoing.destroy();
      return;
    }
    outgoing.writeHead(response.statusCode, response.headers);
    await pipeline(response, outgoing).catch(() => {});
  });
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end(); });
  await pipeline(incoming, upstream).catch(() => upstream.destroy());
}
