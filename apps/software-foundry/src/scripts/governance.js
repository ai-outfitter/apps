import { onPageLoad } from "@ai-outfitter/ui/page";
import { draftPolicyText } from "./draft-policy.js";
import { initProject } from "./project.js";
import { api, availableRepositories, demoMode, el, loadPage } from "./shared.js";

let select = null;
let refresh = null;
let notice = null;
let generation = 0;
function indicator(row, status, note) {
  row.dataset.status = status;
  const checkbox = row.querySelector("input");
  checkbox.checked = status === "present";
  checkbox.indeterminate = status === "unknown";
  checkbox.title = note;
  row.querySelector("[data-check-note]").textContent = status === "unknown" ? ` ${note}.` : "";
}
function reset(text) {
  el("governance-snapshot").textContent = "";
  for (const row of document.querySelectorAll("[data-document]")) {
    row.querySelector("[data-file]").textContent = row.dataset.document;
    indicator(row, "unknown", text);
  }
  for (const row of document.querySelectorAll("[data-rule], [data-policy]")) indicator(row, "unknown", "Not checked yet");
  for (const box of document.querySelectorAll("[data-remediation]")) box.replaceChildren();
  el("governance-setup").replaceChildren();
}
// The Agent workflows row of a repository that has not opted into agents.
const AGENTS_NOT_INSTALLED = "Not installed — Complete all with agents";
function ruleStatus(value) {
  if (value === "Met") return "present";
  if (value === "Missing") return "missing";
  // A choice, not a failing check.
  return value === AGENTS_NOT_INSTALLED ? "info" : "unknown";
}
function renderRules(rules) {
  for (const row of document.querySelectorAll("[data-rule]")) {
    const value = rules?.[row.dataset.rule];
    const status = ruleStatus(value);
    indicator(row, status, value || "Not checked yet");
    if (status === "info") row.querySelector("[data-check-note]").textContent = ` ${value}.`;
  }
}
const mergeQueueNotes = {
  present: "Merge queue enabled; CI workflows run on merge_group.",
  missing: "No merge queue on the default branch.",
  "merge-group-missing":
    "Merge queue enabled, but CI workflows do not run on merge_group, so queued pull requests never get their required checks.",
  unknown: "Unable to check",
};
function paragraph(...parts) {
  const element = document.createElement("p");
  element.append(...parts);
  return element;
}
function externalLink(text, href) {
  const link = document.createElement("a");
  link.textContent = text;
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function code(text) {
  const element = document.createElement("code");
  element.textContent = text;
  return element;
}
const partStatusLabels = {
  done: "Done",
  pending: "To do",
  waiting: "Waiting",
  blocked: "Blocked",
};
function setupPart(part, repository) {
  const item = document.createElement("li");
  item.dataset.step = part.step;
  item.dataset.status = part.status;
  const status = document.createElement("span");
  status.dataset.partStatus = "";
  status.textContent = `${partStatusLabels[part.status] || part.status}: `;
  // Only links into this repository on GitHub are rendered as links.
  const linked = part.url?.startsWith(`https://github.com/${repository}/`);
  item.append(status, linked ? externalLink(part.label, part.url) : part.label);
  if (part.detail) {
    const detail = document.createElement("span");
    detail.dataset.partDetail = "";
    detail.textContent = part.detail;
    item.append(detail);
  }
  return item;
}
function setupReport(report, repository) {
  const nodes = [];
  if (report.parts?.length) {
    const list = document.createElement("ul");
    list.setAttribute("aria-label", "Setup parts");
    list.append(...report.parts.map((part) => setupPart(part, repository)));
    nodes.push(list);
  }
  for (const note of report.notes || []) nodes.push(paragraph(note));
  return nodes;
}
function permissionNotice(missing, repository) {
  return [
    paragraph(
      `The GitHub App installation needs ${missing.join(", ")}. Add the permission to the GitHub App and have an organization owner accept it, or make the change on GitHub. `,
    ),
    paragraph(
      externalLink(
        "Open repository settings",
        `https://github.com/${repository}/settings`,
      ),
    ),
  ];
}
const setupNotices = {
  complete: "Setup complete.",
  running: "Setup is waiting on GitHub. Press Complete all again once the pull request merges.",
  blocked: "Some setup parts are blocked. See the reasons below.",
  "nothing-to-do": "Nothing to set up.",
};
async function completeAll(button, repository, action = "complete-sdlc-setup") {
  button.disabled = true;
  notice.textContent = "Completing setup…";
  try {
    const report = await api("/api/plugins/github/governance", {
      method: "POST",
      body: JSON.stringify({ repository, action }),
    });
    await load(report);
    notice.textContent = setupNotices[report.status] || "Setup updated.";
  } catch (error) {
    button.disabled = false;
    notice.textContent = `Could not complete setup: ${error.message}`;
  }
}
// Complete all, with the open run's parts, or what an admin must grant first.
// A report from Complete all replaces the stored one, since it carries the
// reasons a part is blocked right now.
function setupButton(label, repository, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = demoMode;
  button.onclick = () => void completeAll(button, repository, action);
  return button;
}
// Outfitter's agent workflows for a repository that has not opted into
// agents: a separate, explicit action, never part of plain Complete all.
function agentsOffer(setup, repository, report) {
  const agents = setup.agents;
  // An open run already carries the agent part when it planned it; its
  // Complete all resumes it.
  if (!agents || agents.optedIn || report) return [];
  const nodes = [
    paragraph(
      "This repository has no agent workflows or .agents/ catalog. Complete all with agents also installs Outfitter's triage, implement and review workflows and a starter .agents/ catalog through a pull request; existing files are never overwritten. They need ai-outfitter/actions v1 with the inference-gateway input.",
    ),
  ];
  for (const reason of agents.blocked || []) nodes.push(paragraph(reason));
  if (agents.canInstall) nodes.push(setupButton("Complete all with agents", repository, "install-agent-workflows"));
  else if (!agents.blocked?.length && agents.missingPermissions?.length)
    nodes.push(...permissionNotice(agents.missingPermissions, repository));
  return nodes;
}
function renderSetup(result, latest) {
  const box = el("governance-setup");
  box.replaceChildren();
  const setup = result.setup;
  if (!setup) return;
  const report = latest || setup.report;
  const offer = agentsOffer(setup, result.repository, setup.report);
  if (report?.status === "nothing-to-do" && !setup.applicable) {
    box.append(...setupReport(report, result.repository), ...offer);
    return;
  }
  if (!setup.applicable && !report) {
    box.append(...offer);
    return;
  }
  const heading = document.createElement("h3");
  heading.textContent = "Complete setup";
  box.append(
    heading,
    paragraph(
      "Complete all makes CI run on merge_group, then requires a merge queue, lets GitHub Actions create and approve pull requests, turns on auto-merge for the repository, and, in a repository that uses agents, adds Outfitter's agent workflows and catalog files that are absent, doing only the parts still missing. Changes are made by the GitHub App; a pull request is opened when the default branch requires one or agent files are added.",
    ),
  );
  if (report) box.append(...setupReport(report, result.repository));
  const missing = [...new Set([...(setup.missingPermissions || []), ...(latest?.missingPermissions || [])])];
  if (missing.length) box.append(...permissionNotice(missing, result.repository));
  // Why Complete all leaves an opted-in repository's agent files alone.
  if (setup.agents?.optedIn)
    box.append(...(setup.agents.blocked || []).map((reason) => paragraph(reason)));
  if (setup.canComplete && report?.status !== "complete")
    box.append(setupButton("Complete all", result.repository));
  box.append(...offer);
}
// Informational notes on the agent workflows, such as a floating action tag.
// What Complete all will not overwrite is shown with the setup.
function renderAgentWorkflows(result) {
  const remediation = document.querySelector('[data-rule="Agent workflows"] [data-remediation]');
  if (!remediation) return;
  remediation.replaceChildren(...(result.agentWorkflows?.notes || []).map((note) => paragraph(note)));
}
function mergeGroupRemediation(result) {
  const parts = ["Workflows without a ", code("merge_group"), " trigger: "];
  result.mergeQueue.workflows.forEach((file, index) => {
    if (index) parts.push(", ");
    parts.push(
      externalLink(
        file,
        `https://github.com/${result.repository}/blob/${encodeURIComponent(result.revision)}/.github/workflows/${encodeURIComponent(file)}`,
      ),
    );
  });
  parts.push(".");
  return [paragraph(...parts)];
}
function renderMergeQueue(result) {
  const row = document.querySelector('[data-rule="Merge queue required"]');
  const remediation = row.querySelector("[data-remediation]");
  remediation.replaceChildren();
  const queue = result.mergeQueue;
  if (!queue) return;
  const status = mergeQueueNotes[queue.status] ? queue.status : "unknown";
  indicator(row, status, mergeQueueNotes[status]);
  row.querySelector("[data-check-note]").textContent = ` ${mergeQueueNotes[status]}`;
  if (status === "merge-group-missing")
    remediation.append(...mergeGroupRemediation(result));
}
// Informational: off is a choice, never a failing check.
function renderDraftPolicy(result) {
  const row = document.querySelector('[data-policy="draft-pull-requests"]');
  if (typeof result.draftPullRequests !== "boolean") return;
  const note = draftPolicyText({ draftPullRequests: result.draftPullRequests });
  indicator(row, result.draftPullRequests ? "present" : "info", note);
  row.querySelector("[data-check-note]").textContent = ` ${note}`;
}
function render(result, latest) {
  el("governance-snapshot").textContent =
    `Default branch: ${result.defaultBranch} · Revision: ${result.revision.slice(0, 7)} · Checked: ${new Date(result.checkedAt).toLocaleString()}`;
  for (const row of document.querySelectorAll("[data-document]")) {
    const check = result.documents.find(doc => doc.name === row.dataset.document);
    const status = check?.status || "unknown";
    indicator(row, status, status === "present" ? "Present" : status === "missing" ? "Missing" : "Unable to check");
    if (status === "present" && check.path) {
      const link = document.createElement("a");
      link.textContent = row.dataset.document;
      link.href = `https://github.com/${result.repository}/blob/${encodeURIComponent(result.revision)}/${check.path.split("/").map(encodeURIComponent).join("/")}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.querySelector("[data-file]").replaceChildren(link);
    }
  }
  renderRules(result.rules);
  renderAgentWorkflows(result);
  renderMergeQueue(result);
  renderDraftPolicy(result);
  renderSetup(result, latest);
}
function renderChecked(result, latest) {
  render(result, latest);
  notice.textContent = result.documents.some((doc) => doc.status === "unknown")
    ? "Some files could not be checked. Refresh to try again."
    : "Repository document check complete.";
}
function checkFailed(message) {
  reset("Unable to check");
  notice.textContent = `Repository check failed: ${message}`;
}
function selectRepository() {
  const url = new URL(location.href);
  url.searchParams.set("repository", select.value);
  history.replaceState(history.state, "", url);
}
async function load(latest) {
  const current = ++generation;
  refresh.disabled = true;
  reset("Checking…");
  notice.textContent = "Checking repository documents…";
  selectRepository();
  try {
    const result = await api(
      `/api/plugins/github/governance?repository=${encodeURIComponent(select.value)}`,
    );
    if (current !== generation) return;
    renderChecked(result, latest);
  } catch (error) {
    if (current !== generation) return;
    checkFailed(error.message);
  } finally {
    if (current === generation) refresh.disabled = false;
  }
}
async function initialize(signal) {
  try {
    const requested = new URL(location.href).searchParams.get("repository");
    const page = await loadPage("governance", { repository: requested });
    if (signal.aborted) return;
    const repositories = availableRepositories(page.plugin);
    initProject(page);
    select.replaceChildren();
    for (const repo of repositories) {
      const option = document.createElement("option");
      option.value = option.textContent = repo.name;
      select.append(option);
    }
    if (!repositories.length) {
      reset("Select a repository");
      notice.textContent =
        "No available repositories. Manage repository access in Settings.";
      return;
    }
    if (repositories.some((repo) => repo.name === requested))
      select.value = requested;
    select.disabled = false;
    select.onchange = () => void load();
    refresh.onclick = () => void load();
    // The app names the selected repository; the check is the platform's.
    if (page.governance) select.value = page.governance.repository;
    await load();
  } catch (error) {
    if (signal.aborted) return;
    notice.textContent = `Unable to load repositories: ${error.message}`;
  }
}
onPageLoad((signal) => {
  select = el("governance-repository");
  if (!select) return;
  refresh = el("governance-refresh");
  notice = el("governance-notice");
  // A check still running when the page is left must not render.
  signal.addEventListener("abort", () => generation++);
  void initialize(signal);
});
