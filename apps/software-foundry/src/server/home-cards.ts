import {
  defineHomeCard,
  homeCardLimits,
  type HomeCardLinkTarget,
  type HomeCardNode,
  type HomeCardSize,
  type HomeCardTimelineItemOf,
  type HomeCardTimelineState,
} from "@ai-outfitter/app-sdk/home-cards";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type {
  OperationOutput,
  WorkflowHost,
} from "@ai-outfitter/app-sdk/workflow-host";
import { listProjects, type FoundryDatabase, type FoundryProject } from "./projects";
import { foundryLandingWorkflow } from "./workspace/landing-recovery";
import {
  foundryWorkspaceWorkflow,
  historicalFoundryWorkspaceWorkflow,
} from "./workspace/workspaces";

// The card reads only installation-scoped workflow records through the trusted
// host. It does not call GitHub or read platform storage directly.
const foundryWorkflows = [
  foundryWorkspaceWorkflow,
  historicalFoundryWorkspaceWorkflow,
  foundryLandingWorkflow,
];
const inputSlots = [
  "triage.inputs.event",
  "land.inputs.event",
  "triage.inputs.issue",
];
const activeLimits: Record<HomeCardSize, number> = {
  small: 1,
  medium: 3,
  large: 3,
};
const shippedLimits: Record<HomeCardSize, number> = {
  small: 1,
  medium: 1,
  large: 3,
};

type Activity = OperationOutput<"workflow.activity">["items"][number];
type JSONObject = Record<string, unknown>;

function object(value: unknown): JSONObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JSONObject)
    : undefined;
}

function runInput(run: Pick<Activity, "inputs">) {
  return (
    object(run.inputs["triage.inputs.event"]) ??
    object(run.inputs["land.inputs.event"]) ??
    object(run.inputs["triage.inputs.issue"])
  );
}

/** The `owner/name` repository a run works in, when its inputs name one. */
function runRepository(run: Pick<Activity, "inputs">) {
  const input = runInput(run);
  const repository = object(input?.repository);
  return typeof input?.repository === "string"
    ? input.repository
    : repository && typeof repository.full_name === "string"
      ? repository.full_name
      : undefined;
}

/** A run's presentation label from its recorded issue or event inputs. */
export function runLabel(run: Pick<Activity, "inputs">) {
  const input = runInput(run);
  const issue = object(input?.issue) ?? input;
  const title = issue && typeof issue.title === "string" ? issue.title : undefined;
  const number = issue && typeof issue.number === "number" ? issue.number : undefined;
  const repositoryName = runRepository(run);
  const label = title ?? (number ? `Issue #${number}` : "Foundry work");
  return {
    // Issue titles can be longer than a card title may be.
    title: label.length > homeCardLimits.title ? `${label.slice(0, homeCardLimits.title - 1)}…` : label,
    subtitle: [repositoryName, number ? `#${number}` : undefined]
      .filter(Boolean)
      .join(" "),
  };
}

