/** Provider-neutral receipts used by the workspace workflow. GitHub is the first adapter. */
export type IssueReceipt = {
  number: number;
  repository: string;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
};
export type ChangeReceipt = {
  number: number;
  headSha: string;
  url: string;
  branch: string;
};
export type CheckReceipt = {
  name: string;
  headSha: string;
  passed: boolean;
  url?: string;
};
export type ReviewReceipt = {
  id: number;
  url: string;
  headSha: string;
  verdict: "approved" | "changes-requested";
  reviewer: { id: number; login: string };
};
export type MergeReceipt = { url: string; headSha: string; mergeSha: string };
export type API = <T = any>(
  path: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
type RepositoryRequest = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: import("@ai-outfitter/app-sdk/workflow-host").PhaseInput[string];
};
/** The forge's API over the workflow host's `repository.request`, which confines
 * every call to the binding's repository (or a connection's approved ones). */
export function hostAPI(request: (input: RepositoryRequest) => Promise<unknown>): API {
  return async (path, body, method) =>
    (await request({
      method: (method ?? (body === undefined ? "GET" : "POST")) as RepositoryRequest["method"],
      path,
      ...(body === undefined ? {} : { body: body as RepositoryRequest["body"] }),
    })) as never;
}
const conflict = (message: string) => new Response(message, { status: 409 });

export class GithubFoundryForge {
  constructor(
    private api: API,
    private repository: string,
    private appId: number,
    private checkAppId = appId,
  ) {}
  private path(suffix: string) {
    return `/repos/${this.repository}${suffix}`;
  }
  async issue(number: number): Promise<IssueReceipt> {
    if (!Number.isSafeInteger(number) || number <= 0) throw conflict("Current repository issue required");
    const issue = await this.api(this.path(`/issues/${number}`));
    if (issue.number !== number || issue.pull_request ||
      typeof issue.title !== "string" || typeof issue.html_url !== "string" ||
      !["open", "closed"].includes(issue.state))
      throw conflict("Current repository issue required");
    return { number, repository: this.repository, url: issue.html_url,
      title: issue.title, body: typeof issue.body === "string" ? issue.body : "", state: issue.state };
  }
  async ready(candidate: ChangeReceipt) {
    const path = this.path(`/pulls/${candidate.number}`);
    const pull = await this.api(path);
    if (pull.head.sha !== candidate.headSha)
      throw conflict("Pull request changed before review");
    if (pull.draft) {
      const result = await this.api("/graphql", {
        query:
          "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
        variables: { id: pull.node_id },
      });
      if (result.errors?.length)
        throw new Response("GitHub refused draft readiness; check coordinator repository write access", {
          status: result.errors.some((error: any) => error.type === "FORBIDDEN") ? 403 : 502,
        });
      if (!result.data?.markPullRequestReadyForReview?.pullRequest?.id)
        throw new Response("GitHub returned no draft readiness receipt", { status: 502 });
    }
    const current = await this.api(path);
    if (current.head.sha !== candidate.headSha || current.draft)
      throw conflict("Current ready pull request required");
  }

  async change(
    candidate: ChangeReceipt,
    issueNumber: number,
    branch: string,
    allowMerged = false,
  ): Promise<ChangeReceipt> {
    if (
      !candidate ||
      !Number.isSafeInteger(candidate.number) ||
      !/^[a-f0-9]{40}$/.test(candidate.headSha)
    )
      throw conflict("Implementation did not return a pinned pull request");
    const pull = await this.api(this.path(`/pulls/${candidate.number}`));
    const repository = await this.api(this.path(""));
    if (
      (pull.state !== "open" && !(allowMerged && pull.merged)) ||
      pull.head.sha !== candidate.headSha ||
      pull.head.ref !== branch ||
      pull.head.repo?.full_name?.toLowerCase() !==
        this.repository.toLowerCase() ||
      pull.base.repo?.full_name?.toLowerCase() !==
        this.repository.toLowerCase() ||
      pull.base.ref !== repository.default_branch
    )
      throw conflict(
        "Pull request must target this repository's default branch at the assigned commit",
      );
    const [owner, name] = this.repository.split("/");
    const linked = await this.api("/graphql", {
      query:
        "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}}}}}}",
      variables: { owner, name, number: candidate.number },
    });
    const issues =
      linked.data?.repository?.pullRequest?.closingIssuesReferences?.nodes;
    if (
      !Array.isArray(issues) ||
      !issues.some(
        (issue: any) =>
          issue.number === issueNumber &&
          issue.repository.nameWithOwner.toLowerCase() ===
            this.repository.toLowerCase(),
      )
    )
      throw conflict("Pull request must close the assigned issue");
    return {
      number: pull.number,
      headSha: pull.head.sha,
      branch: pull.head.ref,
      url: pull.html_url,
    };
  }

  async comment(issue: number, attemptId: string, summary: string) {
    const marker = `<!-- outfitter:workspace-triage:${attemptId} -->`;
    const comments = await this.api(
      this.path(`/issues/${issue}/comments?per_page=100`),
    );
    if (comments.length === 100)
      throw conflict("Issue history exceeds safe publication limit");
    const existing = comments.find(
      (comment: any) =>
        comment.body?.includes(marker) &&
        comment.performed_via_github_app?.id === this.appId,
    );
    const result =
      existing ??
      (await this.api(this.path(`/issues/${issue}/comments`), {
        body: `${summary}\n\n${marker}`,
      }));
    return { id: result.id, url: result.html_url };
  }

