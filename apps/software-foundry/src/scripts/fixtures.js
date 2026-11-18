import emptyState from "../../fixtures/foundry-issue-to-merge.empty-state.json";
import keyboardNavigation from "../../fixtures/foundry-issue-to-merge.keyboard-navigation.json";
import releaseChecklist from "../../fixtures/foundry-issue-to-merge.release-checklist.json";
import settingsFocus from "../../fixtures/foundry-issue-to-merge.settings-focus.json";
import emptyStateDelivery from "../../fixtures/issue-to-draft-pr.empty-state.json";
import keyboardNavigationDelivery from "../../fixtures/issue-to-draft-pr.keyboard-navigation.json";
import releaseChecklistDelivery from "../../fixtures/issue-to-draft-pr.release-checklist.json";
import settingsFocusDelivery from "../../fixtures/issue-to-draft-pr.settings-focus.json";
import { milestoneFixture } from "./milestone-fixtures.js";
import { groupMilestones, rankMilestones } from "./ranking.js";

// Demo issue runs are synthetic fixtures rendered read-only; they never enter a live run.
export const scenarios = [keyboardNavigation, emptyState, settingsFocus, releaseChecklist];
const deliveries = Object.fromEntries(
  [emptyStateDelivery, keyboardNavigationDelivery, releaseChecklistDelivery, settingsFocusDelivery].map((fixture) => [fixture.id, fixture]),
);
const repositories = ["northstar/platform", "northstar/interface"];

/** Run state shown for a scenario: a recorded non-success outcome, or the delivery child's progress. */
export function scenarioStatus(scenario) {
  if (Object.keys(scenario.outcomes || {}).length) return "failed";
  return "review" in deliveries[scenario.children.deliver].records ? "completed" : "running";
}

const issueRows = scenarios.map((scenario) => ({
  repository: scenario.inputs.issue.repository,
  number: scenario.inputs.issue.number,
  title: scenario.inputs.issue.title,
  status: scenarioStatus(scenario),
  updatedAt: scenario.inputs.issue.updatedAt,
}));

const plugin = {
  canEdit: false,
  connected: true,
  repositoryAccess: true,
  login: "northstar",
  repositories: repositories.map((name) => ({
    name,
    owner: "northstar",
    kind: "Organization",
    installationId: 42,
    settingsUrl:
      "https://github.com/organizations/northstar/settings/installations/42",
    readiness: { status: "ready", message: "GitHub App is ready." },
    canDraft: false,
  })),
  readiness: Object.fromEntries(
    repositories.map((name) => [
      name,
      { status: "ready", message: "GitHub App is ready." },
    ]),
  ),
};

function governance(repository) {
  if (!repositories.includes(repository))
    throw new Error("Repository is not approved.");
  const established = repository === repositories[0];
  return {
    repository,
    defaultBranch: "main",
    revision: "a".repeat(40),
    checkedAt: "2026-10-06T14:00:00Z",
    documents: ["AGENTS.md", "CONTRIBUTING.md", "DESIGN.md", "CODEOWNERS"].map(
      (name) => ({
        name,
        status: established || name === "AGENTS.md" ? "present" : "missing",
        path: name === "CODEOWNERS" ? ".github/CODEOWNERS" : name,
      }),
    ),
    rules: {
      ...Object.fromEntries(
        [
          "Pull requests required",
          "Direct pushes restricted",
          "Required CI checks",
          "Review approval required",
          "Code-owner approval required",
          "Squash merging enforced",
          "Auto-merge available",
          "GitHub Actions can create and approve pull requests",
        ].map((name) => [name, established ? "Met" : "Missing"]),
      ),
      // Demo repositories have not opted into agents.
      "Agent workflows": "Not installed — Complete all with agents",
    },
    agentWorkflows: { blocked: [], notes: [] },
    mergeQueue: established
      ? { status: "present", workflows: [] }
      : { status: "merge-group-missing", workflows: ["ci.yml"] },
    draftPullRequests: true,
    // Demo mode never calls Complete all; its button renders disabled.
    setup: {
      ...(established
        ? { applicable: false, canComplete: false, missingPermissions: [] }
        : { applicable: true, canComplete: true, missingPermissions: [], report: setupRun(repository) }),
      agents: { optedIn: false, canInstall: true, blocked: [], missingPermissions: [] },
    },
  };
}

// An open SDLC setup run: the app's pull request waits for an admin's bypass
// merge, because the existing queue cannot run CI until merge_group lands.
function setupRun(repository) {
  return {
    status: "running",
    parts: [
      {
        step: "actions-approval",
        label: "Allow GitHub Actions to create and approve pull requests",
        status: "blocked",
        detail:
          "An organization policy forbids it. An organization owner must allow it in the organization's Settings → Actions → General, then press Complete all.",
      },
      {
        step: "pull-request",
        label: "Open pull request #31",
        status: "done",
        url: `https://github.com/${repository}/pull/31`,
      },
      { step: "review", label: "Request review from @northstar-admin", status: "done" },
      {
        step: "merge",
        label: "Merge the pull request",
        status: "waiting",
        detail:
          'The existing merge queue cannot run CI for pull request #31 until it merges, so auto-merge would leave it queued. A repository admin must merge it with "Merge without waiting for requirements" (bypass), then press Complete all.',
      },
    ],
    notes: [],
    missingPermissions: [],
  };
}

