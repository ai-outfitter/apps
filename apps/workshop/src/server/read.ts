// Workshop's projects as agents and pages read them: one typed record per project with its
// slug, stage, brief and requirements, and (opened by slug) its workspace builds with their
// tests and artifacts, bench evidence, research and concepts. The model itself (CAD, BOM,
// power, build price) is ResolvedWorkshopAssembly's. The list reads columns and a few JSON
// paths; the project document is loaded once per project and request, only when a field
// needs it. Image bytes, CAD source and build files stay behind the app's routes.
import { eq, like, or, sql } from "drizzle-orm";
import {
  GraphQLBoolean, type GraphQLFieldConfig, type GraphQLFieldConfigMap, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType,
  type GraphQLOutputType, GraphQLString,
} from "graphql";
import { connectionType, idList, type TableContext, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import { DateTimeScalar, JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { type Project, ProjectSchema } from "../lib/project";
import { projectSlug } from "../lib/sections";
import type { WorkshopDatabase } from "./projects";
import { workshopProjects } from "./schema";

type Context = TableContext;
const database = (context: Context) => context.db() as WorkshopDatabase;
/** A stored row: the list's columns, or the whole row (with `data`) a mutation answers. */
export type ProjectSource = {
  id: string; name: string; purpose: string; revision: number; wikiInstallationId: string | null; productRevisionId: string | null; productRevisionTitle: string | null;
  createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
  data?: string; printFindings?: unknown;
};

const nn = <T extends GraphQLOutputType>(type: T) => new GraphQLNonNull(type);
const list = <T extends GraphQLOutputType>(type: T) => nn(new GraphQLList(nn(type)));
const str = { type: nn(GraphQLString) };
const optStr = { type: GraphQLString };
const num = { type: nn(GraphQLFloat) };

// One project document per project and request, however many fields read it.
const loaded = new WeakMap<object, Map<string, Promise<Project>>>();
async function projectOf(source: ProjectSource, context: Context): Promise<Project> {
  const cache = loaded.get(context) ?? new Map<string, Promise<Project>>();
  loaded.set(context, cache);
  let project = cache.get(source.id);
  if (!project) {
    project = (source.data !== undefined
      ? Promise.resolve(source.data)
      : database(context).select({ data: workshopProjects.data }).from(workshopProjects).where(eq(workshopProjects.id, source.id)).then(([row]) => row?.data ?? "{}")
    ).then((data) => ProjectSchema.parse(JSON.parse(data)));
    cache.set(source.id, project);
  }
  return project;
}
/** A field read from the project document. */
const fromProject = <T>(type: GraphQLOutputType, read: (project: Project) => T, description?: string): GraphQLFieldConfig<ProjectSource, Context> =>
  ({ type, description, resolve: async (source, _args, context) => read(await projectOf(source, context)) });
// The list's words (stage, kind, brief, requirements) per project and request, read as JSON paths, not the whole document.
const summaries = new WeakMap<object, Map<string, Promise<Record<Summary, string>>>>();
type Summary = "phase" | "kind" | "brief" | "requirements";
const path = (key: Summary) => sql<string>`coalesce(json_extract(${workshopProjects.data}, ${`$.${key}`}), ${key === "phase" ? "concept" : ""})`;
function summaryOf(source: ProjectSource, context: Context) {
  if (source.data !== undefined) return projectOf(source, context);
  const cache = summaries.get(context) ?? new Map<string, Promise<Record<Summary, string>>>();
  summaries.set(context, cache);
  let summary = cache.get(source.id);
  if (!summary) {
    // Projects saved before stages existed have none: they are concepts.
    summary = database(context).select({ phase: path("phase"), kind: path("kind"), brief: path("brief"), requirements: path("requirements") })
      .from(workshopProjects).where(eq(workshopProjects.id, source.id)).then(([row]) => row ?? { phase: "concept", kind: "", brief: "", requirements: "" });
    cache.set(source.id, summary);
  }
  return summary;
}
const listed = (key: Summary, description: string): GraphQLFieldConfig<ProjectSource, Context> =>
  ({ type: nn(GraphQLString), description, resolve: async (source, _args, context) => (await summaryOf(source, context))[key] });

const ProductRevisionType = new GraphQLObjectType({
  name: "WorkshopProductRevision",
  description: "The Wiki ProductRevision a project builds.",
  fields: { id: { type: nn(GraphQLID) }, title: str, url: str, wikiInstallationId: optStr },
});
type Request = NonNullable<Project["workspace"]>["requests"][number] & { current: boolean };
const BuildTest = new GraphQLObjectType({ name: "WorkshopBuildTest", fields: { name: str, status: { ...str, description: "pass, fail or unverified." }, detail: str } });
const BuildArtifact = new GraphQLObjectType({ name: "WorkshopBuildArtifact", fields: { path: str, bytes: { type: nn(GraphQLInt) }, contentType: str, sha256: str } });
const BuildType = new GraphQLObjectType<Request>({
  name: "WorkshopBuild",
  description: "One workspace build: the pinned source it compiled and what it proved.",
  fields: {
    id: { type: nn(GraphQLID) },
    status: { ...str, description: "queued, running, succeeded or failed." },
    current: { type: nn(GraphQLBoolean), description: "Whether this build is the project's current one." },
    stale: { type: nn(GraphQLBoolean), description: "Whether the project changed after the build, so its results no longer describe the model.", resolve: (b) => b.result?.stale ?? false },
    repository: str, sourceDir: str, sourceCommit: str, runner: str, instructions: str,
    parameters: { type: nn(JSONScalar) },
    createdAt: { type: nn(DateTimeScalar) },
    finishedAt: { type: DateTimeScalar, resolve: (b) => b.result?.manifest?.finishedAt ?? null },
    compiler: { type: GraphQLString, resolve: (b) => b.result?.manifest?.compiler ?? null },
    error: { type: GraphQLString, resolve: (b) => b.result?.error ?? null },
    tests: { type: list(BuildTest), resolve: (b) => b.result?.manifest?.tests ?? [] },
    artifacts: { type: list(BuildArtifact), resolve: (b) => b.result?.manifest?.artifacts ?? [] },
  },
});
const EvidenceType = new GraphQLObjectType({
  name: "WorkshopEvidence",
  description: "A bench observation: a measurement, fit test, breadboard or PCB bring-up and its outcome.",
  fields: { stage: str, outcome: { ...str, description: "Pass, Fail or Observation." }, note: str, operator: str, at: { type: nn(DateTimeScalar) }, serialLog: str },
});
const ResearchType = new GraphQLObjectType({
  name: "WorkshopResearch",
  fields: { name: str, kind: { ...str, description: "COTS, Open design or Prior art." }, url: str, notes: str, decision: { ...str, description: "Investigate, Use, Adapt or Reject." } },
});
const ConceptType = new GraphQLObjectType({
  name: "WorkshopConcept",
  description: "A concept mockup: what the product is meant to look like. The image is served by the project page.",
  fields: { caption: str, prompt: str, model: str, createdAt: { type: nn(DateTimeScalar) } },
});

export const WorkshopProject = new GraphQLObjectType<ProjectSource, Context>({
  name: "WorkshopProject",
  description: "A Workshop project: a device or part on its way from concept to manufacture.",
  fields: {
    id: { type: nn(GraphQLID) },
    slug: { ...str, description: "The address the project page and documents use; it ends with the last 12 hex digits of the id, so a rename keeps it working.", resolve: (p) => projectSlug(p) },
    name: str,
    purpose: { ...str, description: "product, or component: a reusable library model other assemblies reference." },
    revision: num,
    phase: listed("phase", "concept, prototyping, validation, pilot or manufacturing."),
    kind: listed("kind", "mechanical or electronics."),
    brief: listed("brief", "What the project builds and for whom."),
    requirements: listed("requirements", "What the design must meet."),
    productRevision: { type: ProductRevisionType, resolve: async (p, _args, context) => p.productRevisionId ? (await projectOf(p, context)).productRevision ?? null : null },
    wikiInstallationId: { type: GraphQLID }, productRevisionId: { type: GraphQLID }, productRevisionTitle: optStr,
    createdBy: { type: nn(GraphQLID) }, updatedBy: { type: nn(GraphQLID) },
    createdAt: { type: nn(DateTimeScalar) }, updatedAt: { type: nn(DateTimeScalar) },
    measurementNotes: fromProject(nn(GraphQLString), (p) => p.measurementNotes, "What was measured and what is still assumed."),
    circuitNotes: fromProject(nn(GraphQLString), (p) => p.circuitNotes),
    builds: fromProject(list(BuildType), (p) => (p.workspace?.requests ?? []).map((request) => ({ ...request, current: request.id === p.workspace?.currentBuildId })).reverse(), "Workspace builds, newest first, with their tests and artifacts."),
    evidence: fromProject(list(EvidenceType), (p) => p.evidence, "Bench observations, oldest first."),
    research: fromProject(list(ResearchType), (p) => p.research),
    concepts: fromProject(list(ConceptType), (p) => p.concepts),
    printFindings: { type: JSONScalar, description: "Machine-readable print findings on an assembly mutation receipt, with checked part, digest, profile, state and layer location." },
  },
});

/** The collection itself is the table's (paging, ids, orderBy, filter, search); its rows resolve as WorkshopProject,
 * and `slugs` narrows it to the projects those slugs address. */
const table = tableType(workshopProjects, {
  field: "workshopProjects", type: "WorkshopProject",
  fields: ["name", "purpose", "revision", "wikiInstallationId", "productRevisionId", "productRevisionTitle", "createdBy", "updatedBy", "createdAt", "updatedAt"],
  dates: ["createdAt", "updatedAt"],
  ids: ["wikiInstallationId", "productRevisionId", "createdBy", "updatedBy"],
  filters: ["createdBy", "productRevisionId", "purpose"],
  // workshop_projects_updated_idx.
  orders: ["updatedAt"],
}).workshopProjects;
/** The 12 hex digits a slug (or a whole id) ends with, or a value that matches no project. */
const slugKey = (slug: string) => /(?:^|-)([0-9a-f]{12})$/.exec(slug.trim().toLowerCase())?.[1] ?? "-";

/** The `workshopProjects` root field, as a field map like tableType answers. */
export const projects: GraphQLFieldConfigMap<unknown, Context> = {
  workshopProjects: {
    ...table,
    type: nn(connectionType(WorkshopProject)),
    args: { ...table.args, slugs: { type: new GraphQLList(nn(GraphQLString)), description: "Projects by slug, as the project page addresses them; a renamed project keeps its old slug." } },
    resolve: async (source, { slugs, ...args }, context, info) => {
      const list = idList(slugs as string[] | null | undefined);
      if (list) {
        const found = (await database(context).select({ id: workshopProjects.id }).from(workshopProjects)
          .where(or(...list.map((slug) => like(workshopProjects.id, `%${slugKey(slug)}`))))).map((row) => row.id);
        const ids = idList(args.ids as string[] | null | undefined);
        args.ids = ids ? found.filter((id) => ids.includes(id)) : found;
        if (!(args.ids as string[]).length) args.ids = ["-"];
      }
      return table.resolve!(source, args, context, info);
    },
  },
};
