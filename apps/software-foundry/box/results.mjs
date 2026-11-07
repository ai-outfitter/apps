// Run results for the Foundry box. When a request's Foundry run ends, its
// result is written as a run-result document (ai-outfitter/apps:
// apps/software-foundry/box/schemas/run-result.schema.json), read from what the
// run left behind: the run's status, each node's reported outputs, and the
// issue, pull request, statuses and reviews on the box's Forgejo.

import { runMetrics, stepMetrics } from "../../../box/metrics.mjs";

const sha = /^[a-f0-9]{40}$/;
/** Workflow run statuses that end a run. */
export const terminal = new Set(["complete", "failed"]);

/** The newest reported result of each node of a run, from the gateway's run snapshots.
 * @param {any[]} snapshots
 * @param {string} runId
 * @returns {Record<string, { status?: string, error?: string, result?: any }>}
 */
export function nodeResults(snapshots, runId) {
  /** @type {Record<string, { status?: string, error?: string, result?: any }>} */
  const results = {};
  for (const snapshot of [...snapshots].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const match = /^Workflow ([a-f0-9-]{36}), node ([a-z0-9-]+)$/.exec(snapshot.prompt ?? "");
    if (match?.[1] !== runId) continue;
    results[match[2]] = { status: snapshot.status, error: snapshot.error, result: snapshot.result?.outputs?.result ?? snapshot.nodeOutput?.result };
  }
  return results;
}

/** Each node attempt of a run, in order, with its time and model calls (box/metrics.mjs).
 * @param {any[]} snapshots
 * @param {string} runId
 */
export function nodeSteps(snapshots, runId) {
  return [...snapshots].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).flatMap((snapshot) => {
    const match = /^Workflow ([a-f0-9-]{36}), node ([a-z0-9-]+)$/.exec(snapshot.prompt ?? "");
    if (match?.[1] !== runId) return [];
    // Pi counts cached prompt tokens apart from `input`; the prompt is all three.
    const calls = (snapshot.stages ?? []).flatMap((stage) => stage.session?.usage?.calls ?? []).map((call) => ({
      input: Number.isFinite(call.input) ? call.input + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0) : null,
      output: call.output ?? null }));
    return [stepMetrics({ name: match[2], status: snapshot.status, startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt, calls })];
  });
}

/** Each node attempt's pi session for a run, named by node (and attempt when a node ran more than once).
 * @param {any[]} snapshots gateway snapshots, each with its runtime run `id`
 * @param {string} runId
 * @param {(snapshotId: string) => string[]} files the session files a runtime run wrote
 * @param {(path: string) => any[]} read
 */
export function nodeSessions(snapshots, runId, files, read) {
  const attempts = {};
  return [...snapshots].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).flatMap((snapshot) => {
    const match = /^Workflow ([a-f0-9-]{36}), node ([a-z0-9-]+)$/.exec(snapshot.prompt ?? "");
    if (match?.[1] !== runId || !snapshot.id) return [];
    const attempt = (attempts[match[2]] = (attempts[match[2]] ?? 0) + 1);
    const entries = files(snapshot.id).flatMap(read);
    return entries.length ? [{ agent: attempt > 1 ? `${match[2]}-${attempt}` : match[2], entries }] : [];
  });
}

/** The pull request the run opened for the issue: the newest one that closes it. */
async function runPull(forgejo, repository, issueNumber) {
  const pulls = await forgejo("GET", `/repos/${repository}/pulls?state=all&limit=50`);
  const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
  return pulls.filter((pull) => closes.test(pull.body ?? "")).sort((a, b) => b.number - a.number)[0];
}

const changeKind = { added: "added", modified: "modified", changed: "modified", deleted: "deleted", removed: "deleted", renamed: "renamed" };

/** The PR's checks as check results, from the platform bot's newest status per context. */
function checkResults(statuses, checks, headSha) {
  const latest = new Map();
  for (const status of [...statuses].sort((a, b) => a.id - b.id)) latest.set(status.context, status);
  return [...latest.values()].map((status) => ({
    name: status.context,
    command: (checks.find((check) => check.name === status.context)?.commands ?? []).map((argv) => argv.join(" ")).join(" && ") || status.context,
    conclusion: { success: "success", failure: "failure", error: "failure", pending: "cancelled", warning: "failure" }[status.status ?? status.state] ?? "failure",
    commitSha: headSha,
  }));
}

/** The reviewer's newest submitted review, as a review result. */
function reviewResult(reviews) {
  const review = reviews.filter((item) => ["APPROVED", "REQUEST_CHANGES"].includes(item.state) && sha.test(item.commit_id ?? ""))
    .sort((a, b) => b.id - a.id)[0];
  return review && {
    verdict: review.state === "APPROVED" ? "approved" : "changes_requested",
    reviewer: review.user?.login ?? "reviewer",
    commitSha: review.commit_id,
  };
}

