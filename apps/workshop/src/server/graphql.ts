import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { mutationField, type TableContext, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import type { storage } from "@ai-outfitter/app-sdk/storage";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { z } from "zod";
import { type GraphQLFieldConfig, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, getNamedType } from "graphql";
import { publishConcepts, publishInput, removeConcept, removeInput } from "./concepts";
import {
  assemblyInput, createWorkshopProject, deleteInput, deleteWorkshopProject, describeInput, describeWorkshopProject, exampleInput, linkInput,
  getWorkshopProject, nameWorkshopProductRevision, projectFrom, saveWorkshopAssembly, type WorkshopDatabase, workshopProjectRow,
} from "./projects";
import { workshopProjects, workshopUnits } from "./schema";
import { createWorkshopUnit, deleteWorkshopUnit, UnitDelete, UnitInput, UnitUpdate, updateWorkshopUnit } from "./units";

/** The services every action and document runs with (src/server/context.ts builds them). */
export type WorkshopServices = {
  db: () => WorkshopDatabase;
  /** The installation's concept images. */
  storage: () => ReturnType<typeof storage>;
  /** The Wiki, reached as the member. */
  host: () => WorkflowHost<"interactive">;
  /** Where this Workshop serves its files, for the links a published Document carries. */
  origin: () => string;
};
/** What the actions route (and a page running a document in process) passes to every resolver. */
export type WorkshopContext = ActionContext & WorkshopServices;

const projects = tableType(workshopProjects, {
  field: "workshopProjects", type: "WorkshopProject",
  fields: ["name", "revision", "wikiInstallationId", "productRevisionId", "productRevisionTitle", "createdBy", "updatedBy", "createdAt", "updatedAt"],
  dates: ["createdAt", "updatedAt"],
  ids: ["wikiInstallationId", "productRevisionId", "createdBy", "updatedBy"],
  filters: ["createdBy", "productRevisionId"],
});
/** The inventory: one row per physical unit, told apart by MAC address or serial. */
const units = tableType(workshopUnits, {
  field: "workshopUnits", type: "WorkshopUnit",
  fields: ["partNumber", "mpn", "mac", "serial", "status", "location", "projectId", "firmware", "notes", "revision", "createdBy", "updatedBy", "createdAt", "updatedAt"],
  dates: ["createdAt", "updatedAt"],
  ids: ["createdBy", "updatedBy", "projectId"],
  filters: ["partNumber", "mac", "status", "projectId"],
});
/** The row type a tableType collection pages (`<Type>Connection.nodes`), so a mutation returns the same record a read does. */
const rowType = (collection: GraphQLFieldConfig<unknown, TableContext>) =>
  getNamedType((getNamedType(collection.type) as GraphQLObjectType).getFields().nodes.type) as GraphQLObjectType;
const row = new GraphQLNonNull(rowType(projects.workshopProjects));
const unitRow = new GraphQLNonNull(rowType(units.workshopUnits));

// Workshop's writes that fit a document: every member starts, describes, links and deletes
// projects, saves the product structure, removes and publishes design concepts and keeps the
// inventory, as on the page. Saving a whole project document (up to 1.5 MB) and uploading a
// concept image stay the routes' own.
const mutation = new GraphQLObjectType<unknown, WorkshopContext>({
  name: "Mutation",
  fields: {
    createWorkshopProject: mutationField<typeof exampleInput, WorkshopContext>({
      name: "CreateWorkshopProject",
      description: "Start a project from a starter example (cube, holder, button, node or sensor) as the Workshop page's New project does, within the installation's cap of 100 projects, named and linked to the Wiki ProductRevision it builds when given. Answers the project as the list shows it; a member refines it on the page.",
      input: exampleInput, output: row,
      run: async (context, input) => workshopProjectRow(context.db(), (await createWorkshopProject(context.db(), context.identity, projectFrom(input))).id),
    }),
    nameWorkshopProductRevision: mutationField<typeof linkInput, WorkshopContext>({
      name: "NameWorkshopProductRevision",
      description: "Link a project to the Wiki ProductRevision it builds (its record id, Wiki installation, title and link), or unlink it with null, at the revision the caller saw; a stale revision is refused. Answers the project at its next revision.",
      input: linkInput, output: row,
      run: async (context, input) => workshopProjectRow(context.db(), (await nameWorkshopProductRevision(context.db(), context.identity, input)).id),
    }),
    describeWorkshopProject: mutationField<typeof describeInput, WorkshopContext>({
      name: "DescribeWorkshopProject",
      description: "Set a project's name, stage (concept, prototyping, validation, pilot, manufacturing), brief or requirements at the revision the caller saw; a field left out keeps its value and a stale revision is refused. Answers the project at its next revision.",
      input: describeInput, output: row,
      run: async (context, input) => workshopProjectRow(context.db(), (await describeWorkshopProject(context.db(), context.identity, input)).id),
    }),
    saveWorkshopAssembly: mutationField<typeof assemblyInput, WorkshopContext>({
      name: "SaveWorkshopAssembly",
      description: "Replace a project's product structure at the revision the caller saw: its items (assemblies, printed parts, COTS parts, PCBs and firmware, each with a part number and revision letter) and the usage lines from each assembly to the items it contains, with quantities, reference designators and placements; the BOM, costs and 3D view derive from it. Item geometry is a CAD plan (JSON) and a placement is [x, y, z] in mm. A stale revision is refused. Answers the project at its next revision.",
      input: assemblyInput, output: row,
      run: async (context, input) => workshopProjectRow(context.db(), (await saveWorkshopAssembly(context.db(), context.identity, input)).id),
    }),
    deleteWorkshopProject: mutationField<typeof deleteInput, WorkshopContext>({
      name: "DeleteWorkshopProject",
      description: "Delete a project at the revision the caller saw; a stale revision is refused. Answers the deleted id.",
      input: deleteInput, output: new GraphQLNonNull(GraphQLID),
      run: (context, input) => deleteWorkshopProject(context.db(), input),
    }),
    removeWorkshopConcept: mutationField<typeof removeInput, WorkshopContext>({
      name: "RemoveWorkshopConcept",
      description: "Remove a design concept mockup and its image from a project at the revision the caller saw; a stale revision is refused. Answers the project as the list shows it, at its next revision.",
      input: removeInput, output: row,
      run: async (context, input) => workshopProjectRow(context.db(), (await removeConcept(context, input)).id),
    }),
    publishWorkshopConcepts: mutationField<typeof publishInput, WorkshopContext>({
      name: "PublishWorkshopConcepts",
      description: "Publish a project's design concepts to the owner's Wiki as one Document that is evidence_for the named ProductRevision, written as the caller; the same project revision publishes the same Document again. Answers { documentId, url }.",
      input: publishInput,
      run: (context, input) => publishConcepts(context, input),
    }),
    recordWorkshopUnit: mutationField<typeof UnitInput, WorkshopContext>({
      name: "RecordWorkshopUnit",
      description: "Add one physical unit to the inventory by part number with its MAC address (any common spelling) or serial number, its status (in-stock, allocated, installed, retired), location, project and firmware, within the cap of 1000 units; a MAC already recorded is refused. Answers the unit.",
      input: UnitInput, output: unitRow,
      run: (context, input) => createWorkshopUnit(context.db(), context.identity, input),
    }),
    updateWorkshopUnit: mutationField<typeof UnitUpdate, WorkshopContext>({
      name: "UpdateWorkshopUnit",
      description: "Replace a unit's fields (after flashing, installing or moving it) at the revision the caller saw; a stale revision is refused. Answers the unit at its next revision.",
      input: UnitUpdate, output: unitRow,
      run: (context, input) => updateWorkshopUnit(context.db(), context.identity, input),
    }),
    deleteWorkshopUnit: mutationField<typeof UnitDelete, WorkshopContext>({
      name: "DeleteWorkshopUnit",
      description: "Remove a unit from the inventory at the revision the caller saw; a stale revision is refused. Answers the deleted id.",
      input: UnitDelete, output: new GraphQLNonNull(GraphQLID),
      run: async (context, input) => (await deleteWorkshopUnit(context.db(), input)).id,
    }),
  },
});

/** What this app serves over graph.graphql and graph.mutate (printed to graph/schema.graphql
 * by scripts/graph-schema.ts): its projects as the project list shows them, with the Wiki
 * ProductRevision each builds (filter by `productRevisionId`), its inventory of physical
 * units, and the writes its documents (documents.ts) run. The project document in `data`
 * (models, CAD plans, evidence) is not served. */
/** One project's persisted handoff: what a caller wrote with the documents above, read back whole. */
const handoffInput = z.strictObject({ id: z.uuid() });
const handoff = mutationField<typeof handoffInput, WorkshopContext>({
  name: "WorkshopProjectHandoff",
  description: "Read one project as persisted: name, revision, stage, brief, requirements, the product revision it builds and its whole assembly (items and usage lines). A proposed assembly is not evidence of purchased parts, CAD, fabrication or fit. Changes nothing.",
  input: handoffInput, output: new GraphQLNonNull(JSONScalar),
  run: async (context, { id }) => {
    const row = await workshopProjectRow(context.db(), id);
    const project = await getWorkshopProject(context.db(), id);
    return { id, name: row.name, revision: row.revision, phase: project.phase, brief: project.brief, requirements: project.requirements,
      productRevision: row.productRevisionId ? { id: row.productRevisionId, title: row.productRevisionTitle, wikiInstallationId: row.wikiInstallationId } : null,
      assembly: project.assembly, updatedAt: row.updatedAt };
  },
});
const baseGraphqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields: { ...projects, ...units, workshopProjectHandoff: handoff } }),
  mutation,
});

export const graphqlSchema = batchSchema(baseGraphqlSchema, batchGroups);
