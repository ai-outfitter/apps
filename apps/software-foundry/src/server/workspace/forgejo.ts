// Forgejo adapter for the workspace workflow, used by the sealed Foundry box.
// It gives the same receipts and refusals as GithubFoundryForge over Forgejo's
// REST API (/api/v1), which the platform's `repository.request` reaches for a
// Forgejo binding. Forgejo has no GraphQL, check runs or merge queue:
// - draft is a "WIP:" title prefix, and readiness removes it;
// - the linked issue is a closing keyword in the PR body;
// - checks are commit statuses, keyed by context, authored by the platform's bot;
// - landing merges directly (squash) once approval and statuses are current.
import type { API, ChangeReceipt, CheckReceipt, IssueReceipt, MergeReceipt, ReviewReceipt } from "./forge";

const conflict = (message: string) => new Response(message, { status: 409 });
const draftPrefix = /^\s*(?:wip:|\[wip\])\s*/i;
/** Forgejo's largest page. */
const page = 50;

/** Whether a PR body closes the issue, by Forgejo's closing keywords. */
export function closesIssue(body: string | null | undefined, issue: number) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, "i").test(body ?? "");
}

// Forgejo takes `state` when creating a status but answers with `status`.
type Status = { id: number; context: string; status?: string; state?: string; description?: string; target_url?: string; creator?: { id: number } };
const statusState = (status: Status | undefined) => status?.status ?? status?.state;

export class ForgejoFoundryForge {
  /**
   * @param botUserId the platform's Forgejo user: it authors comments and statuses.
   * @param checkUserId the user whose statuses count as required checks (the box's check runner).
   */
  constructor(
    private api: API,
    private repository: string,
    private botUserId: number,
    private checkUserId = botUserId,
  ) {}
  private path(suffix: string) {
    return `/repos/${this.repository}${suffix}`;
  }
  private same(name: string | undefined) {
    return name?.toLowerCase() === this.repository.toLowerCase();
  }

  async issue(number: number): Promise<IssueReceipt> {
    if (!Number.isSafeInteger(number) || number <= 0) throw conflict("Current repository issue required");
    const issue = await this.api(this.path(`/issues/${number}`));
    if (issue.number !== number || issue.pull_request || typeof issue.title !== "string" ||
      typeof issue.html_url !== "string" || !["open", "closed"].includes(issue.state))
      throw conflict("Current repository issue required");
    return { number, repository: this.repository, url: issue.html_url, title: issue.title,
      body: typeof issue.body === "string" ? issue.body : "", state: issue.state };
  }

  async ready(candidate: ChangeReceipt) {
    const path = this.path(`/pulls/${candidate.number}`);
    const pull = await this.api(path);
    if (pull.head.sha !== candidate.headSha) throw conflict("Pull request changed before review");
    if (draftPrefix.test(pull.title)) await this.api(path, { title: pull.title.replace(draftPrefix, "") }, "PATCH");
    const current = await this.api(path);
    if (current.head.sha !== candidate.headSha || draftPrefix.test(current.title))
      throw conflict("Current ready pull request required");
  }

  async change(candidate: ChangeReceipt, issueNumber: number, branch: string, allowMerged = false): Promise<ChangeReceipt> {
    if (!candidate || !Number.isSafeInteger(candidate.number) || !/^[a-f0-9]{40}$/.test(candidate.headSha))
      throw conflict("Implementation did not return a pinned pull request");
    const pull = await this.api(this.path(`/pulls/${candidate.number}`));
    const repository = await this.api(this.path(""));
    if ((pull.state !== "open" && !(allowMerged && pull.merged)) || pull.head.sha !== candidate.headSha ||
      pull.head.ref !== branch || !this.same(pull.head.repo?.full_name) || !this.same(pull.base.repo?.full_name) ||
      pull.base.ref !== repository.default_branch)
      throw conflict("Pull request must target this repository's default branch at the assigned commit");
    if (!closesIssue(pull.body, issueNumber)) throw conflict("Pull request must close the assigned issue");
    return { number: pull.number, headSha: pull.head.sha, branch: pull.head.ref, url: pull.html_url };
  }

  /** Open issues the bot opened (the newest page). */
  async openedIssues(): Promise<IssueReceipt[]> {
    const issues = await this.api(this.path(`/issues?state=open&type=issues&limit=${page}`));
    return (Array.isArray(issues) ? issues : []).filter((issue: any) => issue.user?.id === this.botUserId).map((issue: any) => ({
      number: issue.number, repository: this.repository, url: issue.html_url, title: issue.title,
      body: typeof issue.body === "string" ? issue.body : "", state: "open" as const }));
  }

  async close(number: number, comment: string) {
    await this.api(this.path(`/issues/${number}/comments`), { body: comment });
    await this.api(this.path(`/issues/${number}`), { state: "closed" }, "PATCH");
  }

