// The Foundry box's release: the shared release step (box/release.mjs) with
// the Foundry's evidence bundle (box/schemas/evidence-bundle.schema.json),
// which names each landed request's pull request, commits, checks and
// acceptance criteria.
import { publishRelease } from "../../../box/release.mjs";

/** The evidence bundle: what was built from which commit, and what backs each criterion. */
export function evidenceBundle({ tag, version, commitSha, build, model, released, artifacts }) {
  return {
    schemaVersion: 1,
    tag,
    version,
    commitSha,
    build,
    model,
    requests: released.map(({ request, result }) => ({
      requestId: request.requestId,
      ...(result.change?.pullRequest ? { pullRequest: result.change.pullRequest.number } : {}),
      commits: [result.change?.mergeSha ?? commitSha],
    })),
    checks: released.flatMap(({ result }) => result.checks),
    criteria: released.flatMap(({ request, result }) =>
      (result.change?.pullRequest?.acceptanceCriteria ?? request.acceptanceCriteria.map((criterion) => ({ id: criterion.id, status: "unverified", evidence: [] })))
        .map((criterion) => ({ requestId: request.requestId, id: criterion.id, status: criterion.status, evidence: criterion.evidence }))),
    artifacts,
  };
}

/** Releases the landed requests that asked for one. */
export function releaseRequests(box, released) {
  return publishRelease(box, {
    bumps: released.map(({ request }) => request.release?.bump ?? "patch"),
    lines: released.map(({ request, result }) => `- ${request.title}${result.change?.pullRequest ? ` (#${result.change.pullRequest.number})` : ""}`),
    evidence: (release) => evidenceBundle({ ...release, model: released[0].result.model, released }),
  });
}
