// Read-only milestone fixtures in the operational API's response shape.
const milestones = {
  "northstar/platform": [
    {
      number: 3,
      title: "Accessible command menu",
      description:
        "Everyone can run any Northstar command from the keyboard.\nKeyboard and screen reader users open the command menu, reach every command without a mouse and hear how many results match as they type, so the fastest way to work is open to them too.",
      state: "open",
      openItems: 7,
      closedItems: 3,
      dueOn: "2026-10-30T07:00:00Z",
      updatedAt: "2026-10-06T12:00:00Z",
    },
    {
      number: 4,
      title: "Faster cold starts",
      description:
        "Your workspace is ready before you finish reading the issue.\nOpening an issue's workspace now takes under two seconds, so you can try a fix the moment you think of it instead of waiting on a checkout.",
      state: "open",
      openItems: 3,
      closedItems: 2,
      dueOn: "2026-11-13T08:00:00Z",
      updatedAt: "2026-10-08T12:00:00Z",
    },
    {
      number: 5,
      title: "Merge queue for stacks",
      description:
        "Stacked pull requests land together, in order, without babysitting.\nApprove a stack once and Northstar merges each pull request after the one beneath it, retrying checks for you, so a large change ships as one reviewed sequence.",
      state: "open",
      openItems: 2,
      closedItems: 0,
      dueOn: "2026-11-27T08:00:00Z",
      updatedAt: "2026-10-09T12:00:00Z",
    },
    {
      number: 6,
      title: "Audit log export",
      description:
        "Administrators hand auditors a complete activity log in one click.\nExport every sign-in, permission change and deployment as CSV for any date range.",
      state: "open",
      openItems: 1,
      closedItems: 0,
      dueOn: null,
      updatedAt: "2026-10-09T12:00:00Z",
    },
    {
      number: 7,
      title: "Design tokens everywhere",
      description: "",
      state: "open",
      openItems: 1,
      closedItems: 2,
      dueOn: "2026-11-20T08:00:00Z",
      updatedAt: "2026-10-08T12:00:00Z",
    },
    {
      number: 1,
      title: "Release process",
      description: "",
      state: "closed",
      openItems: 0,
      closedItems: 2,
      dueOn: null,
      updatedAt: "2026-09-20T12:00:00Z",
    },
  ],
  "northstar/interface": [
    {
      number: 2,
      title: "Design tokens everywhere",
      description:
        "Every Northstar screen follows your brand, in light and dark.\nSet your colors and type once and every page, email and embedded widget uses them, so customers see one consistent product.",
      state: "open",
      openItems: 2,
      closedItems: 1,
      dueOn: "2026-11-06T08:00:00Z",
      updatedAt: "2026-10-07T12:00:00Z",
    },
  ],
};
// Issues: [number, title, state, runs, blocked by]. Pull requests: [number,
// title, state, draft, head branch, base branch, closes].
const items = {
  "northstar/platform#3": {
    issues: [
      [39, "Trap focus inside the command menu", "closed", [["draft-pr", "completed"]], []],
      [42, "Clarify keyboard navigation in the command menu", "open", [["triage", "failed"]], [39]],
      [44, "Announce result counts to screen readers", "open", [], [39]],
      [46, "Document command menu shortcuts", "open", [], [42, 44]],
    ],
    pullRequests: [
      [40, "Trap focus inside the command menu", "merged", false, "focus-trap", "main", [39]],
      [43, "Arrow keys move between commands", "open", false, "arrow-keys", "main", [42]],
      [45, "Announce command menu result counts", "open", true, "announce-counts", "main", [44]],
      [47, "Use a polite live region for counts", "open", true, "polite-region", "announce-counts", []],
      [48, "Debounce announcements while typing", "open", true, "debounce-announce", "polite-region", []],
      [41, "Bump the icon set", "merged", false, "icons", "main", []],
    ],
  },
  "northstar/platform#4": {
    issues: [
      [50, "Keep a warm runner image per repository", "open", [["draft-pr", "running"]], []],
      [51, "Stream the checkout into the workspace", "open", [], []],
      [53, "Measure cold start time", "closed", [], []],
    ],
    pullRequests: [
      [52, "Warm image cache keyed by lockfile", "open", false, "warm-image", "main", [50]],
      [54, "Cold start timer", "merged", false, "cold-start-timer", "main", [53]],
    ],
  },
  "northstar/platform#5": {
    issues: [
      [60, "Queue a stack as one merge group", "open", [], []],
      [61, "Rebase stacked branches after a merge", "open", [], [60]],
    ],
    pullRequests: [],
  },
  "northstar/interface#2": {
    issues: [
      [8, "Read brand colors from organization settings", "closed", [], []],
      [9, "Apply tokens to transactional email", "open", [], [8]],
    ],
    pullRequests: [
      [10, "Organization brand tokens", "open", false, "brand-tokens", "main", [9]],
    ],
  },
  "northstar/platform#7": {
    issues: [
      [80, "Serve brand tokens from the organization API", "closed", [], []],
      [82, "Cache brand tokens at the edge", "open", [], [80]],
    ],
    pullRequests: [
      [81, "Brand tokens endpoint", "merged", false, "tokens-api", "main", [80]],
    ],
  },
  "northstar/platform#6": {
    issues: [[70, "Export the audit log as CSV", "open", [], []]],
    pullRequests: [],
  },
  "northstar/platform#1": {
    issues: [[11, "Document the release checklist", "closed", [], []]],
    pullRequests: [[12, "Add the release checklist", "merged", false, "release-checklist", "main", [11]]],
  },
};
const url = (repository, kind, number) =>
  `https://github.com/${repository}/${kind}/${number}`;

export function milestoneFixture(params) {
  const repository = params.get("repository");
  if (!(repository in milestones)) throw new Error("Repository is not approved.");
  const list = milestones[repository].map((milestone) => ({
    ...milestone,
    url: url(repository, "milestone", milestone.number),
  }));
  const number = Number(params.get("milestone"));
  if (!number) {
    const state = params.get("state") === "closed" ? "closed" : "open";
    return {
      repository,
      state,
      milestones: list.filter((milestone) => milestone.state === state),
      truncated: false,
    };
  }
  const milestone = list.find((item) => item.number === number);
  const detail = items[`${repository}#${number}`];
  if (!milestone || !detail) throw new Error("Milestone not found.");
  return {
    repository,
    milestone,
    issues: detail.issues.map(([issue, title, state, runs, blockedBy]) => ({
      number: issue,
      title,
      state,
      blockedBy,
      updatedAt: milestone.updatedAt,
      url: url(repository, "issues", issue),
      // Fixture runs have no workflow page to open.
      runs: runs.map(([mode, status]) => ({
        title: `#${issue} ${title}`,
        mode,
        status,
        updatedAt: Date.parse(milestone.updatedAt),
        observedAt: Date.parse(milestone.updatedAt),
      })),
    })),
    pullRequests: detail.pullRequests.map(
      ([pull, title, state, draft, head, base, closes]) => ({
      number: pull,
      title,
      state,
      draft,
      head,
      base,
      closes,
      updatedAt: milestone.updatedAt,
      url: url(repository, "pull", pull),
    })),
    truncated: false,
  };
}
