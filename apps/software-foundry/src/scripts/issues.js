import { onPageLoad } from "@ai-outfitter/ui/page";
import { initProject } from "./project.js";
import {
  api,
  availableRepositories,
  demoMode,
  el,
  loadPage,
  organizationOrigin,
} from "./shared.js";

function residentIdentityView(providers) {
    const provider = providers.toSorted((a, b) => a.installationId.localeCompare(b.installationId)).find((entry) => entry.value.available);
    const values = provider?.value.data?.residents;
    const residents = (Array.isArray(values) ? values : []).filter((resident) => resident && typeof resident.id === "string" && typeof resident.name === "string").toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      residents,
      setupHref: provider?.origin ?? "/templates/resident-agent",
      message: provider
        ? residents.length
          ? "Resident definitions are available, but Agent Operator dispatch is not bound to this site."
          : "Create a resident definition before selecting an organization identity."
        : providers.length ? "The resident identity provider is currently unavailable." : "Install Resident Agent to define organization execution identities.",
    };
}

async function foundryBrowser(signal) {
  let approved = [];
  let canEdit = false;
  let canBrowse = false;
  let issuesLoading = false;
  let runsLoading = false;
  let historyKnown = false;
  let historyError = false;
  let nextOffset = null;
  const inFlight = new Set();
  let statusFilter = "all";
  let oldest = false;
  let executionIdentity = "regular";
  let residentIdentities = new Map();
  // Held from the start: once the page is left, late results land on
  // these detached elements, not on another page's.
  const notice = el("notice");
  const identityNotice = el("identity-notice");
  const selectedRepositories = new Set();
  const issues = new Map();
  const runs = new Map();
  // Next page cursor per repository; null when it has no more open issues.
  const pages = new Map();
  const errors = new Set();
  const submitted = new Map();
  const resumeRequests = new Map();
  const keyFor = (repository, issue) => `${repository}#${issue}`;
  function text(tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  }
  function date(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
  }
  function runStatus(run) {
    if (!run) return historyKnown ? "unrecorded" : "unknown";
    if (run.summary?.status && run.summary.status !== "unknown")
      return run.summary.status;
    if (run.localSubmission) return "pending";
    return run.workflow?.submission === "pending"
      ? "unconfirmed"
      : run.workflow?.submission === "failed"
        ? "failed"
        : "unknown";
  }
  const labels = {
    running: "In progress",
    queued: "Queued",
    pending: "Submitted",
    unconfirmed: "Submission unconfirmed",
    completed: "Completed",
    failed: "Failed",
    "needs-details": "Needs details",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    timed_out: "Timed out",
    unknown: "Status unavailable",
    unrecorded: "No recent workflow",
  };
  const active = (status) => ["running", "queued", "pending"].includes(status);
  const attention = (status) =>
    ["needs-details", "failed", "cancelled", "interrupted", "timed_out", "unconfirmed"].includes(
      status,
    );
  function updateControls() {
    if (signal.aborted) return;
    el("more").disabled = issuesLoading;
    el("more-runs").disabled = runsLoading;
    el("refresh").disabled = issuesLoading || runsLoading;
    el("oldest").disabled = issuesLoading;
    el("clear-filters").disabled = issuesLoading;
  }
  function selectedResident() {
    return executionIdentity === "regular"
      ? undefined
      : residentIdentities.get(executionIdentity);
  }
  function setStatusFilter(value) {
    statusFilter = value;
    document
      .querySelectorAll("[data-filter]")
      .forEach((button) => {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.filter === value),
        );
      });
  }
  function mergeRecordedRuns(entries) {
    // Latest recorded workflow per issue, without duplicating issues already fetched.
    for (const run of [...runs.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )) {
      const repository = run.workflow?.repository;
      const number = run.workflow?.issue;
      if (!repository || !Number.isInteger(number)) continue;
      const key = keyFor(repository, number);
      if (!entries.has(key))
        entries.set(key, {
          repository,
          number,
          title: run.title,
          updatedAt: run.updatedAt,
          url: `https://github.com/${repository}/issues/${number}`,
        });
      const entry = entries.get(key);
      if (!entry.run) entry.run = run;
    }
  }
  function mergedEntries() {
    const entries = new Map(
      [...issues].map(([key, issue]) => [key, { ...issue }]),
    );
    mergeRecordedRuns(entries);
    for (const [key, run] of submitted) {
      const entry = entries.get(key);
      if (entry && (!entry.run || entry.run.updatedAt < run.updatedAt))
        entry.run = run;
    }
    return entries;
  }
  function issueStateCell(run, status) {
    const badge = text("span", "");
    if (run && (run.stale || historyError)) {
      const observed = text("span", "Last observed:");
      observed.className = "status-context";
      badge.append(observed, document.createTextNode(" "));
    }
    const stateLabel = text("span", labels[status] || status);
    stateLabel.className = "status-label";
    badge.append(stateLabel);
    badge.className = "status-pill";
    badge.dataset.state = active(status)
      ? "active"
      : attention(status)
        ? "attention"
        : status;
    const state = text("td", "");
    state.append(badge);
    return state;
  }
  function createActionButtons(repo, entry) {
    const actions = text("div", "");
    actions.className = "actions";
    // issue-to-review triages, opens a draft PR and reviews it, so it needs draft access.
    if (!repo.canDraft) return actions;
    const button = text("button", entry.run?.workspace ? "Resume workflow" : "Run issue to review");
    button.className = "secondary";
    button.dataset.control = "issue-to-review";
    button.onclick = () => startIssue(button, entry);
    actions.append(button);
    return actions;
  }
  function appendWorkflowLink(run, actionsCell) {
    if (!run?.id || !run.workflow?.id || !organizationOrigin) return;
    const open = text("a", "View workflow →");
    open.href =
      organizationOrigin +
      "/workflows/" + encodeURIComponent(run.workflow.id) + "/runs/" +
      encodeURIComponent(run.id);
    open.className = "workflow-link";
    open.dataset.control = "workflow";
    actionsCell.append(open);
  }
  function canStartIssue(entry,status,repo) {
    return !demoMode && canEdit && entry.open && repo && !active(status) &&
      (!entry.run?.workspace || ["failed","needs-details"].includes(status)) &&
      !inFlight.has(keyFor(entry.repository,entry.number));
  }
  function rerunLabel(run,status) {
    if(run?.workspace)return "Resume";
    return status==="unconfirmed" ? "Retry" : "Run again";
  }
  function appendIssueActions(entry, status, openMenus, row, actionsCell) {
    const { repository, number, run } = entry;
    appendWorkflowLink(run, actionsCell);

    const repo = approved.find((r) => r.name === repository);
    const resident = selectedResident();
    if (resident) {
      const unavailable = text(
        "span",
        `${resident.name} unavailable: Agent Operator dispatch is not bound.`,
      );
      unavailable.className = "status-context";
      actionsCell.append(unavailable);
      return;
    }
    // Historical runs stay readable, but only open, currently approved issues can be started.
    if (canStartIssue(entry,status,repo)) {
      const actions = createActionButtons(repo, entry);
      if (run) {
        const menu = text("details", "");
        menu.className = "issue-rerun";
        const summary = text(
          "summary",
          rerunLabel(run,status),
        );
        summary.dataset.control = "rerun";
        menu.open =
          openMenus.has(row.dataset.issue) || status === "unconfirmed";
        menu.append(summary, actions);
        actionsCell.append(menu);
      } else actionsCell.append(actions);
    }
  }
  function appendIssueRow(entry, openMenus) {
    const { repository, number, run } = entry;
    const status = runStatus(run);
    const row = text("tr", "");
    row.className = "issue-row";
    row.dataset.issue = keyFor(repository, number);
    const copy = text("td", "");
    copy.className = "issue-copy";
    const link = text(entry.url ? "a" : "span", entry.title);
    if (entry.url) {
      link.href = entry.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.className = "issue-title";
    link.dataset.control = "issue";
    copy.append(text("small", `${repository} · #${number}`), link);
    const state = issueStateCell(run, status);
    const actionsCell = text("td", "");
    actionsCell.className = "issue-actions";
    row.append(copy, state, text("td", date(entry.updatedAt)), actionsCell);
    appendIssueActions(entry, status, openMenus, row, actionsCell);
    el("issues").append(row);
  }
  function matchesIssueFilter(entry, status, query) {
    const { repository, number } = entry;
    if (selectedRepositories.size && !selectedRepositories.has(repository))
      return false;
    if (
      query &&
      !`${repository} ${number} ${entry.title}`.toLowerCase().includes(query)
    )
      return false;
    if (statusFilter === "active" && !active(status)) return false;
    if (statusFilter === "completed" && status !== "completed") return false;
    if (statusFilter === "attention" && !attention(status)) return false;
    return true;
  }
  function restoreIssueFocus(focusedRow, focusedControl) {
    if (focusedRow && focusedControl) {
      const row = [...el("issues").children].find(
        (item) => item.dataset.issue === focusedRow,
      );
      [...(row?.querySelectorAll("[data-control]") || [])]
        .find((control) => control.dataset.control === focusedControl)
        ?.focus({ preventScroll: true });
    }
  }
  function updateIssueSummary(focusedRow, focusedControl, entries, visible) {
    restoreIssueFocus(focusedRow, focusedControl);
    el("issue-count").textContent =
      visible + (visible === 1 ? " issue" : " issues");
    el("empty").hidden = visible > 0;
    el("empty").textContent =
      issuesLoading || runsLoading
        ? "Loading issues and workflow activity…"
        : entries.size
          ? "No issues match these filters."
          : "No open issues or recent workflows to show.";
    el("more").hidden = ![...pages.values()].some((page) => page !== null);
    el("more-runs").hidden = nextOffset === null;
    updateControls();
    el("issues-notice").textContent = errors.size
      ? "Could not load: " +
        [...errors].join(", ") +
        ". Refresh to retry; other repositories are still shown."
      : "";
    el("runs-notice").textContent = historyError
      ? "Workflow updates are unavailable. Showing the last observed activity."
      : "";
  }
  function orderedEntries(entries) {
    const ordered = [...entries.values()].sort((a, b) => {
      const aTime = new Date(
        oldest ? a.createdAt || a.updatedAt : a.updatedAt,
      ).getTime();
      const bTime = new Date(
        oldest ? b.createdAt || b.updatedAt : b.updatedAt,
      ).getTime();
      return oldest ? aTime - bTime : bTime - aTime;
    });
    return ordered;
  }
  function render() {
    // Requests from a page that has been left finish without drawing.
    if (signal.aborted) return;
    const focused = document.activeElement;
    const focusedRow = focused?.closest("[data-issue]")?.dataset.issue;
    const focusedControl = focused?.dataset.control;
    const openMenus = new Set(
      [...el("issues").querySelectorAll(".issue-rerun[open]")].map(
        (menu) => menu.closest("[data-issue]").dataset.issue,
      ),
    );
    const entries = mergedEntries();
    const query = el("search").value.trim().toLowerCase();
    let visible = 0;
    el("issues").replaceChildren();
    const ordered = orderedEntries(entries);
    for (const entry of ordered) {
      if (!matchesIssueFilter(entry, runStatus(entry.run), query)) continue;
      visible++;
      appendIssueRow(entry, openMenus);
    }
    updateIssueSummary(focusedRow, focusedControl, entries, visible);
  }
  /** A v2 issue-to-review run in the shape the issue table renders. */
  function issueRun(run) {
    const event = run.inputs?.["triage.inputs.event"] || run.inputs?.["land.inputs.event"];
    const issue = run.inputs?.["triage.inputs.issue"] || {number:event?.issue?.number,title:event?.issue?.title,repository:event?.repository?.full_name};
    return {
      id: run.id,
      workspace: ["issue-to-merge-workspace", "issue-to-merge-actions-ci", "foundry-land-reviewed-change"].includes(run.workflow?.id) || Boolean(event),
      title: issue.title,
      updatedAt: run.updatedAt,
      workflow: { id: run.workflow?.id, repository: issue.repository, issue: issue.number },
      summary: { status: run.status === "complete" ? "completed" : run.status },
    };
  }
  async function fetchRunPages() {
    const result = await api("/api/workflow-runs?workflow=issue-to-review,issue-to-merge-workspace,issue-to-merge-actions-ci,foundry-land-reviewed-change");
    const refreshed = new Map();
    for (const run of result.items) refreshed.set(run.id, issueRun(run));
    return { refreshed, offset: null };
  }
  function reconcileRuns(refreshed, append, offset) {
    if (!append) runs.clear();
    for (const run of refreshed.values()) {
      runs.set(run.id, run);
      const key = keyFor(run.workflow?.repository, run.workflow?.issue);
      if (submitted.get(key)?.id === run.id) submitted.delete(key);
    }
    nextOffset = offset;
    historyKnown = true;
    historyError = false;
  }
  async function refreshRuns(append = false) {
    if (runsLoading) return;
    runsLoading = true;
    updateControls();
    try {
      const { refreshed, offset } = await fetchRunPages(append);
      reconcileRuns(refreshed, append, offset);
    } catch {
      historyError = true;
    } finally {
      runsLoading = false;
      render();
    }
  }
  function clearRepositoryIssues(name) {
    for (const [key, issue] of issues)
      if (issue.repository === name) issues.delete(key);
  }
  function failRepository(name, append) {
    errors.add(name);
    // A failed refresh must restart at the first page, particularly after a sort change.
    if (!append) {
      pages.delete(name);
      clearRepositoryIssues(name);
    }
  }
  // One repository's page; its own error never drops the other repositories.
  function applyIssuePage(page, append) {
    const name = page.repository;
    if (page.error) return failRepository(name, append);
    if (!append) clearRepositoryIssues(name);
    for (const issue of page.issues)
      issues.set(keyFor(name, issue.number), {
        ...issue,
        repository: name,
        open: true,
      });
    pages.set(name, page.nextCursor);
    errors.delete(name);
  }
  function applyIssuePages(result, requested, append) {
    if (result.error) {
      for (const name of requested) failRepository(name, append);
      return;
    }
    for (const page of result.repositories) applyIssuePage(page, append);
  }
  // Every requested repository in one request; Load more sends each
  // repository's cursor.
  async function fetchIssuePages(requested, append, order) {
    const query = new URLSearchParams({ order });
    for (const name of requested) {
      query.append("repository", name);
      // A repository without a cursor, such as one that failed, restarts.
      query.append("cursor", (append && pages.get(name)) || "");
    }
    try {
      return await api(`/api/apps/software-foundry/issues?${query}`);
    } catch (error) {
      return { error: error.message };
    }
  }
  async function loadIssues(append = false) {
    if (issuesLoading || !canBrowse) return;
    const requested = approved
      .map((repo) => repo.name)
      .filter((name) => !append || pages.get(name) !== null);
    if (!requested.length) return;
    issuesLoading = true;
    updateControls();
    const order = oldest ? "oldest" : "recent";
    const result = await fetchIssuePages(requested, append, order);
    applyIssuePages(result, requested, append);
    issuesLoading = false;
    render();
  }
  // The bootstrap's first pages, or the issues endpoint when it had none.
  async function firstIssues(page) {
    if (!page.issues) return loadIssues();
    applyIssuePages(
      page.issues,
      approved.map((repo) => repo.name),
      false,
    );
    render();
  }
  async function submitIssue(entry,key) {
    const {repository,number,title}=entry;
    if(entry.run?.workspace) {
      let resume=resumeRequests.get(key);
      if(resume?.runId!==entry.run.id){resume={runId:entry.run.id,requestId:crypto.randomUUID()};resumeRequests.set(key,resume);}
      const accepted=await api("/api/apps/software-foundry/workspace-issues",{method:"POST",body:JSON.stringify({repository,number,resume})});
      return {...entry.run,id:accepted.id,updatedAt:Date.now(),summary:{status:"running"}};
    }
      const run = await api("/api/workflow-runs", {
        method: "POST",
        body: JSON.stringify({
          workflow: "issue-to-review",
          inputs: {
            "triage.inputs.issue": {
              repository,
              number,
              url: `https://github.com/${repository}/issues/${number}`,
              title,
            },
          },
        }),
      });
      return issueRun(run);
  }
  async function startIssue(button, entry) {
    const { repository, number, title } = entry;
    const key = keyFor(repository, number);
    if (submitted.has(key) || inFlight.has(key)) return;
    inFlight.add(key);
    button.disabled = true;
    button.textContent = "Submitting…";
    try {
      const run=await submitIssue(entry,key);
      submitted.set(key,{...run,localSubmission:true});
      render();
      await refreshRuns();
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      inFlight.delete(key);
      render();
    }
  }
    el("refresh").onclick = () => {
      void loadIssues();
      void refreshRuns();
    };
    el("more").onclick = () => loadIssues(true);
    el("more-runs").onclick = () => refreshRuns(true);
    el("search").oninput = render;
    el("oldest").onclick = () => {
      oldest = !oldest;
      el("oldest").setAttribute("aria-pressed", String(oldest));
      void loadIssues();
      render();
    };
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.onclick = () => {
        setStatusFilter(button.dataset.filter);
        render();
      };
    });
    el("clear-filters").onclick = () => {
      selectedRepositories.clear();
      el("search").value = "";
      setStatusFilter("all");
      document
        .querySelectorAll("#repository-filters input")
        .forEach((input) => {
          input.checked = false;
        });
      if (oldest) {
        oldest = false;
        el("oldest").setAttribute("aria-pressed", "false");
        void loadIssues();
      }
      render();
    };
    el("execution-identity").onchange = () => {
      executionIdentity = el("execution-identity").value;
      const resident = selectedResident();
      el("identity-notice").textContent = resident
        ? `${resident.name} is selectable but cannot run work until this site has a verified Agent Operator binding. Regular execution was not substituted.`
        : "Regular Foundry execution uses the existing workflow runner.";
      render();
    };
  try {
    const { providers } = await api("/api/platform/features/resident-identities");
    if (signal.aborted) return;
    const identities = residentIdentityView(providers);
    residentIdentities = new Map(
      identities.residents.map((resident) => [resident.id, resident]),
    );
    for (const resident of identities.residents) {
      const option = document.createElement("option");
      option.value = resident.id;
      option.textContent = `${resident.name} (${resident.profileRef}) — unavailable`;
      el("execution-identity").append(option);
    }
    identityNotice.textContent = identities.message;
    const setupHref = identities.setupHref?.startsWith("http")
      ? identities.setupHref
      : organizationOrigin && identities.setupHref
        ? organizationOrigin + identities.setupHref
        : null;
    if (setupHref) {
      el("resident-setup").href = setupHref;
      el("resident-setup").hidden = false;
    }
  } catch (error) {
    identityNotice.textContent =
      `Resident execution identities are unavailable. ${error.message}`;
  }
  const history = refreshRuns();
  try {
    const page = await loadPage("issues", { order: "recent" });
    if (signal.aborted) return;
    const plugin = page.plugin;
    initProject(page);
    approved = availableRepositories(plugin);
    canEdit = Boolean(plugin.canEdit);
    canBrowse = approved.length > 0;
      for (const repo of approved) {
        const label = text("label", "");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.onchange = () => {
          if (checkbox.checked) selectedRepositories.add(repo.name);
          else selectedRepositories.delete(repo.name);
          render();
        };
        label.append(checkbox, document.createTextNode(repo.name));
        el("repository-filters").append(label);
      }
      notice.textContent = approved.length ? "" : "No repositories available. Manage repository access on GitHub.";
      await firstIssues(page);
  } catch (error) {
    notice.textContent =
      `Repository access is unavailable. ${error.message}`;
  }
  await history;
  if (signal.aborted) return;
    render();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refreshRuns();
    }, 30000);
    signal.addEventListener("abort", () => clearInterval(poll));
}

onPageLoad((signal) => {
  if (!el("issues")) return;
  void foundryBrowser(signal);
});
