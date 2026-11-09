import { projectsViewerQuery } from "../../queries/projects";
import { appDataContext } from "@ai-outfitter/app-sdk/database";
import { renderMarkdownBlock } from "@ai-outfitter/app-sdk/graph-markdown";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import {
  type WorkflowHost,
  workflowHost,
} from "@ai-outfitter/app-sdk/workflow-host";
import type { Issue, Project } from "./schema";

export type PageProject = Pick<
  Project,
  | "id"
  | "revision"
  | "name"
  | "githubRepository"
  | "goals"
  | "userStories"
  | "pressRelease"
  | "demoInstructions"
  | "demoResults"
> & {
  rank?: number | null;
  state?: Project["state"];
  /** On the projects list: the open issue count Projects reports. */
  openIssues?: number;
  /** On the projects list: the organization that holds it, or null for the member's own. */
  organizationSlug?: string | null;
  /** On the projects list: where its card opens, when it lives in another installation. */
  href?: string;
  /** On the projects list: readiness from the project's Wiki context. */
  readiness?: {
    stage: string;
    priority: number;
    missing: string[];
    signals: string[];
  };
  /** On the projects list: the Wiki goals the project pursues. */
  goalRecords?: { id: string; title: string }[];
};
export type PageIssue = Pick<
  Issue,
  | "id"
  | "revision"
  | "projectId"
  | "title"
  | "description"
  | "category"
  | "status"
  | "assigneeId"
  | "dueDate"
  | "parentId"
  | "position"
>;
export { projectRows } from "../project-rows";