/** The pull-request document: what the run changed, checked and was reviewed on. */
async function pullRequestDocument({ forgejo, repository, request, issue, pull, nodes, checks }) {
  const path = `/repos/${repository}/pulls/${pull.number}`;
  const [files, statuses, reviews, commits] = await Promise.all([
    forgejo("GET", `${path}/files?limit=50`),
    forgejo("GET", `/repos/${repository}/commits/${pull.head.sha}/statuses?limit=50`),
    forgejo("GET", `${path}/reviews?limit=50`),
    forgejo("GET", `${path}/commits?limit=50`),
  ]);
  const tests = checkResults(statuses, checks, pull.head.sha);
  const review = reviewResult(reviews);
  const passed = tests.length > 0 && tests.every((test) => test.conclusion === "success");
  const summary = nodes.implement?.result?.summary || pull.title;
  return {
    document: {
      schemaVersion: 1,
      number: pull.number,
      url: pull.html_url,
      title: pull.title.replace(/^\s*(?:wip:|\[wip\])\s*/i, ""),
      request: { requestId: request.requestId, kind: request.kind, issueNumber: issue.number },
      baseBranch: pull.base.ref,
      baseSha: pull.merge_base ?? pull.base.sha,
      headBranch: pull.head.ref,
      headSha: pull.head.sha,
      summary,
      changes: files.map((file) => ({ path: file.filename, change: changeKind[file.status] ?? "modified", reason: summary.slice(0, 2000) })),
      // Criteria are checked by the run's checks and review, not by per-criterion evidence yet.
      acceptanceCriteria: request.acceptanceCriteria.map((criterion) => ({ id: criterion.id, status: passed && review?.verdict === "approved" ? "met" : "unverified", evidence: [] })),
      tests,
      evidence: [],
      risks: [],
      limitations: ["Acceptance criteria are judged from the checks and the independent review; no per-criterion evidence is attached."],
      ...(review ? { review } : {}),
      draft: /^\s*(?:wip:|\[wip\])/i.test(pull.title),
    },
    tests,
    review,
    commits: commits.map((commit) => commit.sha).filter((value) => sha.test(value)),
  };
}

/** The run's outcome in the contract's terms. */
function outcome(runStatus, nodes, pull, review) {
  if (pull?.merged) return "landed";
  if (nodes.triage?.result && nodes.triage.result.ready === false) return "needs_details";
  if (review?.verdict === "changes_requested") return "changes_requested";
  return runStatus === "complete" ? "refused" : "failed";
}

/**
 * The run-result document for a request whose run has ended, or undefined
 * while it is still running.
 * @param {{ forgejo: (method: string, path: string) => Promise<any>, repository: string, request: any,
 *   issue: { number: number, url: string }, run: { status: string }, nodes: Record<string, { status?: string, error?: string, result?: any }>,
 *   checks?: { name: string, commands: string[][] }[], model: { provider: string, id: string }, startedAt: string, finishedAt: string,
 *   steps?: ReturnType<typeof stepMetrics>[] }} input
 * @returns {Promise<any>}
 */
export async function runResult({ forgejo, repository, request, issue, run, nodes, checks = [], model, startedAt, finishedAt, steps = [] }) {
  if (!terminal.has(run.status)) return undefined;
  const pull = await runPull(forgejo, repository, issue.number);
  const pr = pull ? await pullRequestDocument({ forgejo, repository, request, issue, pull, nodes, checks }) : undefined;
  const status = outcome(run.status, nodes, pull, pr?.review);
  const failed = Object.entries(nodes).find(([, node]) => node.status === "failed" || node.error);
  const triage = nodes.triage?.result;
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    status,
    ...(status === "landed" ? {} : { reason: (failed ? `${failed[0]}: ${failed[1].error ?? "failed"}` : `Run ${run.status}`).slice(0, 4000) }),
    issue: { number: issue.number, url: issue.url },
    ...(triage ? { triage: { plan: triage.ready ? triage.summary : "", questions: triage.ready ? [] : [triage.summary] } } : {}),
    ...(pr ? { change: { delivery: "pull_request", pullRequest: pr.document, ...(pull.merged ? { mergeSha: pull.merge_commit_sha } : {}) } } : {}),
    checks: pr?.tests ?? [],
    ...(pr?.review ? { review: pr.review } : {}),
    model,
    metrics: runMetrics(steps, { startedAt, finishedAt }),
    startedAt,
    finishedAt,
  };
}
