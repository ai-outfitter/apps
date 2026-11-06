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
let members = [];
let canReassign = false;

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

// A schedule's line: its repository, its owner, whether it is on, and its last
// outcome, which carries the reason when it paused itself.
function scheduleItem(schedule, canEdit) {
  const path = `/api/workflow-schedules/${encodeURIComponent(schedule.id)}`;
  const owner = members.find((member) => member.id === schedule.createdBy);
  const item = text(
    "li",
    `${schedule.inputs?.[REPOSITORY_INPUT] ?? ""}${owner ? ` · owner: ${owner.name}` : ""} · ${schedule.enabled ? "On" : "Paused"}${schedule.lastOutcome ? ` · last: ${schedule.lastOutcome}` : ""}`,
  );
  if (canEdit) {
    const toggle = text("button", schedule.enabled ? "Pause" : "Resume");
    toggle.className = "secondary";
    toggle.onclick = () =>
      void changeSchedule(path, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
    const remove = text("button", "Remove");
    remove.className = "secondary";
    remove.onclick = () => void changeSchedule(path, { method: "DELETE" });
    item.append(" ", toggle, " ", remove);
  }
  if (canReassign && members.length)
    item.append(" ", reassignControl(schedule, path));
  return item;
}

// Admins move a schedule to another member, for example when its owner leaves.
function reassignControl(schedule, path) {
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", "New owner");
  picker.replaceChildren(
    ...members.map((member) => {
      const option = text("option", member.name);
      option.value = member.id;
      option.selected = member.id === schedule.createdBy;
      return option;
    }),
  );
  const reassign = text("button", "Reassign");
  reassign.className = "secondary";
  reassign.onclick = () =>
    void changeSchedule(path, {
      method: "PATCH",
      body: JSON.stringify({ owner: picker.value }),
    });
  const control = text("span");
  control.append(picker, " ", reassign);
  return control;
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
  const loaded = await api("/api/workflow-schedules");
  schedules = loaded.items;
  members = loaded.members ?? [];
  canReassign = Boolean(loaded.canReassign);
  renderSchedules(canEdit);
}

async function changeSchedule(path, options) {
  try {
    await api(path, options);
  } catch (error) {
    notice.textContent = error.message;
  }
  await loadSchedules(true);
}

async function schedule(button) {
  const job = button.dataset.schedule;
  // This page's notice, even when a reply arrives after the next page swapped in.
  const status = notice;
  if (
    schedules.some(
      (item) =>
        item.workflowId === job &&
        item.inputs?.[REPOSITORY_INPUT] === select.value,
    )
  ) {
    status.textContent = `${select.value} already has this schedule.`;
    return;
  }
  button.disabled = true;
  try {
    await api("/api/workflow-schedules", {
      method: "POST",
      body: JSON.stringify({
        workflow: job,
        inputs: { [REPOSITORY_INPUT]: select.value },
      }),
    });
    status.textContent = `Scheduled on ${select.value}.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    await loadSchedules(true);
  }
}

async function run(button) {
  const job = button.dataset.job;
  const status = notice;
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await api("/api/workflow-runs", {
      method: "POST",
      body: JSON.stringify({
        workflow: job,
        inputs: { [REPOSITORY_INPUT]: select.value },
      }),
    });
    status.textContent = `Started on ${select.value}. Issues appear here as the agent files them.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.textContent = "Run now";
    button.disabled = false;
    await loadRuns(job);
  }
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
    "Each run files at most 10 ranked issues. Send the ones worth doing through issue to review.";
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
  members = [];
  canReassign = false;
  initialize(signal).catch((error) => {
    if (!signal.aborted) notice.textContent = error.message;
  });
});