import { type ProjectWikiBody, readProjectWikiBody } from "./project-wiki-body";
export const projectDocuments = [
  ["goals", "Goals"],
  ["userStories", "User stories"],
  ["pressRelease", "Draft press release"],
  ["demoInstructions", "Demo instructions"],
  ["demoResults", "Demo results"],
] as const;
export type ProjectPage = {
  projects: PageProject[];
  issues: PageIssue[];
  error: string | null;
  status: number;
  wiki?: {
    installationId: string;
    hostname: string | null;
    slug: string;
    writable: boolean;
  } | null;
  cards: { project: PageProject; openIssues: number }[];
  /** On a project page: its body from the Wiki (goals, use cases, stories, release, evidence). */
  wikiBody?: ProjectWikiBody | null;
  /** On the projects list: each organization's goals and KPIs, by organization slug ("" for the member's own scope). */
  organizationGoals?: Record<string, OrganizationGoalsNode>;
  groups: {
    category: PageIssue["category"];
    title: string;
    issues: {
      issue: PageIssue;
      metadata: string;
      moveUp: boolean;
      moveDown: boolean;
    }[];
  }[];
};
export function projectPageView(
  projects: PageProject[],
  issues: PageIssue[],
  error: string | null = null,
  status = 200,
  counts: Pick<PageIssue, "projectId" | "status">[] = issues,
): ProjectPage {
  return {
    projects,
    issues,
    error,
    status,
    cards: projects.map((project) => ({
      project,
      openIssues:
        project.openIssues ??
        counts.filter(
          (issue) => issue.projectId === project.id && issue.status !== "done",
        ).length,
    })),
    groups: (["stone", "pebble", "sand"] as const).map((category) => {
      const categoryIssues = issues.filter(
        (issue) => issue.category === category,
      );
      return {
        category,
        title: { stone: "Stones", pebble: "Pebbles", sand: "Sand" }[category],
        issues: categoryIssues
          .filter((issue) => issue.status !== "done")
          .map((issue) => ({
            issue,
            metadata: [
              issue.status,
              issue.dueDate,
              issue.assigneeId ? "Assigned member" : null,
              issue.parentId
                ? `Sub-issue of ${issues.find((parent) => parent.id === issue.parentId)?.title ?? "issue"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
            moveUp: categoryIssues.indexOf(issue) > 0,
            moveDown: categoryIssues.indexOf(issue) < categoryIssues.length - 1,
          })),
      };
    }),
  };
}
const projectFields = [
  "name",
  "githubRepository",
  ...projectDocuments.map(([field]) => field),
];
const issueFields = [
  "projectId",
  "title",
  "description",
  "category",
  "status",
  "assigneeId",
  "dueDate",
  "parentId",
  "position",
];

/** A Projects document row (graph/documents.json), with its organization provenance. */
export type ProjectNode = {
  id: string;
  revision: number;
  name: string;
  slug: string | null;
  githubRepository: string | null;
  goals: string;
  openIssues: number;
  archived: boolean;
  rank?: number | null;
  state?: Project["state"];
  organizationSlug: string | null;
  useCases: ContextRecord[];
  customerSegments: ContextRecord[];
  userStories: ContextRecord[];
  goalRecords: ContextRecord[];
  readiness: {
    stage: string;
    priority: number;
    missing: string[];
    signals: string[];
  };
};
type ContextRecord = {
  id: string;
  title: string;
  summary: string;
  revision: number;
};
const LIST_PAGE = 50;
const LIST_PAGES = 10;

type Viewer = {
  organizations: { slug: string; appSlugs: string[] }[];
  personal: { accessible: boolean; appSlugs: string[] };
};
/** An OrganizationGoals document row (graph/documents.json), with its organization provenance. */
export type OrganizationGoalsNode = {
  id: string;
  revision: number;
  title: string;
  summary: string;
  truncated: boolean;
  organizationSlug: string | null;
  goals: {
    id: string;
    title: string;
    summary: string;
    revision: number;
    metrics: { id: string; title: string; summary: string }[];
  }[];
};

/** The scopes whose Planning the member can read, from the platform's Viewer: personal first, then organizations. */
async function planningScopes(host: WorkflowHost<"interactive">) {
  const answer = (await host.call("platform.document", {
    document: "Viewer",
  })) as { viewer: Viewer };
  const { organizations, personal } = answer.viewer;
  return [
    ...(personal.accessible && personal.appSlugs.includes("planning")
      ? ["personal"]
      : []),
    ...organizations
      .filter((organization) => organization.appSlugs.includes("planning"))
      .map((organization) => organization.slug),
  ];
}

/** One scope's OrganizationGoals (the same document the MCP runs); none for a personal scope or a Wiki without a bound page. */
async function scopeGoals(
  host: WorkflowHost<"interactive">,
  scopes: string[] | undefined,
) {
  const answer = (await host.call("platform.document", {
    app: "planning",
    document: "OrganizationGoals",
    ...(scopes ? { scopes } : {}),
    variables: { limit: 1 },
  })) as { data: { organizationGoals: OrganizationGoalsNode[] } | null };
  return answer.data?.organizationGoals[0] ?? null;
}

/**
 * Each organization's goals and KPIs for the projects page, keyed by organization slug:
 * on the member's own installation one OrganizationGoals read per organization scope,
 * at once; on an organization's installation its own. Scopes that cannot be read are
 * left out rather than failing the page.
 */
export async function readOrganizationGoalsByScope(
  host: WorkflowHost<"interactive">,
  identity: { organizationId?: string },
  scopes: string[],
) {
  const goals: Record<string, OrganizationGoalsNode> = {};
  const targets = identity.organizationId
    ? [undefined]
    : scopes.filter((scope) => scope !== "personal").map((scope) => [scope]);
  const answers = await Promise.all(
    targets.map((scope) => scopeGoals(host, scope).catch(() => null)),
  );
  for (const node of answers)
    if (node) goals[node.organizationSlug ?? ""] = node;
  return goals;
}

/** Every page of one scope's Projects (the same document the MCP runs), paged by the platform's cursor. */
async function scopeProjects(
  host: WorkflowHost<"interactive">,
  scopes: string[] | undefined,
) {
  const nodes: ProjectNode[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const answer = (await host.call("platform.document", {
      app: "planning",
      document: "Projects",
      ...(scopes ? { scopes } : {}),
      variables: {
        limit: LIST_PAGE,
        archived: false,
        ...(cursor ? { cursor } : {}),
      },
    })) as { data: { projects: ProjectNode[] } | null; next?: string };
    nodes.push(...(answer.data?.projects ?? []));
    cursor = answer.next;
    if (!cursor) return nodes;
  }
  throw new Response("Project view exceeds its supported size", {
    status: 413,
  });
}

/**
 * Active projects, read with Planning's published Projects document through the
 * member's own graph_query, the same read an MCP client makes. On the member's own
 * installation each scope (personal, then every organization with Planning) runs
 * the same query at once, so the page waits for the slowest scope rather than their
 * sum; an organization's installation is kept to that organization by the host.
 * The projects page and the sidebar agent both start here.
 */
export async function readProjects(
  host: WorkflowHost<"interactive">,
  identity: { organizationId?: string },
): Promise<ProjectNode[]> {
  if (identity.organizationId) return scopeProjects(host, undefined);
  const scopes = await planningScopes(host);
  const pages = await Promise.all(
    scopes.map((scope) => scopeProjects(host, [scope])),
  );
  return pages.flat();
}

/** The projects list and every organization's goals, read together. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the scoped Viewer connection must finish or explicitly refuse cursor loops and oversized results.
export async function readProjectsAndGoals(
  host: WorkflowHost<"interactive">,
  identity: { organizationId?: string },
) {
  // The workflow host pins Viewer to the organization resolved from the URL.
  // Keep the personal collection path while organization pages share Viewer's root.
  if (identity.organizationId) {
    const projects: ProjectNode[] = [];
    const goals: Record<string, OrganizationGoalsNode> = {};
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < LIST_PAGES; page++) {
      const answer = (await host.call("platform.document", {
        document: "Viewer",
        query: projectsViewerQuery,
        variables: { ...(after ? { after } : {}) },
      })) as {
        viewer: {
          orgs: {
            slug: string;
            projects: {
              nodes: ProjectNode[];
              pageInfo: { endCursor: string | null; hasNextPage: boolean };
            };
            organizationGoals: { nodes: OrganizationGoalsNode[] };
          }[];
        };
      };
      if (answer.viewer.orgs.length !== 1)
        throw new Response("Organization scope is missing or ambiguous", {
          status: 409,
        });
      const org = answer.viewer.orgs[0];
      projects.push(
        ...org.projects.nodes.map((row) => ({
          ...row,
          organizationSlug: org.slug,
        })),
      );
      if (org.organizationGoals.nodes[0])
        goals[org.slug] = {
          ...org.organizationGoals.nodes[0],
          organizationSlug: org.slug,
        };
      if (!org.projects.pageInfo.hasNextPage) return { projects, goals };
      after = org.projects.pageInfo.endCursor ?? undefined;
      if (!after || seen.has(after))
        throw new Response("Project pagination is incomplete", { status: 502 });
      seen.add(after);
    }
    throw new Response("Project view exceeds its supported size", {
      status: 413,
    });
  }

  const scopes = identity.organizationId ? [] : await planningScopes(host);
  const [projects, goals] = await Promise.all([
    identity.organizationId
      ? scopeProjects(host, undefined)
      : Promise.all(scopes.map((scope) => scopeProjects(host, [scope]))).then(
          (pages) => pages.flat(),
        ),
    readOrganizationGoalsByScope(host, identity, scopes),
  ]);
  return { projects, goals };
}

/**
 * Projects rows as the MCP's ProjectSummaries returns them: the same fields, rendered as
 * the same compact Markdown blocks (graph-markdown), one per project.
 */
export function projectSummaryBlocks(nodes: ProjectNode[]): string[] {
  const brief = ({ title, summary }: ContextRecord) => ({ title, summary });
  return nodes.map((node) =>
    renderMarkdownBlock(
      {
        name: node.name,
        slug: node.slug,
        githubRepository: node.githubRepository,
        openIssues: node.openIssues,
        useCases: node.useCases.map(brief),
        customerSegments: node.customerSegments.map(brief),
        userStories: node.userStories.map(brief),
        organizationSlug: node.organizationSlug,
      },
      "name",
      "slug",
    ),
  );
}

/** The projects page's cards from Projects rows. */
export function projectCards(
  nodes: ProjectNode[],
  identity: { organizationId?: string },
): PageProject[] {
  return nodes
    .map((node) => {
      // An organization's installation reads only its own organization; on the member's
      // own installation, an organization's project opens in that organization's Planning.
      const elsewhere = !identity.organizationId && node.organizationSlug;
      return {
        id: node.id,
        revision: node.revision,
        name: node.name,
        githubRepository: node.githubRepository ?? "",
        goals: node.goals ?? "",
        userStories: "",
        pressRelease: "",
        demoInstructions: "",
        demoResults: "",
        openIssues: node.openIssues,
        state: node.state,
        rank: node.rank,
        organizationSlug: node.organizationSlug,
        readiness: node.readiness,
        goalRecords: node.goalRecords.map(({ id, title }) => ({ id, title })),
        ...(elsewhere
          ? {
              href: `/o/${encodeURIComponent(node.organizationSlug as string)}/planning/projects/${encodeURIComponent(node.id)}`,
            }
          : {}),
      } as PageProject;
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.organizationSlug ?? "").localeCompare(b.organizationSlug ?? ""),
    );
}

/** The projects list: Projects rows as cards. */
export async function readProjectList(
  host: WorkflowHost<"interactive">,
  identity: { organizationId?: string },
) {
  return projectCards(await readProjects(host, identity), identity);
}

async function wikiLink(
  host: WorkflowHost<"interactive">,
): Promise<ProjectPage["wiki"]> {
  try {
    const wiki = await appDataContext(host).apps.database("wiki-map");
    return {
      installationId: wiki.installationId,
      hostname: wiki.hostname,
      slug: wiki.slug,
      writable: false,
    };
  } catch (error) {
    if (!(error instanceof Response) || ![404, 409].includes(error.status))
      throw error;
    return null;
  }
}

/** Each read uses the authenticated installation's published collections. */
export async function readProjectPage(
  host: WorkflowHost<"interactive">,
  installationId: string,
  projectId = "",
): Promise<ProjectPage> {
  const context = appDataContext(host);
  const db = await context.apps.installation(installationId);
  async function all(
    collection: "projects" | "issues",
    select: string[],
    where?: Record<string, unknown>,
  ) {
    const records: Awaited<
      ReturnType<ReturnType<typeof db.collection>["list"]>
    > = [];
    for (let offset = 0; offset <= 1000; offset += 100) {
      const page = await db.collection(collection).list({
        select,
        ...(where ? { where } : {}),
        order: {
          field: collection === "projects" ? "name" : "position",
          direction: "asc",
        },
        offset,
        limit: 100,
      });
      records.push(...page);
      if (page.length < 100) return records;
    }
    throw new Response("Project view exceeds its supported size", {
      status: 413,
    });
  }
  const projects = projectId
    ? [await db.collection("projects").get(projectId)]
    : await all("projects", projectFields);
  const issues = await all(
    "issues",
    projectId ? issueFields : ["projectId", "status"],
    projectId ? { projectId } : undefined,
  );
  const view = projectPageView(
    projects.map((record) => ({
      ...record.attributes,
      id: record.ref.id,
      revision: record.revision,
    })) as PageProject[],
    projectId
      ? (issues.map((record) => ({
          ...record.attributes,
          id: record.ref.id,
          revision: record.revision,
        })) as PageIssue[])
      : [],
    null,
    200,
    issues.map((record) => record.attributes) as Pick<
      PageIssue,
      "projectId" | "status"
    >[],
  );
  const [wiki, wikiBody] = await Promise.all([
    wikiLink(host),
    projectId ? readProjectWikiBody(host, installationId, projectId) : null,
  ]);
  view.wiki = wiki;
  view.wikiBody = wikiBody;
  return view;
}

export async function projectPage(
  request: Request,
  locals: App.Locals,
  projectId = "",
): Promise<ProjectPage> {
  const identity = requestIdentity(request);
  try {
    if (!projectId) {
      const host = workflowHost<"interactive">(locals);
      const { projects: nodes, goals } = await readProjectsAndGoals(
        host,
        identity,
      );
      const view = projectPageView(projectCards(nodes, identity), []);
      view.organizationGoals = goals;
      view.wiki = await wikiLink(host);
      return view;
    }
    return await readProjectPage(
      workflowHost<"interactive">(locals),
      identity.installationId,
      projectId,
    );
  } catch (error) {
    if (error instanceof Response && [401, 403].includes(error.status))
      throw error;
    if (error instanceof Response && error.status === 404 && projectId)
      return projectPageView(
        [],
        [],
        "Project not found. Return to All projects to choose another project.",
        404,
      );
    return projectPageView(
      [],
      [],
      "Project content is unavailable. Retry loading the page.",
      error instanceof Response && error.status === 413 ? 413 : 503,
    );
  }
}

export function demoProjectPage(): ProjectPage {
  const id = "00000000-0000-4000-8000-000000000001";
  return projectPageView(
    [
      {
        id,
        revision: 1,
        name: "Launch a useful planning workflow",
        githubRepository: "",
        goals: "Help the team choose valuable work and finish it.",
        userStories:
          "As a member, I can see the next issue and the decision blocking it.",
        pressRelease:
          "The team can plan together while keeping personal priorities private.",
        demoInstructions:
          "Create an issue, add a sub-issue and review the ranked board.",
        demoResults: "Synthetic example; no live provider or agent run.",
      },
    ],
    [
      {
        id: "00000000-0000-4000-8000-000000000002",
        projectId: id,
        revision: 1,
        title: "Prove the shared planning journey",
        description: "Choose the acceptance scenario before expanding scope.",
        category: "stone",
        status: "todo",
        assigneeId: null,
        dueDate: null,
        parentId: null,
        position: 0,
      },
    ],
  );
}
