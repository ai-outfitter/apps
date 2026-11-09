// The project page's "Recent repository activity": merged pull requests and direct commits in each of the project's repositories.
import { onPageLoad } from "@ai-outfitter/ui/page";
import type { RepositoryChanges } from "../server/repo-changes";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const link = (href: string, text: string) => {
  const a = el("a", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
};
const add = (parent: Node, ...children: (Node | string)[]) => {
  for (const child of children) parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function repository(repo: RepositoryChanges) {
  const block = el("article", "", "planning-shipped-repo");
  const head = el("h3");
  add(head, link(repo.url, repo.path ? `${repo.repository}/${repo.path}` : repo.repository));
  add(block, head);
  if (repo.error) {
    add(block, el("p", repo.error, "muted"));
    return block;
  }
  const items = [
    ...repo.pullRequests.map((pr) => ({ at: pr.mergedAt, href: pr.url, text: `#${pr.number} ${pr.title}`, by: pr.author })),
    ...repo.directCommits.map((commit) => ({ at: commit.committedAt, href: commit.url, text: commit.headline, by: commit.author })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  if (!items.length) {
    add(block, el("p", "No repository activity was found in this window.", "muted"));
    return block;
  }
  const list = el("ul");
  for (const item of items) {
    const row = el("li");
    add(row, link(item.href, item.text), el("small", ` ${day(item.at)}${item.by ? ` · ${item.by}` : ""}`, "muted"));
    add(list, row);
  }
  add(block, list);
  return block;
}

onPageLoad((signal) => { void showShipped(signal); void showPullRequests(signal); });

type PullRepository = { nameWithOwner: string; url: string; path: string | null; pullRequestActivity: { error: string | null; pullRequests: { nodes: { number: number; title: string; url: string; state: string; updatedAt: string }[] } | null } };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: render each repository and its partial failure independently
async function showPullRequests(signal: AbortSignal) {
  const section = document.getElementById("project-pull-requests");
  const status = section?.querySelector<HTMLElement>("[data-pull-status]");
  if (!section || !status) return;
  if (import.meta.env.OUTFITTER_APP_MODE === "demo") { section.remove(); return; }
  const mount = location.pathname.replace(/^(.*)\/projects(?:\/.*)?$/, "$1");
  try {
    const response = await fetch(`${mount}/api/apps/planning/repository-pulls?projectId=${encodeURIComponent(section.dataset.projectId ?? "")}`, { signal });
    if (!response.ok) throw new Error(await response.text());
    const { repositories } = await response.json() as { repositories: PullRepository[] };
    status.textContent = repositories.length ? "Most recently updated pull requests." : "No repositories linked.";
    for (const repo of repositories) {
      const block = el("article", "", "planning-shipped-repo");
      const heading = el("h3");
      add(heading, link(repo.url, repo.path ? `${repo.nameWithOwner}/${repo.path}` : repo.nameWithOwner));
      add(block, heading);
      const { pullRequests, error } = repo.pullRequestActivity;
      if (!pullRequests) add(block, el("p", error ?? "Pull requests are unavailable for this repository.", "muted"));
      else if (!pullRequests.nodes.length) add(block, el("p", "No pull requests found.", "muted"));
      else {
        const list = el("ul");
        for (const pr of pullRequests.nodes) { const row = el("li"); add(row, link(pr.url, `#${pr.number} ${pr.title}`), el("small", ` ${pr.state.toLowerCase()} · ${day(pr.updatedAt)}`, "muted")); add(list, row); }
        add(block, list);
      }
      add(section, block);
    }
  } catch (error) {
    if (!signal.aborted) status.textContent = `Cannot read pull requests: ${error instanceof Error ? error.message.slice(0, 160) : "try again."}`;
  }
}

async function showShipped(signal: AbortSignal) {
  const section = document.getElementById("project-shipped");
  const status = section?.querySelector<HTMLElement>("[data-shipped-status]");
  if (!section || !status) return;
  if (import.meta.env.OUTFITTER_APP_MODE === "demo") {
    section.remove();
    return;
  }
  const mount = location.pathname.replace(/^(.*)\/projects(?:\/.*)?$/, "$1");
  try {
    const response = await fetch(`${mount}/api/apps/planning/shipped?projectId=${encodeURIComponent(section.dataset.projectId ?? "")}`, { signal });
    if (!response.ok) throw new Error(await response.text());
    const { days, repositories } = (await response.json()) as { days: number; repositories: RepositoryChanges[] };
    if (!repositories.length) {
      status.textContent = "No repositories linked. Link the project's Wiki page to a Repository with source_in.";
      return;
    }
    status.textContent = `Last ${days} days across ${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}.`;
    add(section, ...repositories.map(repository));
  } catch (error) {
    if (!signal.aborted) status.textContent = `Cannot read repository activity: ${error instanceof Error ? error.message.slice(0, 160) : "try again."}`;
  }
}
