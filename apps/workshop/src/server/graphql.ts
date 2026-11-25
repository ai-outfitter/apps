import { PrintPlateInput } from "../lib/print-plates";
import { recordWorkshopPrintPlate } from "./print-plates";
import { assemblyPrintFindings, readWorkshopPrint } from "./print-analysis";
import {sourceFileInput,readSourceFile} from "./source-file";
import { pageCursor, resolvedPage } from "../lib/resolved-page";
import {uploadInput, verifyInput, uploadAssemblyFile, verifyAssemblyFile} from "./assembly-files";
import { PcbSubmission, submitWorkshopPcb } from "./pcb-snapshots";
import {creativeHandoffInput,resultInput,acceptCreativeHandoff,attachCreativeResult} from './creative';
import { requestBuildInput, claimBuildInput, finishBuildInput, requestBuild, claimBuild, finishBuild } from "./workspace";
import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { resolvedProject } from "./assembly-references";
import { AssemblySchema, AssemblyReferenceSchema } from "../lib/assembly";
import { mutationField, zodInputType, type TableContext, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import type { storage } from "@ai-outfitter/app-sdk/storage";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { z } from "zod";
import { type GraphQLFieldConfig, GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, getNamedType } from "graphql";
import { designRun, designRunInput, startDesign, startDesignInput } from "./design-start";
import { publishConcepts, publishInput, removeConcept, removeInput } from "./concepts";
import {
  assemblyInput, assemblyUpdateBody, createWorkshopProject, deleteInput, deleteWorkshopProject, describeInput, describeWorkshopProject, exampleInput, linkInput,
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

const printFindings = {type:JSONScalar,description:"Machine-readable print findings on an assembly mutation receipt, with checked part, digest, profile, state and layer location."};
const projects = tableType(workshopProjects, {
  field: "workshopProjects", type: "WorkshopProject",
  fields: ["name", "purpose", "revision", "wikiInstallationId", "productRevisionId", "productRevisionTitle", "createdBy", "updatedBy", "createdAt", "updatedAt"],
  dates: ["createdAt", "updatedAt"],
  ids: ["wikiInstallationId", "productRevisionId", "createdBy", "updatedBy"],
  filters: ["createdBy", "productRevisionId", "purpose"],
  extraFields:{printFindings},
  // workshop_projects_updated_idx.
  orders: ["updatedAt"],
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

const projectId = { type: new GraphQLNonNull(GraphQLID) };
const revision = { type: new GraphQLNonNull(GraphQLInt) };
const assemblyReceipt = new GraphQLObjectType({
  name: "WorkshopAssemblyReceipt", fields: { projectId, revision, printFindings },
});
const assemblyResult = new GraphQLObjectType({
  name: "WorkshopAssemblyResult",
  fields: { projectId, revision, assembly: { type: new GraphQLNonNull(JSONScalar), extensions: { completeResult: true } } },
});
const projectKey = z.object({ projectId: z.uuid() });
const assemblyUpdate = assemblyUpdateBody.extend(projectKey.shape);
const workshopAssembly = mutationField<typeof projectKey, WorkshopContext>({
  name: "WorkshopAssembly", description: "Read the whole saved assembly at one project revision.",
  input: projectKey, args: { projectId }, output: new GraphQLNonNull(assemblyResult),
  run: async (context, { projectId }) => {
    const { revision, assembly } = await getWorkshopProject(context.db(), projectId);
    return { projectId, revision, assembly };
  },
});

const resolvedAssembly = mutationField<typeof AssemblyReferenceSchema, WorkshopContext>({
  name: "ResolvedWorkshopAssembly", description: "Expand source revisions and configurations for a read-only CAD, BOM and power view.",
  input: AssemblyReferenceSchema, output: new GraphQLNonNull(JSONScalar),
  run: (context,input) => resolvedProject(context.db(),input),
});
resolvedAssembly.extensions = { completeResult: true };

const workshopPrintInput = AssemblyReferenceSchema.extend({itemId:z.uuid().optional()});
const workshopPrint = mutationField<typeof workshopPrintInput, WorkshopContext>({
  name:"WorkshopPrint",description:"Read print preflight and grouped slice evidence for the selected assembly.",
  input:workshopPrintInput,
  run:async(context,{itemId,...input})=>readWorkshopPrint(context,input.projectId,await resolvedProject(context.db(),input),itemId),
});
const resolvedPageInput = AssemblyReferenceSchema.extend({cursor:z.string().regex(pageCursor).optional()});
const resolvedAssemblyPage = mutationField<typeof resolvedPageInput, WorkshopContext>({
  name:"ResolvedWorkshopAssemblyPage",
  description:"Read a complete resolved assembly across byte-bounded, snapshot-checked pages.",
  input:resolvedPageInput,
  output:new GraphQLNonNull(new GraphQLObjectType({name:"ResolvedWorkshopAssemblyPageResult",fields:{
    projectId, revision, sha256:{type:new GraphQLNonNull(GraphQLString)}, offset:{type:new GraphQLNonNull(GraphQLInt)},
    totalBytes:{type:new GraphQLNonNull(GraphQLInt)}, jsonText:{type:new GraphQLNonNull(GraphQLString)},
    nextCursor:{type:GraphQLString},
  }})),
  run:async(context,{cursor,...ref})=>resolvedPage(await resolvedProject(context.db(),ref),cursor),
});

// Workshop's writes that fit a document: every member starts, describes, links and deletes
// projects, saves the product structure, removes and publishes design concepts and keeps the
// inventory, as on the page; starting design work (startWorkshopDesign) is the design form's
// turn as a durable task. Saving a whole project document (up to 1.5 MB) and uploading a
// concept image stay the routes' own.
const mutation = new GraphQLObjectType<unknown, WorkshopContext>({
  name: "Mutation",
  fields: {
    recordWorkshopPrintPlate:mutationField<typeof PrintPlateInput,WorkshopContext>({name:"RecordWorkshopPrintPlate",description:"Preserve a native Bambu Studio sliced package and its physical plates for the current print inputs.",input:PrintPlateInput,run:recordWorkshopPrintPlate}),
    uploadWorkshopAssemblyFile: mutationField<typeof uploadInput,WorkshopContext>({name:"UploadWorkshopAssemblyFile",description:"Reserve or attach a verified CAD or animation file on one saved item.",input:uploadInput,run:uploadAssemblyFile}),
    submitWorkshopPcb: mutationField<typeof PcbSubmission, WorkshopContext>({
      name: "SubmitWorkshopPcb", description: "Upload a KiCad package and attach its verified snapshot.", input: PcbSubmission, run: submitWorkshopPcb,
    }),
    acceptCreativeHandoff:mutationField<typeof creativeHandoffInput,WorkshopContext>({name:'AcceptCreativeHandoff',description:'Attach a selected mockup and acceptance criteria as a design request. Does not build CAD.',input:creativeHandoffInput,run:acceptCreativeHandoff}),
    attachCreativeResult:mutationField<typeof resultInput,WorkshopContext>({name:'AttachCreativeResult',description:'Link a reviewed result candidate back to its design request; no manufacturing approval is implied.',input:resultInput,run:attachCreativeResult}),
    requestWorkshopBuild: mutationField<typeof requestBuildInput, WorkshopContext>({name:"RequestWorkshopBuild",description:"Request a project workspace build and preserve revision provenance.",input:requestBuildInput,run:requestBuild}),
    claimWorkshopBuild: mutationField<typeof claimBuildInput, WorkshopContext>({name:"ClaimWorkshopBuild",description:"Claim a project workspace build and preserve revision provenance.",input:claimBuildInput,run:claimBuild}),
    finishWorkshopBuild: mutationField<typeof finishBuildInput, WorkshopContext>({name:"FinishWorkshopBuild",description:"Finish a project workspace build and preserve revision provenance.",input:finishBuildInput,run:(context,input)=>finishBuild(context,input,true)}),
    startWorkshopDesign: mutationField<typeof startDesignInput, WorkshopContext>({
      name: "StartWorkshopDesign",
      description: "Start Workshop's design agent on a part or project request without waiting for the model: a new project from `message`, or a follow-up to `projectId` at the `revision` the caller saw (a stale revision is refused before anything starts). The work runs as a workshop-design task run; an organization owner or admin may start it. Answers the run { id, status, design, created }: read WorkshopDesignRun with that id until status is complete (design names the saved projectId and revision) or failed. Pass `id` to make a retry start nothing twice.",
      input: startDesignInput,
      run: (context, input) => startDesign(context, input),
    }),
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
      description: "Set a project's purpose (product to manufacture or component library model), name, stage (concept, prototyping, validation, pilot, manufacturing), brief or requirements at the revision the caller saw; a field left out keeps its value and a stale revision is refused. Answers the project at its next revision.",
      input: describeInput, output: row,
      run: async (context, input) => workshopProjectRow(context.db(), (await describeWorkshopProject(context.db(), context.identity, input)).id),
    }),
    updateWorkshopAssembly: mutationField<typeof assemblyUpdate, WorkshopContext>({
      name: "UpdateWorkshopAssembly", description: "Replace the complete assembly at the observed project revision.",
      input: assemblyUpdate, output: new GraphQLNonNull(assemblyReceipt),
      args: { projectId, expectedRevision: revision, assembly: { type: new GraphQLNonNull(zodInputType(AssemblySchema, "WorkshopAssemblyInput")) } },
      run: async (context, { projectId, expectedRevision, assembly }) => {
        const saved = await saveWorkshopAssembly(context.db(), context.identity, { id: projectId, revision: expectedRevision, assembly });
        return {projectId,revision:saved.revision,printFindings:await assemblyPrintFindings(context,saved)};
      },
    }),
    saveWorkshopAssembly: mutationField<typeof assemblyInput, WorkshopContext>({
      name: "SaveWorkshopAssembly",
      description: "Replace a project's product structure at the revision the caller saw: its items (assemblies, printed parts, COTS parts, PCBs and firmware, each with a part number and revision letter) and the usage lines from each assembly to the items it contains, with quantities, reference designators and placements; the BOM, costs and 3D view derive from it. Item geometry is a CAD plan (JSON) and a placement is [x, y, z] in mm. A stale revision is refused. Answers the project at its next revision.",
      input: assemblyInput, output: row,
      run: async (context, input) => {
        const saved = await saveWorkshopAssembly(context.db(), context.identity, input);
        return {...await workshopProjectRow(context.db(),saved.id),printFindings:await assemblyPrintFindings(context,saved)};
      },
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
      assembly: project.assembly, workspace: project.workspace ?? null, updatedAt: row.updatedAt };
  },
});
/** One design run a caller started (StartWorkshopDesign or the platform's StartTasks), read from the workflow host. */
const designRunField = mutationField<typeof designRunInput, WorkshopContext>({
  name: "WorkshopDesignRun",
  description: "Read one design run by the id StartWorkshopDesign answered: status (running, complete or failed) and, once complete, design { projectId, revision, name, features, size [x, y, z] mm, prompt }. A failed run saved nothing; the platform's TaskRuns holds its reason. Changes nothing.",
  input: designRunInput, output: new GraphQLNonNull(JSONScalar),
  run: (context, input) => designRun(context, input),
});
const baseGraphqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields: { ...projects, ...units, workshopPrint, workshopSourceFile:mutationField<typeof sourceFileInput,WorkshopContext>({name:"WorkshopSourceFile",description:"Read a file at a ref from a connected Forgejo repository.",input:sourceFileInput,run:readSourceFile}), verifyWorkshopAssemblyFile:mutationField<typeof verifyInput,WorkshopContext>({name:"VerifyWorkshopAssemblyFile",description:"Hash the attached file bytes and compare with the saved receipt.",input:verifyInput,run:verifyAssemblyFile}), workshopAssembly, resolvedWorkshopAssembly: resolvedAssembly, resolvedWorkshopAssemblyPage: resolvedAssemblyPage, workshopProjectHandoff: handoff, workshopDesignRun: designRunField } }),
  mutation,
});

export const graphqlSchema = batchSchema(baseGraphqlSchema, batchGroups);