  async checks(
    candidate: ChangeReceipt,
    results: CheckReceipt[],
    attemptId: string,
  ): Promise<CheckReceipt[]> {
    const existing = await this.api(
      this.path(`/commits/${candidate.headSha}/check-runs?per_page=100`),
    );
    if (existing.total_count > 100)
      throw conflict("Check history exceeds safe publication limit");
    const receipts: CheckReceipt[] = [];
    for (const result of results) {
      if (result.headSha !== candidate.headSha)
        throw conflict("Validation commit changed");
      const external_id = `${attemptId}:${result.name}`;
      const prior = existing.check_runs.find(
        (check: any) =>
          check.external_id === external_id && check.app?.id === this.appId,
      );
      const check =
        prior ??
        (await this.api(this.path("/check-runs"), {
          name: result.name,
          head_sha: candidate.headSha,
          external_id,
          status: "completed",
          conclusion: result.passed ? "success" : "failure",
          completed_at: new Date().toISOString(),
          output: {
            title: result.name,
            summary: result.passed
              ? "Validated in an Outfitter workspace."
              : "Workspace validation failed. Inspect the retained node logs.",
          },
        }));
      if (
        check.head_sha !== candidate.headSha ||
        check.conclusion !== (result.passed ? "success" : "failure")
      )
        throw conflict("Published check could not be verified");
      receipts.push({
        name: result.name,
        headSha: candidate.headSha,
        passed: result.passed,
        url: check.html_url,
      });
    }
    return receipts;
  }

  async merge(
    candidate: ChangeReceipt,
    review: ReviewReceipt,
    checkNames: string[],
    queue: boolean,
  ): Promise<MergeReceipt | null> {
    const path = this.path(`/pulls/${candidate.number}`);
    let pull = await this.api(path);
    const repository = await this.api(this.path(""));
    if (
      pull.base.repo?.full_name?.toLowerCase() !==
        this.repository.toLowerCase() ||
      pull.base.ref !== repository.default_branch
    )
      throw conflict("Pull request target changed before merge");
    if (pull.head.sha !== candidate.headSha)
      throw conflict("Pull request changed after review");
    if (pull.merged)
      return {
        url: pull.html_url,
        headSha: candidate.headSha,
        mergeSha: pull.merge_commit_sha,
      };
    await this.requireApproval(candidate, review, pull);
    await this.requireChecks(candidate, checkNames);
    if (pull.draft)
      await this.api("/graphql", {
        query:
          "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
        variables: { id: pull.node_id },
      });
    if (queue) {
      const queued = await this.api("/graphql", {
        query:
          "query($id:ID!){node(id:$id){... on PullRequest{mergeQueueEntry{id}}}}",
        variables: { id: pull.node_id },
      });
      if (!queued.data?.node?.mergeQueueEntry)
        await this.api("/graphql", {
          query:
            "mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id}}}",
          variables: { id: pull.node_id, head: candidate.headSha },
        });
      return null;
    }
    await this.api(
      `${path}/merge`,
      { sha: candidate.headSha, merge_method: "squash" },
      "PUT",
    );
    pull = await this.api(path);
    if (!pull.merged || !/^[a-f0-9]{40}$/.test(pull.merge_commit_sha ?? ""))
      throw conflict("Merge has not been confirmed");
    return {
      url: pull.html_url,
      headSha: candidate.headSha,
      mergeSha: pull.merge_commit_sha,
    };
  }
  /** Re-read an existing formal approval without publishing another review. */
  async approval(candidate: ChangeReceipt, review: ReviewReceipt) {
    const pull = await this.api(this.path(`/pulls/${candidate.number}`));
    if (pull.head.sha !== candidate.headSha || review.headSha !== candidate.headSha || review.verdict !== "approved")
      throw conflict("Pull request changed after review");
    await this.requireApproval(candidate, review, pull);
  }

  private async requireApproval(
    candidate: ChangeReceipt,
    review: ReviewReceipt,
    pull: any,
  ) {
    const reviews = await this.api(
      this.path(`/pulls/${candidate.number}/reviews?per_page=100`),
    );
    if (reviews.length === 100)
      throw conflict("Review history exceeds safe merge limit");
    const latest = reviews
      .filter(
        (item: any) =>
          item.user.id === review.reviewer.id && item.state !== "PENDING",
      )
      .sort((a: any, b: any) => b.id - a.id)[0];
    if (
      !latest ||
      latest.id !== review.id ||
      latest.state !== "APPROVED" ||
      latest.commit_id !== candidate.headSha ||
      pull.user.id === review.reviewer.id
    )
      throw conflict("Current independent formal approval required");
  }
  private async requireChecks(candidate: ChangeReceipt, checkNames: string[]) {
    const checks = await this.api(
      this.path(`/commits/${candidate.headSha}/check-runs?per_page=100`),
    );
    if (
      !checkNames.length ||
      checks.total_count > 100 ||
      checkNames.some((name) => {
        const check = checks.check_runs
          .filter(
            (item: any) => item.name === name && item.app?.id === this.checkAppId &&
              (item.head_sha === candidate.headSha || (this.checkAppId !== 15368 && item.head_sha === undefined)),
          )
          .sort((a: any, b: any) => b.id - a.id)[0];
        return (
          !check ||
          check.status !== "completed" ||
          check.conclusion !== "success"
        );
      })
    )
      throw conflict("Current required checks required");
  }
}
