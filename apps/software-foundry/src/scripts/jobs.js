import { onPageLoad } from "@ai-outfitter/ui/page";
import { initProject } from "./project.js";
import {
  api,
  availableRepositories,
  demoMode,
  el,
  external,
  loadPage,
  text,
} from "./shared.js";

// Repository jobs run as v2 workflow runs on the repository picked above; each
// run's one record is the batch of issues it filed.
const REPOSITORY_INPUT = "analyze.inputs.repository";
const ISSUES_OUTPUT = "analyze.outputs.issues";
const JOBS = "/api/apps/software-foundry/jobs";
const statuses = {
  running: "In progress",
  complete: "Completed",
  failed: "Failed",
};
let notice = null;
let select = null;
let buttons = [];
let scheduleButtons = [];
let schedules = [];

function issuesCell(run) {
  const cell = document.createElement("td");
  const filed = run.rows?.[ISSUES_OUTPUT]?.value?.issues;
  if (run.dispatch?.error) cell.append(text("span", run.dispatch.error));
  else if (!filed) cell.append(text("span", "—"));
  else if (!filed.length) cell.append(text("span", "None needed"));
  else
    for (const issue of filed) {
      cell.append(external(`#${issue.number} ${issue.title}`, issue.url));
      cell.append(document.createElement("br"));
    }
  return cell;
}

function runRow(run) {
  const row = document.createElement("tr");
  const started = document.createElement("td");
  const when = new Date(run.createdAt).toLocaleString();
  const link = document.createElement("a");
  link.href = `/workflows?workflow=${encodeURIComponent(run.workflow?.id ?? "")}&run=${encodeURIComponent(run.id)}`;
  link.textContent = when;
  started.append(link);
  row.append(
    started,
    text("td", run.inputs?.[REPOSITORY_INPUT] ?? ""),
    text("td", statuses[run.status] ?? run.status),
    issuesCell(run),
  );
  return row;
}

async function loadRuns(job) {
  const table = el(`job-runs-${job}`);
  const empty = el(`job-empty-${job}`);
  try {
    const { items } = await api(
      `/api/workflow-runs?workflow=${encodeURIComponent(job)}`,
    );
    table.replaceChildren(...items.map(runRow));
    empty.hidden = items.length > 0;
  } catch (error) {
    empty.hidden = false;
    empty.textContent = error.message;
  }
}

// A schedule's line: its repository, whether it is on, and its last outcome,
// which carries the reason when it paused itself.
function scheduleItem(schedule, canEdit) {
  const repository = schedule.inputs?.[REPOSITORY_INPUT] ?? "";
  const item = text(
    "li",
    `${repository} · ${schedule.enabled ? "On" : "Paused"}${schedule.lastOutcome ? ` · last: ${schedule.lastOutcome}` : ""}`,
  );
  if (canEdit) {
    const toggle = text("button", schedule.enabled ? "Pause" : "Resume");
    toggle.className = "secondary";
    toggle.onclick = () =>
      void changeJob(
        { action: "schedule", job: schedule.workflowId, repository, enabled: !schedule.enabled },
        `${schedule.enabled ? "Paused" : "Resumed"} on ${repository}.`,
      );
    item.append(" ", toggle);
  }
  return item;
}

function renderSchedules(canEdit) {
  for (const button of scheduleButtons) {
    const job = button.dataset.schedule;
    // Absent once the page has been left.
    el(`job-schedules-${job}`)?.replaceChildren(
      ...schedules
        .filter((schedule) => schedule.workflowId === job)
        .map((schedule) => scheduleItem(schedule, canEdit)),
    );
  }
}

async function loadSchedules(canEdit) {
  schedules = (await api(JOBS)).items;
  renderSchedules(canEdit);
}

// Runs or schedules a job through Foundry, which approves the job's workspace
// agent on the repository first.
async function changeJob(body, done) {
  // This page's notice, even when a reply arrives after the next page swapped in.
  const status = notice;
  try {
    await api(JOBS, { method: "POST", body: JSON.stringify(body) });
    status.textContent = done;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function schedule(button) {
  button.disabled = true;
  await changeJob(
    { action: "schedule", job: button.dataset.schedule, repository: select.value },
    `Scheduled on ${select.value}.`,
  );
  button.disabled = false;
  await loadSchedules(true);
}

async function run(button) {
  const job = button.dataset.job;
  button.disabled = true;
  button.textContent = "Starting…";
  await changeJob(
    { action: "run", job, repository: select.value },
    `Started on ${select.value}. Issues appear here as the agent files them.`,
  );
  button.textContent = "Run now";
  button.disabled = false;
  await loadRuns(job);
}

async function initialize(signal) {
  const [page] = await Promise.all([
    loadPage("dashboard"),
    ...buttons.map((button) => loadRuns(button.dataset.job)),
  ]);
  if (signal.aborted) return;
  const plugin = page.plugin;
  initProject(page);
  const canEdit = !demoMode && Boolean(plugin.canEdit);
  await loadSchedules(canEdit);
  if (signal.aborted) return;
  const repositories = availableRepositories(plugin);
  select.replaceChildren(
    ...repositories.map((repo) => {
      const option = text("option", repo.name);
      option.value = repo.name;
      return option;
    }),
  );
  if (!repositories.length) {
    notice.textContent =
      "No available repositories. Manage repository access in Settings.";
    return;
  }
  if (demoMode) {
    notice.textContent =
      "Jobs run against your own repositories once installed.";
    select.disabled = false;
    return;
  }
  if (!plugin.canEdit) {
    notice.textContent = "An organization administrator can run jobs.";
    return;
  }
  notice.textContent =
    "Each run files a few issues, and Foundry fixes and merges each one.";
  select.disabled = false;
  for (const button of buttons) {
    button.disabled = false;
    button.onclick = () => void run(button);
  }
  for (const button of scheduleButtons) {
    button.disabled = false;
    button.onclick = () => void schedule(button);
  }
}

onPageLoad((signal) => {
  select = el("job-repository");
  if (!select) return;
  notice = el("job-notice");
  buttons = [...document.querySelectorAll("button[data-job]")];
  scheduleButtons = [...document.querySelectorAll("button[data-schedule]")];
  schedules = [];
  initialize(signal).catch((error) => {
    if (!signal.aborted) notice.textContent = error.message;
  });
});
