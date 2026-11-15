// Workshop's projects as agents and pages read them: one typed record per project with its
// stage, brief and requirements, and (opened by slug) its whole model: the product structure,
// the indented BOM with cost, the workspace builds with their tests and artifacts, bench
// evidence, research and concepts. The list reads only columns and a few JSON paths; the
// project document is loaded once per project and request, and only when a model field is
// selected. Image bytes, CAD source and build files stay behind the app's routes.
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  GraphQLBoolean, type GraphQLFieldConfig, type GraphQLFieldConfigMap, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType,
  type GraphQLOutputType, GraphQLString,
} from "graphql";
import { connectionType, idList, page, pageArgs, type PageArgs, pageStart, type TableContext } from "@ai-outfitter/app-sdk/app-graphql";
import { DateTimeScalar, JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { planBounds } from "../model/cad-plan";
import { type Assembly, bomRows, bomTotals, type Item } from "../lib/assembly";
import { type Project, ProjectSchema } from "../lib/project";
import { projectSlug } from "../lib/sections";
import type { WorkshopDatabase } from "./projects";
import { workshopProjects } from "./schema";

type Context = TableContext;
const database = (context: Context) => context.db() as WorkshopDatabase;
/** A stored row: the list's columns, or the whole row (with `data`) a mutation answers. */
export type ProjectSource = {
  id: string; name: string; revision: number; wikiInstallationId: string | null; productRevisionId: string | null; productRevisionTitle: string | null;
  createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
  data?: string; phase?: string; kind?: string; brief?: string; requirements?: string;
};

const nn = <T extends GraphQLOutputType>(type: T) => new GraphQLNonNull(type);
const list = <T extends GraphQLOutputType>(type: T) => nn(new GraphQLList(nn(type)));
const str = { type: nn(GraphQLString) };
const optStr = { type: GraphQLString };
const num = { type: nn(GraphQLFloat) };
const vector = { type: list(GraphQLFloat) };

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
/** A field the list selects as a JSON path, read from the document when a mutation answers the whole row. */
const listed = (key: "phase" | "kind" | "brief" | "requirements", description: string): GraphQLFieldConfig<ProjectSource, Context> =>
  ({ type: nn(GraphQLString), description, resolve: async (source, _args, context) => source[key] ?? (await projectOf(source, context))[key] });

const ProductRevisionType = new GraphQLObjectType({
  name: "WorkshopProductRevision",
  description: "The Wiki ProductRevision a project builds.",
  fields: { id: { type: nn(GraphQLID) }, title: str, url: str, wikiInstallationId: optStr },
});
const FirmwareType = new GraphQLObjectType({
  name: "WorkshopFirmware",
  fields: { repository: str, path: str, ref: { ...str, description: "The tag, branch or commit a build flashes." }, target: { ...str, description: "The chip target, such as esp32s3." } },
});
const UsageType = new GraphQLObjectType<Assembly["items"][number]["uses"][number] & { part: string }>({
  name: "WorkshopUsage",
  description: "A usage line: how many of an item an assembly holds, where and under which reference designator.",
  fields: {
    part: { ...str, description: "The contained item's part number." },
    quantity: { type: nn(GraphQLInt) },
    refdes: str,
    position: { ...vector, description: "[x, y, z] in mm in the parent assembly." },
    rotation: { ...num, description: "Turn about the parent's Z axis, in degrees." },
    orientation: { type: new GraphQLList(nn(GraphQLFloat)), description: "[x, y, z] Euler angles in degrees, when set instead of rotation." },
  },
});
const ItemType = new GraphQLObjectType<Item & { byId: Map<string, Item> }>({
  name: "WorkshopItem",
  description: "One item of the product structure: an assembly, printed or fabricated part, COTS part, PCB or firmware.",
  fields: {
    number: { ...str, description: "The part number, unique in the project." },
    revision: { ...str, description: "The revision letter." },
    name: str,
    kind: { ...str, description: "assembly, printed, fabricated, cots, pcb or firmware." },
    manufacturer: str, mpn: str, source: str,
    unitCost: num,
    priceKnown: { type: nn(GraphQLBoolean) },
    provenance: { ...str, description: "provisional, manufacturer or measured: how far the dimensions and data can be trusted." },
    trackBy: { ...str, description: "none, mac or serial: how the inventory tells units apart." },
    color: optStr,
    notes: str,
    size: { type: new GraphQLList(nn(GraphQLFloat)), description: "[x, y, z] extent of the item's geometry or mesh in mm; none for items without a solid.",
      resolve: (item) => item.mesh ? item.mesh.bounds.max.map((max, axis) => max - item.mesh!.bounds.min[axis]) : item.geometry ? planBounds(item.geometry).size : null },
    geometry: { type: JSONScalar, description: "The CAD plan (features in the item's own coordinates, mm). For a COTS part it is an envelope, not the manufacturer's model." },
    mesh: { type: optStr.type, description: "The build artifact path of the item's mesh, when a workspace build supplied one.", resolve: (item) => item.mesh?.path ?? null },
    firmware: { type: FirmwareType },
    uses: { type: list(UsageType), resolve: (item) => item.uses.map((use) => ({ ...use, part: item.byId.get(use.itemId)?.number ?? "" })) },
  },
});
const AssemblyType = new GraphQLObjectType<Assembly>({
  name: "WorkshopAssembly",
  fields: {
    root: { type: GraphQLString, description: "The top assembly's part number.", resolve: (a) => a.items.find((item) => item.id === a.rootId)?.number ?? null },
    items: { type: list(ItemType), resolve: (a) => { const byId = new Map(a.items.map((item) => [item.id, item])); return a.items.map((item) => ({ ...item, byId })); } },
  },
});
const BomLine = new GraphQLObjectType<ReturnType<typeof bomRows>[number]>({
  name: "WorkshopBomLine",
  description: "One line of the indented BOM, from the top assembly down.",
  fields: {
    depth: { type: nn(GraphQLInt), description: "0 for the top assembly." },
    part: { ...str, resolve: (row) => row.item.number },
    revision: { ...str, resolve: (row) => row.item.revision },
    name: { ...str, resolve: (row) => row.item.name },
    kind: { ...str, resolve: (row) => row.item.kind },
    quantity: { type: nn(GraphQLInt), description: "Units per one top assembly." },
    refdes: str,
    unitCost: { ...num, resolve: (row) => row.item.unitCost },
    priceKnown: { type: nn(GraphQLBoolean), resolve: (row) => row.item.priceKnown },
  },
});
const BomType = new GraphQLObjectType<Assembly>({
  name: "WorkshopBom",
  fields: {
    lines: { type: list(BomLine), resolve: (a) => bomRows(a) },
    cost: { ...num, description: "Cost of one top assembly from unit costs, known or not.", resolve: (a) => bomTotals(a).cost },
    pricesKnown: { type: nn(GraphQLBoolean), description: "Whether every line below the top has a known price.", resolve: (a) => bomTotals(a).lines.every((line) => line.item.priceKnown) },
  },
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
    assembly: { type: AssemblyType, description: "The product structure the build produced, with meshes, when it succeeded.", resolve: (b) => b.result?.manifest?.assembly ?? null },
    bom: { type: BomType, description: "The BOM of the built assembly.", resolve: (b) => b.result?.manifest?.assembly ?? null },
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
    assembly: fromProject(nn(AssemblyType), (p) => p.assembly, "The saved product structure: items and the usage lines between them. A workspace build may produce its own (builds.assembly)."),
    bom: fromProject(nn(BomType), (p) => p.assembly, "The indented BOM and the cost of one top assembly, derived from the assembly."),
    builds: fromProject(list(BuildType), (p) => (p.workspace?.requests ?? []).map((request) => ({ ...request, current: request.id === p.workspace?.currentBuildId })).reverse(), "Workspace builds, newest first, with their tests and artifacts."),
    evidence: fromProject(list(EvidenceType), (p) => p.evidence, "Bench observations, oldest first."),
    research: fromProject(list(ResearchType), (p) => p.research),
    concepts: fromProject(list(ConceptType), (p) => p.concepts),
  },
});

