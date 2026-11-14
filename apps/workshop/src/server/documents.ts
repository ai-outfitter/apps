import { withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
// Workshop's documents: the mutations its page and agents run over graphqlSchema, each
// with the user story that keeps it (reads need no document: the composed graph answers
// them). scripts/graph-schema.ts writes them to graph/documents.json, which the platform
// lists (graph_documents) and runs by name (graph_mutate); the page's routes run the same
// documents with runDocument.
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { documentRunner } from "@ai-outfitter/app-sdk/app-graphql";
import { graphql } from "../../graph/graphql";
import { graphqlSchema, type WorkshopContext } from "./graphql";

const legacyDocuments = defineDocuments({
  RequestWorkshopBuild: {story:"As a member, I want to request a workspace build from pinned source and parameters, so that agents can build a reproducible revision.",document:graphql(`mutation RequestWorkshopBuild($input: RequestWorkshopBuildInput!) { requestWorkshopBuild(input:$input) }`)},
  ClaimWorkshopBuild: {story:"As a workspace runner, I want to claim a queued build at its observed revision, so that concurrent runners cannot execute the same request.",document:graphql(`mutation ClaimWorkshopBuild($input: ClaimWorkshopBuildInput!) { claimWorkshopBuild(input:$input) }`)},
  FinishWorkshopBuild: {story:"As a workspace runner, I want to attach verified artifacts and tests, so that members can inspect a revision without replacing newer work.",document:graphql(`mutation FinishWorkshopBuild($input: FinishWorkshopBuildInput!) { finishWorkshopBuild(input:$input) }`)},
  StartWorkshopDesign: {
    story: "As a member or an agent working for one, I want to start Workshop's design agent on a part or project request with one mutation, so that design work begins from wherever I am without opening the project page or waiting on the model.",
    document: graphql(`mutation StartWorkshopDesign($input: StartWorkshopDesignInput!) { startWorkshopDesign(input: $input) }`),
  },
  WorkshopDesignRun: {
    story: "As a member or an agent working for one, I want to read a design run I started, so that I know when the project revision it saved is ready and which project to open.",
    document: graphql(`query WorkshopDesignRun($input: WorkshopDesignRunInput!) { workshopDesignRun(input: $input) }`),
  },
  CreateWorkshopProject: {
    story: "As a member, I want to start a project from a starter example on the Workshop page or through an agent, named for the product revision it builds, so that I can refine a working model instead of a blank one.",
    document: graphql(`mutation CreateWorkshopProject($input: CreateWorkshopProjectInput!) {
      createWorkshopProject(input: $input) { id name revision productRevisionId productRevisionTitle createdBy updatedBy createdAt updatedAt }
    }`),
  },
  NameWorkshopProductRevision: {
    story: "As a member, I want to name the Wiki product revision a project builds, so that its concepts and evidence publish to the right release chain.",
    document: graphql(`mutation NameWorkshopProductRevision($input: NameWorkshopProductRevisionInput!) {
      nameWorkshopProductRevision(input: $input) { id name revision productRevisionId productRevisionTitle createdBy updatedBy createdAt updatedAt }
    }`),
  },
  DescribeWorkshopProject: {
    story: "As a member, I want an agent to write a project's brief and requirements and move it through its stages as the work progresses, so that the project page says what we are building and how far along it is.",
    document: graphql(`mutation DescribeWorkshopProject($input: DescribeWorkshopProjectInput!) {
      describeWorkshopProject(input: $input) { id name revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  SaveWorkshopAssembly: {
    story: "As a member, I want an agent to lay out a device's product structure, its assemblies, parts, boards and firmware with the quantities and placements between them, so that the BOM, cost and 3D view show the design before anyone orders a part.",
    document: graphql(`mutation SaveWorkshopAssembly($input: SaveWorkshopAssemblyInput!) {
      saveWorkshopAssembly(input: $input) { id name revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  DeleteWorkshopProject: {
    story: "As a member, I want to delete a project at the revision I saw, so that I never remove what someone else just changed.",
    document: graphql(`mutation DeleteWorkshopProject($input: DeleteWorkshopProjectInput!) { deleteWorkshopProject(input: $input) }`),
  },
  RemoveWorkshopConcept: {
    story: "As a member, I want to remove a concept mockup that no longer shows what we mean to build, so that the gallery and the next publish carry only current design intent.",
    document: graphql(`mutation RemoveWorkshopConcept($input: RemoveWorkshopConceptInput!) {
      removeWorkshopConcept(input: $input) { id name revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  PublishWorkshopConcepts: {
    story: "As a member, I want to publish a project's concept mockups to the product revision in our Wiki, so that the release chain shows what the product will look like before anything is built.",
    document: graphql(`mutation PublishWorkshopConcepts($input: PublishWorkshopConceptsInput!) { publishWorkshopConcepts(input: $input) }`),
  },
  RecordWorkshopUnit: {
    story: "As a member, I want to record each board or part I have in hand by its MAC address or serial, so that the assembly shows what is in stock and no unit is entered twice.",
    document: graphql(`mutation RecordWorkshopUnit($input: RecordWorkshopUnitInput!) {
      recordWorkshopUnit(input: $input) { id partNumber mpn mac serial status location projectId firmware notes revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  UpdateWorkshopUnit: {
    story: "As a member, I want to mark a unit flashed, installed in a project or moved to a new bin at the revision I saw, so that the inventory follows each physical unit through the build.",
    document: graphql(`mutation UpdateWorkshopUnit($input: UpdateWorkshopUnitInput!) {
      updateWorkshopUnit(input: $input) { id partNumber mpn mac serial status location projectId firmware notes revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  WorkshopProjectHandoff: {
    story: "As a Planning agent or member, I want to read back one Workshop project's persisted brief, requirements, stage and whole assembly, so that I can verify a hardware handoff from stored state instead of a summary.",
    document: graphql(`query WorkshopProjectHandoff($input: WorkshopProjectHandoffInput!) { workshopProjectHandoff(input: $input) }`),
  },
  DeleteWorkshopUnit: {
    story: "As a member, I want to remove a unit I recorded by mistake or scrapped at the revision I saw, so that the inventory counts only units that exist.",
    document: graphql(`mutation DeleteWorkshopUnit($input: DeleteWorkshopUnitInput!) { deleteWorkshopUnit(input: $input) }`),
  },
});

// What an MCP client finds for Workshop (graph_documents): starting design work and following its run.
export const documents = publishDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups), {
  StartWorkshopDesign: { description: "Start Workshop's design agent on a part or project request (a new project, or a follow-up to one at the revision you saw) without waiting for the model. Answers the run id and status; follow it with WorkshopDesignRun." },
  WorkshopDesignRun: { description: "Read a design run started with StartWorkshopDesign: running, complete (with the projectId and revision it saved) or failed." },
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<WorkshopContext>(() => graphqlSchema);