// Every fixture repository fits in one page, so there is never a next cursor.
function issuePages(requested, order) {
  return {
    order: order === "oldest" ? "oldest" : "recent",
    repositories: requested.map((repository) => {
      if (!repositories.includes(repository))
        throw new Error("Repository is not approved.");
      const issues = issueRows
        .filter((row) => row.repository === repository)
        .map((row) => ({
          number: row.number,
          title: row.title,
          createdAt: row.updatedAt,
          updatedAt: row.updatedAt,
          run: {
            updatedAt: Date.parse(row.updatedAt),
            summary: { status: row.status },
            workflow: { repository: row.repository, issue: row.number },
          },
        }));
      if (order === "oldest") issues.reverse();
      return { repository, issues, nextCursor: null };
    }),
  };
}

// Foundry projects, highest priority first, each ranking its milestones.
const projects = [
  {
    id: "5a7c1e2d-3b4f-4a6e-9c8d-1f2e3a4b5c6d",
    name: "NORTHSTAR",
    position: 0,
    repositories: ["northstar/platform", "northstar/interface"],
    milestones: ["accessible command menu", "merge queue for stacks"],
    revision: 1,
    updatedAt: Date.parse("2026-10-09T12:00:00Z"),
  },
  {
    id: "8e9f0a1b-2c3d-4e5f-8a7b-6c5d4e3f2a1b",
    name: "DESIGN SYSTEM",
    position: 1,
    repositories: ["northstar/interface"],
    milestones: [],
    revision: 1,
    updatedAt: Date.parse("2026-10-09T12:00:00Z"),
  },
];
function foundry(requested) {
  const active =
    projects.find((project) => project.id === requested) ?? projects[0];
  const open = active.repositories.flatMap((repository) =>
    milestoneFixture(new URLSearchParams({ repository, state: "open" })).milestones.map(
      (milestone) => ({ repository, ...milestone }),
    ),
  );
  return {
    projects: structuredClone(projects),
    active: active.id,
    milestones: rankMilestones(
      active.milestones,
      groupMilestones(active.repositories, open),
    ),
    unread: [],
  };
}

// The page bootstrap in the operational shape: the view plus first data.
function bootstrap(params) {
  const page = params.get("page");
  const requested = params.get("repository");
  const repository = repositories.includes(requested)
    ? requested
    : repositories[0];
  const view = {
    page,
    plugin: structuredClone(plugin),
    foundry: foundry(params.get("project")),
  };
  if (page === "dashboard") return view;
  if (page === "issues")
    return { ...view, issues: issuePages(repositories, params.get("order")) };
  if (page === "governance")
    return { ...view, governance: { repository, result: governance(repository) } };
  if (page !== "milestones") throw new Error("Unknown fixture request");
  const state = params.get("state") === "closed" ? "closed" : "open";
  const scope = new URLSearchParams({ repository, state });
  const list = milestoneFixture(scope);
  let detail = null;
  if (params.get("milestone")) {
    scope.set("milestone", params.get("milestone"));
    try {
      detail = milestoneFixture(scope);
    } catch (error) {
      detail = { error: error.message, status: 404 };
    }
  }
  return { ...view, milestones: { repository, state, list, detail } };
}

export function fixtureResponse(path, options = {}) {
  if (options.method && options.method !== "GET")
    throw new Error("This installation is read-only.");
  const url = new URL(path, "https://fixture.invalid");
  if (url.pathname === "/api/plugins/github") return structuredClone(plugin);
  if (url.pathname === "/api/platform/features/resident-identities")
    return { providers: [{ installationId: "demo-resident", origin: "/templates/resident-agent", value: {
      available: true,
      data: { residents: [{ id: "725c45d7-44c7-4d0c-881c-46447045bb30", name: "Maple", profileRef: "engineering", execution: { status: "unavailable" } }] },
    } }] };
  if (url.pathname === "/api/plugins/github/governance")
    return governance(url.searchParams.get("repository"));
  if (
    url.pathname === "/api/workflow-runs" ||
    url.pathname === "/api/apps/software-foundry/jobs"
  )
    return { items: [] };
  if (url.pathname === "/api/apps/software-foundry/milestones")
    return milestoneFixture(url.searchParams);
  if (url.pathname === "/api/apps/software-foundry/issues")
    return issuePages(
      url.searchParams.getAll("repository"),
      url.searchParams.get("order"),
    );
  if (url.pathname === "/api/apps/software-foundry/projects")
    return { projects: structuredClone(projects), canEdit: false };
  if (url.pathname === "/api/apps/software-foundry/bootstrap")
    return bootstrap(url.searchParams);
  throw new Error("Unknown fixture request");
}
