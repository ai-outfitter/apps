import { onPageLoad } from "@ai-outfitter/ui/page";
import { initProject } from "./project.js";
import {
  api,
  availableRepositories,
  demoMode,
  el,
  external,
  loadPage,
  organizationOrigin,
  text,
} from "./shared.js";

let select = null;
let stateSelect = null;
let refresh = null;
let notice = null;
let listGeneration = 0;
let detailGeneration = 0;
const runLabels = {
  running: "In progress",
  queued: "Queued",
  pending: "Submission pending",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  timed_out: "Timed out",
  unknown: "Status unavailable",
};
function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}
function progress(milestone) {
  const total = milestone.openItems + milestone.closedItems;
  return total
    ? `${milestone.closedItems} of ${total} closed`
    : "No issues or pull requests";
}
function requestedMilestone() {
  const value = Number(new URL(location.href).searchParams.get("milestone"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function milestoneURL(number) {
  const url = new URL(location.href);
  url.searchParams.set("repository", select.value);
  url.searchParams.set("state", stateSelect.value);
  if (number) url.searchParams.set("milestone", String(number));
  else url.searchParams.delete("milestone");
  return url;
}
function query(number) {
  const params = new URLSearchParams({
    repository: select.value,
    state: stateSelect.value,
  });
  if (number) params.set("milestone", String(number));
  return `/api/apps/software-foundry/milestones?${params}`;
}
// A closed issue is finished work; a closed, unmerged pull request is not.
function statePill(item, pullRequest = false) {
  const pill = text("span", "", "status-pill");
  const label =
    item.draft && item.state === "open"
      ? "Draft"
      : { open: "Open", closed: "Closed", merged: "Merged" }[item.state];
  pill.append(text("span", label, "status-label"));
  const finished =
    item.state === "merged" || (item.state === "closed" && !pullRequest);
  pill.dataset.state = finished ? "completed" : item.state;
  const cell = text("td");
  cell.append(pill);
  return cell;
}
function titleCell(prefix, item) {
  const cell = text("td", "", "issue-copy");
  cell.append(
    text("small", `${prefix}${item.number}`),
    external(item.title, item.url, "issue-title"),
  );
  return cell;
}
function runsCell(runs) {
  const cell = text("td", "", "milestone-runs");
  if (!runs.length) {
    cell.append(text("span", "None recorded", "status-context"));
    return cell;
  }
  for (const run of runs) {
    const href =
      run.id && run.workflowId && organizationOrigin
        ? `${organizationOrigin}/workflows/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.id)}`
        : null;
    const link = text(
      href ? "a" : "span",
      `Issue to review · ${runLabels[run.status] || run.status}`,
      "workflow-link",
    );
    if (href) link.href = href;
    const line = text("div");
    line.append(link);
    cell.append(line);
  }
  return cell;
}
// Only a plain primary click stays in the page; modified clicks keep the
// browser's link behavior, such as opening a new tab.
function showMilestone(event, number) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  // Keeps the router's state, so going back and forth here, or back to here
  // from another page, swaps in this page for the URL.
  history.pushState(history.state, "", milestoneURL(number));
  void loadDetail(number);
}
function renderList(result) {
  const body = el("milestone-list");
  body.replaceChildren();
  const current = requestedMilestone();
  for (const milestone of result.milestones) {
    const row = text("tr");
    const cell = text("td", "", "issue-copy");
    const link = text("a", milestone.title, "issue-title");
    link.href = milestoneURL(milestone.number).href;
    if (milestone.number === current) link.setAttribute("aria-current", "true");
    link.onclick = (event) => showMilestone(event, milestone.number);
    cell.append(link);
    row.append(
      cell,
      text("td", milestone.dueOn ? dateText(milestone.dueOn) : "No due date"),
      text("td", progress(milestone)),
    );
    body.append(row);
  }
  const empty = el("milestone-list-empty");
  empty.hidden = result.milestones.length > 0;
  empty.textContent = `No ${result.state} milestones in ${result.repository}.`;
  notice.textContent = result.truncated
    ? "Showing the first 100 milestones."
    : "";
}
function renderRows(id, rows, emptyId) {
  el(id).replaceChildren(...rows);
  el(emptyId).hidden = rows.length > 0;
}
function renderDetail(result) {
  const { milestone } = result;
  el("milestone-detail-heading").textContent = milestone.title;
  el("milestone-github").href = milestone.url;
  el("milestone-github").hidden = false;
  el("milestone-summary").textContent = [
    milestone.state === "open" ? "Open" : "Closed",
    progress(milestone),
    milestone.dueOn ? `Due ${dateText(milestone.dueOn)}` : "No due date",
  ].join(" · ");
  el("milestone-description").textContent = milestone.description;
  el("milestone-truncated").hidden = !result.truncated;
  el("milestone-truncated").textContent =
    `Showing the first ${result.issues.length + result.pullRequests.length} items. Open the milestone on GitHub for the rest.`;
  renderRows(
    "milestone-issues",
    result.issues.map((issue) => {
      const row = text("tr");
      row.append(titleCell("#", issue), statePill(issue), runsCell(issue.runs));
      return row;
    }),
    "milestone-issues-empty",
  );
  el("milestone-pulls-empty").textContent =
    result.pullRequestsListed === false
      ? "Pull requests are not listed: the GitHub App needs Pull requests (read) permission."
      : "No pull requests in this milestone.";
  renderRows(
    "milestone-pulls",
    result.pullRequests.map((pull) => {
      const row = text("tr");
      row.append(
        titleCell("#", pull),
        statePill(pull, true),
        text("td", dateText(pull.updatedAt)),
      );
      return row;
    }),
    "milestone-pulls-empty",
  );
}
function resetDetail(message) {
  el("milestone-detail").hidden = !message;
  el("milestone-detail-heading").textContent = "Milestone";
  el("milestone-github").hidden = true;
  el("milestone-summary").textContent = message || "";
  el("milestone-description").textContent = "";
  el("milestone-truncated").hidden = true;
  renderRows("milestone-issues", [], "milestone-issues-empty");
  renderRows("milestone-pulls", [], "milestone-pulls-empty");
  el("milestone-issues-empty").hidden = true;
  el("milestone-pulls-empty").hidden = true;
}
function detailFailed(message) {
  // Kept inside the detail block: the shared notice belongs to the list.
  resetDetail(`Milestone could not be loaded: ${message}`);
}
function listFailed(message) {
  el("milestone-list").replaceChildren();
  el("milestone-list-empty").hidden = false;
  el("milestone-list-empty").textContent = "Milestones could not be loaded.";
  notice.textContent = `Milestones could not be loaded: ${message}`;
}
// The bootstrap's list and selected detail, rendered without another request.
function renderFirst(data) {
  history.replaceState(history.state, "", milestoneURL(requestedMilestone()));
  const failedDetail = requestedMilestone() ? data : null;
  const detail = data.error ? failedDetail : data.detail;
  if (data.error || data.list.error) listFailed((data.list || data).error);
  else renderList(data.list);
  if (!detail) resetDetail("");
  else if (detail.error) detailFailed(detail.error);
  else renderDetail(detail);
  refresh.disabled = false;
}
async function loadDetail(number) {
  const current = ++detailGeneration;
  for (const link of document.querySelectorAll("#milestone-list a"))
    link.toggleAttribute(
      "aria-current",
      link.href === milestoneURL(number).href,
    );
  if (!number) return resetDetail("");
  resetDetail("Loading milestone…");
  try {
    const result = await api(query(number));
    if (current === detailGeneration) renderDetail(result);
  } catch (error) {
    if (current === detailGeneration) detailFailed(error.message);
  }
}
async function loadList() {
  const current = ++listGeneration;
  const empty = el("milestone-list-empty");
  el("milestone-list").replaceChildren();
  empty.hidden = false;
  empty.textContent = "Loading milestones…";
  notice.textContent = "";
  try {
    const result = await api(query());
    if (current === listGeneration) renderList(result);
  } catch (error) {
    if (current === listGeneration) listFailed(error.message);
  }
}
async function load() {
  refresh.disabled = true;
  history.replaceState(history.state, "", milestoneURL(requestedMilestone()));
  await Promise.all([loadList(), loadDetail(requestedMilestone())]);
  refresh.disabled = false;
}
function chooseInitial(repositories) {
  const params = new URL(location.href).searchParams;
  const requested = params.get("repository");
  if (repositories.some((repo) => repo.name === requested))
    select.value = requested;
  stateSelect.value = params.get("state") === "closed" ? "closed" : "open";
}
function changeScope() {
  history.replaceState(history.state, "", milestoneURL(null));
  void load();
}
async function initialize(signal) {
  try {
    const params = new URL(location.href).searchParams;
    const page = await loadPage("milestones", {
      repository: params.get("repository"),
      state: params.get("state") === "closed" ? "closed" : "open",
      milestone: requestedMilestone(),
    });
    if (signal.aborted) return;
    const plugin = page.plugin;
    initProject(page);
    const repositories = availableRepositories(plugin);
    select.replaceChildren(
      ...repositories.map((repo) => {
        const option = text("option", repo.name);
        option.value = repo.name;
        return option;
      }),
    );
    el("milestone-list-empty").hidden = false;
    if (!repositories.length) {
      notice.textContent =
        "No available repositories. Manage repository access on GitHub.";
      el("milestone-list-empty").textContent = "Select a repository.";
      return;
    }
    chooseInitial(repositories);
    select.disabled = stateSelect.disabled = false;
    select.onchange = stateSelect.onchange = changeScope;
    refresh.onclick = () => void load();
    if (page.milestones) renderFirst(page.milestones);
    else await load();
  } catch (error) {
    if (signal.aborted) return;
    notice.textContent = `Unable to load repositories: ${error.message}`;
  }
}
onPageLoad((signal) => {
  select = el("milestone-repository");
  if (!select) return;
  stateSelect = el("milestone-state");
  refresh = el("milestone-refresh");
  notice = el("milestone-notice");
  // Requests still running when the page is left must not render.
  signal.addEventListener("abort", () => {
    listGeneration++;
    detailGeneration++;
  });
  void initialize(signal);
});