function elapsed(timestamp: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function runPath(run: Activity) {
  return `/workflows?workflow=${encodeURIComponent(run.workflowId)}&run=${encodeURIComponent(run.id)}`;
}

function items(runs: Activity[], active: boolean, canOpenRuns: boolean) {
  return runs.map((run) => {
    const text = runLabel(run);
    return {
      id: run.id,
      title: text.title,
      ...(text.subtitle ? { subtitle: text.subtitle } : {}),
      meta: active ? elapsed(run.createdAt) : `${elapsed(run.updatedAt)} ago`,
      ...(canOpenRuns ? { link: { path: runPath(run) } } : {}),
    };
  });
}

export async function readProjects(
  host: WorkflowHost<"interactive">,
  size: HomeCardSize,
  canOpenRuns = false,
): Promise<HomeCardNode[]> {
  const [active, shipped] = await Promise.all([
    host.call("workflow.activity", {
      slots: inputSlots,
      workflows: foundryWorkflows,
      statuses: ["running"],
      limit: activeLimits[size],
    }),
    host.call("workflow.activity", {
      slots: inputSlots,
      workflows: foundryWorkflows,
      statuses: ["complete"],
      limit: shippedLimits[size],
    }),
  ]);
  const body: HomeCardNode[] = [
    {
      kind: "metric",
      label: "Active work",
      value: active.total,
      detail: shipped.total
        ? `${shipped.total} shipped recently`
        : "No recently shipped work",
    },
  ];
  if (active.items.length)
    body.push({
      kind: "list",
      label: "Active work",
      items: items(active.items, true, canOpenRuns),
    });
  else
    body.push({
      kind: "text",
      text: "No Foundry work is active.",
      tone: "neutral",
      emphasis: "muted",
    });
  if (shipped.items.length)
    body.push({
      kind: "list",
      label: "Recently shipped",
      items: items(shipped.items, false, canOpenRuns),
    });
  return body;
}

// The status timeline (docs/home-cards.md, "timeline"): shipped, in-flight
// and stopped Foundry work grouped by day (UTC), then by Foundry project in the
// projects page's priority order. A run's stage comes from which steps the host
// reports as complete, so the card never calls GitHub or reads step outputs.
const DAY = 24 * 60 * 60_000;
const timelineWindow = 7 * DAY;
const dayLabels = ["Today", "Yesterday", "Earlier this week"] as const;
/** Projects per day before the rest fold into "Other work" (the SDK allows 12). */
const projectsPerDay = 11;
type TimelineItem = HomeCardTimelineItemOf<HomeCardLinkTarget>;
type Stage = Pick<TimelineItem, "state" | "detail">;

/** What a running run is doing once its furthest completed step is done, in step order. */
const stages: [step: string, stage: Stage][] = [
  ["triage", { state: "in-progress", detail: "builder agent" }],
  ["implement", { state: "in-progress", detail: "checks" }],
  ["validate", { state: "agent-review", detail: "reviewer agent" }],
  ["review", { state: "in-progress", detail: "fixes and final checks" }],
  ["repair", { state: "in-progress", detail: "final checks" }],
  ["validate-final", { state: "agent-review", detail: "final review" }],
  ["review-final", { state: "in-progress", detail: "landing" }],
];

/** Where a run stands, and a short note on who has it. Shipped means the land step finished. */
export function runState(run: Pick<Activity, "status" | "workflowId" | "completedSteps">): Stage {
  const done = new Set(run.completedSteps ?? []);
  if (done.has("land")) return { state: "shipped" };
  if (run.status === "failed") return { state: "needs-you", detail: "stopped before landing" };
  // Complete without landing: triage asked for more detail instead of starting work.
  if (run.status === "complete") return { state: "needs-you", detail: "triage needs more detail" };
  if (run.workflowId === foundryLandingWorkflow) return { state: "in-progress", detail: "landing" };
  const furthest = stages.findLast(([step]) => done.has(step));
  return furthest ? furthest[1] : { state: "planning", detail: "triage agent" };
}

function dayLabel(timestamp: number, now: number) {
  const days = Math.floor(now / DAY) - Math.floor(timestamp / DAY);
  return dayLabels[Math.min(2, Math.max(0, days))];
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A one-line status update from the counts the timeline shows. */
export function timelineSummary(states: HomeCardTimelineState[]) {
  const count = (state: HomeCardTimelineState) => states.filter((s) => s === state).length;
  const shipped = count("shipped");
  const review = count("agent-review");
  const flight = count("in-progress") + count("planning") + review;
  const needs = count("needs-you");
  const parts = [
    shipped ? `${plural(shipped, "change")} shipped this week` : "Nothing shipped this week",
    flight ? `${flight} in flight${review ? ` (${review} with reviewer agents)` : ""}` : "",
    needs ? `${needs} ${needs === 1 ? "needs" : "need"} a person` : "",
  ].filter(Boolean);
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`;
}

export function statusTimeline(
  runs: Activity[],
  projects: Pick<FoundryProject, "id" | "name" | "repositories">[],
  canOpenRuns: boolean,
  now = Date.now(),
): HomeCardNode[] {
  // A run that finishes between the running and finished reads comes back twice: keep its newer copy.
  const latest = new Map<string, Activity>();
  for (const run of runs) if ((latest.get(run.id)?.updatedAt ?? -1) < run.updatedAt) latest.set(run.id, run);
  const rank = (run: Activity) => {
    const repository = runRepository(run)?.toLowerCase();
    const index = repository ? projects.findIndex((project) => project.repositories.includes(repository)) : -1;
    return index < 0 ? projects.length : index;
  };
  // In priority order, so each day's projects are inserted most important first and "Other work" last.
  const recent = [...latest.values()]
    .filter((run) => run.status === "running" || now - run.updatedAt <= timelineWindow)
    .map((run) => ({ run, rank: rank(run) }))
    .sort((a, b) => a.rank - b.rank);
  if (!recent.length)
    return [{ kind: "empty", text: "No Foundry work this week. Shipped and in-flight work appears here." }];
  const groups = new Map<string, Map<string, { title: string; items: TimelineItem[] }>>();
  const states: HomeCardTimelineState[] = [];
  for (const { run, rank } of recent) {
    const project = projects[rank];
    const label = dayLabel(run.updatedAt, now);
    const day = groups.get(label) ?? new Map();
    groups.set(label, day);
    const key = project?.id ?? "other";
    const entry = day.get(key) ?? { title: project?.name ?? "Other work", items: [] };
    day.set(key, entry);
    const stage = runState(run);
    states.push(stage.state);
    entry.items.push({
      id: run.id,
      title: runLabel(run).title,
      ...stage,
      ...(canOpenRuns ? { link: { path: runPath(run) }, verb: stage.state === "needs-you" ? "review" as const : "open" as const } : {}),
    });
  }
  return [{
    kind: "timeline",
    summary: timelineSummary(states),
    groups: dayLabels.flatMap((label) => {
      const day = groups.get(label);
      if (!day) return [];
      const projects = [...day].map(([id, entry]) => ({ id, ...entry }));
      // A busy day keeps its most important projects; the rest share "Other work".
      if (projects.length <= projectsPerDay + 1) return [{ label, projects }];
      const rest = projects.slice(projectsPerDay).flatMap((project) => project.items);
      return [{ label, projects: [...projects.slice(0, projectsPerDay), { id: "other", title: "Other work", items: rest }] }];
    }),
  }];
}

async function readStatusTimeline(
  host: WorkflowHost<"interactive">,
  db: FoundryDatabase,
  identity: AppIdentity,
): Promise<HomeCardNode[]> {
  // Running work is read on its own so a busy week of finished runs never hides it.
  const read = (statuses: Activity["status"][]) => host.call("workflow.activity", {
    slots: inputSlots, workflows: foundryWorkflows, statuses, limit: 20, steps: true,
  });
  const [running, finished, { projects }] = await Promise.all([
    read(["running"]),
    read(["complete", "failed"]),
    listProjects(db, identity),
  ]);
  return statusTimeline([...running.items, ...finished.items], projects, identity.canEdit);
}

export function homeCards(host: () => WorkflowHost<"interactive">, db: () => FoundryDatabase) {
  return [
    defineHomeCard({
      cardId: "projects",
      title: "Foundry projects",
      description:
        "Active Foundry work and recently shipped changes from recorded workflow activity.",
      sizes: ["small", "medium", "large"],
      defaultSize: "medium",
      read: async ({ size, identity }) => ({ body: await readProjects(host(), size, identity.canEdit) }),
    }),
    defineHomeCard({
      cardId: "status",
      title: "Status",
      description:
        "A status timeline of this week's Foundry work by project: shipped, in flight, in agent review and needing a person.",
      sizes: ["large"],
      defaultSize: "large",
      read: async ({ identity }) => ({ body: await readStatusTimeline(host(), db(), identity) }),
    }),
  ];
}