  async comment(issue: number, attemptId: string, summary: string) {
    const marker = `<!-- outfitter:workspace-triage:${attemptId} -->`;
    const comments = await this.api(this.path(`/issues/${issue}/comments?limit=${page}`));
    if (comments.length >= page) throw conflict("Issue history exceeds safe publication limit");
    const existing = comments.find((comment: any) => comment.body?.includes(marker) && comment.user?.id === this.botUserId);
    const result = existing ?? (await this.api(this.path(`/issues/${issue}/comments`), { body: `${summary}\n\n${marker}` }));
    return { id: result.id, url: result.html_url };
  }

  private async statuses(sha: string): Promise<Status[]> {
    const statuses = await this.api(this.path(`/commits/${sha}/statuses?limit=${page}`));
    if (!Array.isArray(statuses) || statuses.length >= page) throw conflict("Check history exceeds safe publication limit");
    return statuses;
  }
  /** The newest status for a context from the given user. */
  private latest(statuses: Status[], context: string, userId: number) {
    return statuses.filter((item) => item.context === context && item.creator?.id === userId).sort((a, b) => b.id - a.id)[0];
  }

  async checks(candidate: ChangeReceipt, results: CheckReceipt[], attemptId: string): Promise<CheckReceipt[]> {
    const existing = await this.statuses(candidate.headSha);
    const receipts: CheckReceipt[] = [];
    for (const result of results) {
      if (result.headSha !== candidate.headSha) throw conflict("Validation commit changed");
      const state = result.passed ? "success" : "failure";
      const description = `Outfitter workspace ${attemptId}`;
      const prior = this.latest(existing, result.name, this.botUserId);
      const status = prior?.description === description ? prior
        : await this.api(this.path(`/statuses/${candidate.headSha}`), {
          context: result.name,
          state,
          description,
          ...(result.url ? { target_url: result.url } : {}),
        });
      if (statusState(status) !== state) throw conflict("Published check could not be verified");
      receipts.push({ name: result.name, headSha: candidate.headSha, passed: result.passed, url: status.target_url || undefined });
    }
    return receipts;
  }

  async merge(candidate: ChangeReceipt, review: ReviewReceipt, checkNames: string[], _queue: boolean): Promise<MergeReceipt | null> {
    const path = this.path(`/pulls/${candidate.number}`);
    let pull = await this.api(path);
    const repository = await this.api(this.path(""));
    if (!this.same(pull.base.repo?.full_name) || pull.base.ref !== repository.default_branch)
      throw conflict("Pull request target changed before merge");
    if (pull.head.sha !== candidate.headSha) throw conflict("Pull request changed after review");
    if (pull.merged) return { url: pull.html_url, headSha: candidate.headSha, mergeSha: pull.merge_commit_sha };
    await this.requireApproval(candidate, review, pull);
    await this.requireChecks(candidate, checkNames);
    if (draftPrefix.test(pull.title)) await this.api(path, { title: pull.title.replace(draftPrefix, "") }, "PATCH");
    // Forgejo has no merge queue: a queued landing merges directly at the reviewed head.
    await this.api(`${path}/merge`, { Do: "squash", head_commit_id: candidate.headSha }, "POST");
    pull = await this.api(path);
    if (!pull.merged || !/^[a-f0-9]{40}$/.test(pull.merge_commit_sha ?? "")) throw conflict("Merge has not been confirmed");
    return { url: pull.html_url, headSha: candidate.headSha, mergeSha: pull.merge_commit_sha };
  }

  async approval(candidate: ChangeReceipt, review: ReviewReceipt) {
    const pull = await this.api(this.path(`/pulls/${candidate.number}`));
    if (pull.head.sha !== candidate.headSha || review.headSha !== candidate.headSha || review.verdict !== "approved")
      throw conflict("Pull request changed after review");
    await this.requireApproval(candidate, review, pull);
  }

  private async requireApproval(candidate: ChangeReceipt, review: ReviewReceipt, pull: any) {
    const reviews = await this.api(this.path(`/pulls/${candidate.number}/reviews?limit=${page}`));
    if (reviews.length >= page) throw conflict("Review history exceeds safe merge limit");
    // Later comments or same-head approvals by the reviewer account leave the approval standing.
    const own = reviews.find((item: any) => item.id === review.id);
    const revoked = reviews.some((item: any) => item.user?.id === review.reviewer.id && item.id > review.id &&
      !["PENDING", "COMMENT"].includes(item.state) &&
      (item.dismissed || item.state !== "APPROVED" || item.commit_id !== candidate.headSha));
    if (!own || own.user?.id !== review.reviewer.id || own.state !== "APPROVED" || own.dismissed || own.stale ||
      own.commit_id !== candidate.headSha || revoked || pull.user.id === review.reviewer.id)
      throw conflict("Current independent formal approval required");
  }

  private async requireChecks(candidate: ChangeReceipt, checkNames: string[]) {
    const statuses = await this.statuses(candidate.headSha);
    if (!checkNames.length || checkNames.some((name) => statusState(this.latest(statuses, name, this.checkUserId)) !== "success"))
      throw conflict("Current required checks required");
  }
}