const json = (path: string) => sql<string>`coalesce(json_extract(${workshopProjects.data}, ${path}), '')`;
const listColumns = {
  id: workshopProjects.id, name: workshopProjects.name, revision: workshopProjects.revision,
  wikiInstallationId: workshopProjects.wikiInstallationId, productRevisionId: workshopProjects.productRevisionId, productRevisionTitle: workshopProjects.productRevisionTitle,
  createdBy: workshopProjects.createdBy, updatedBy: workshopProjects.updatedBy, createdAt: workshopProjects.createdAt, updatedAt: workshopProjects.updatedAt,
  // Projects saved before stages existed have none: they are concepts.
  phase: sql<string>`coalesce(json_extract(${workshopProjects.data}, '$.phase'), 'concept')`,
  kind: json("$.kind"), brief: json("$.brief"), requirements: json("$.requirements"),
};
/** The 12 hex digits a slug ends with, or a value that matches no project. */
const slugKey = (slug: string) => /(?:^|-)([0-9a-f]{12})$/.exec(slug.trim().toLowerCase())?.[1] ?? "-";
const values = (value: unknown) => idList(value as string[] | null | undefined);

type Args = PageArgs & { ids?: string[]; slugs?: string[]; search?: string; phase?: string[]; createdBy?: string[]; productRevisionId?: string[] };
const projectsField: GraphQLFieldConfig<unknown, Context, Args> = {
  type: nn(connectionType(WorkshopProject)),
  description: "Workshop's projects in ID order. Filter by slugs (as the project page addresses them), ids, phase, the Wiki product revision they build or who created them; search matches the name and brief.",
  args: {
    ...pageArgs(),
    slugs: { type: new GraphQLList(nn(GraphQLString)) },
    search: { type: GraphQLString, description: "Match text in the name and brief." },
    phase: { type: new GraphQLList(nn(GraphQLString)) },
    createdBy: { type: new GraphQLList(nn(GraphQLID)) },
    productRevisionId: { type: new GraphQLList(nn(GraphQLID)) },
  },
  resolve: async (_source, args, context, info) => {
    const { first, start } = pageStart(args);
    const search = args.search?.trim() ?? "";
    if (search.length > 200) throw new Error("Search exceeds 200 characters");
    const ids = values(args.ids), slugs = values(args.slugs), phases = values(args.phase), creators = values(args.createdBy), revisions = values(args.productRevisionId);
    const where = and(
      ids ? inArray(workshopProjects.id, ids) : undefined,
      slugs ? or(...slugs.map((slug) => like(workshopProjects.id, `%${slugKey(slug)}`))) : undefined,
      phases ? inArray(listColumns.phase, phases) : undefined,
      creators ? inArray(workshopProjects.createdBy, creators) : undefined,
      revisions ? inArray(workshopProjects.productRevisionId, revisions) : undefined,
      search ? or(like(workshopProjects.name, `%${search}%`), like(listColumns.brief, `%${search}%`)) : undefined,
    );
    const db = database(context);
    const rows: ProjectSource[] = await db.select(listColumns).from(workshopProjects)
      .where(and(where, start === null ? undefined : sql`${workshopProjects.id} > ${start}`)).orderBy(workshopProjects.id).limit(first + 1);
    return {
      ...page(context, info, rows, (row) => row.id, first, start),
      aggregate: { count: async () => (await db.select({ count: sql<number>`count(*)` }).from(workshopProjects).where(where))[0].count },
    };
  },
};

/** The `workshopProjects` root field, as a field map like tableType answers. */
export const projects: GraphQLFieldConfigMap<unknown, Context> = { workshopProjects: projectsField as GraphQLFieldConfig<unknown, Context> };
