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
  WorkshopSourceFile:{story:"As a designer, I want to read CAD from my connected Forgejo repository, so that I can verify the exact source used by my project.",document:graphql(`query WorkshopSourceFile($input:WorkshopSourceFileInput!){workshopSourceFile(input:$input)}`)},
  UploadWorkshopAssemblyFile:{story:"As a designer, I want to attach a fabrication file to a saved item, so that members can inspect the original CAD and clips.",document:graphql(`mutation UploadWorkshopAssemblyFile($input:UploadWorkshopAssemblyFileInput!){uploadWorkshopAssemblyFile(input:$input)}`)},
  VerifyWorkshopAssemblyFile:{story:"As a designer, I want to verify an attached file, so that I can confirm its stored bytes match my source.",document:graphql(`query VerifyWorkshopAssemblyFile($input:VerifyWorkshopAssemblyFileInput!){verifyWorkshopAssemblyFile(input:$input)}`)},
  SubmitWorkshopPcb: {
    story: "As a workspace agent, I want to publish a verified PCB package, so that members can review its board, quote and manufacturing files.",
    document: graphql(`mutation SubmitWorkshopPcb($input: SubmitWorkshopPcbInput!) { submitWorkshopPcb(input: $input) }`),
  },
 AcceptCreativeHandoff:{story:"As a member, I want to hand a selected mockup to Workshop with constraints, so that design work starts from a pinned reference.",document:graphql(`mutation AcceptCreativeHandoff($input:AcceptCreativeHandoffInput!){acceptCreativeHandoff(input:$input)}`)},
 AttachCreativeResult:{story:"As a member, I want to link a result candidate to the original mockup request, so that presentations and marketing can reuse its evidence.",document:graphql(`mutation AttachCreativeResult($input:AttachCreativeResultInput!){attachCreativeResult(input:$input)}`)},
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
      createWorkshopProject(input: $input) { id name purpose revision productRevisionId productRevisionTitle createdBy updatedBy createdAt updatedAt }
    }`),
  },
  NameWorkshopProductRevision: {
    story: "As a member, I want to name the Wiki product revision a project builds, so that its concepts and evidence publish to the right release chain.",
    document: graphql(`mutation NameWorkshopProductRevision($input: NameWorkshopProductRevisionInput!) {
      nameWorkshopProductRevision(input: $input) { id name purpose revision productRevisionId productRevisionTitle createdBy updatedBy createdAt updatedAt }
    }`),
  },
  DescribeWorkshopProject: {
    story: "As a member, I want an agent to write a project's brief and requirements and move it through its stages as the work progresses, so that the project page says what we are building and how far along it is.",
    document: graphql(`mutation DescribeWorkshopProject($input: DescribeWorkshopProjectInput!) {
      describeWorkshopProject(input: $input) { id name purpose revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  ResolvedWorkshopAssemblyPage: {
    story: "As a prototype builder, I want to page through a resolved assembly, so that I can verify its entire CAD and animation record.",
    document: graphql(`query ResolvedWorkshopAssemblyPage($input: ResolvedWorkshopAssemblyPageInput!) {
      resolvedWorkshopAssemblyPage(input:$input) { projectId revision sha256 offset totalBytes jsonText nextCursor }
    }`),
  },
  ResolvedWorkshopAssembly: {
    story: "As a prototype builder, I want to inspect the configured assembly and its source revisions, so that I can verify shared CAD and power across projects.",
    document: graphql(`query ResolvedWorkshopAssembly($input: ResolvedWorkshopAssemblyInput!) { resolvedWorkshopAssembly(input: $input) }`),
  },
  WorkshopAssembly: {
    story: "As a prototype builder, I want my agent to read the saved assembly and its power inputs, so that I can change one quantity and verify its effect.",
    document: graphql(`query WorkshopAssembly($projectId: ID!) {
      workshopAssembly(projectId: $projectId) { projectId revision assembly }
    }`),
  },
  UpdateWorkshopAssembly: {
    story: "As a prototype builder, I want my agent to save my assembly edit at the observed revision, so that concurrent project changes are preserved.",
    document: graphql(`mutation UpdateWorkshopAssembly($projectId: ID!, $expectedRevision: Int!, $assembly: WorkshopAssemblyInput!) {
      updateWorkshopAssembly(projectId: $projectId, expectedRevision: $expectedRevision, assembly: $assembly) { projectId revision }
    }`),
  },
  SaveWorkshopAssembly: {
    story: "As a member, I want an agent to lay out a device's product structure, its assemblies, parts, boards and firmware with the quantities and placements between them, so that the BOM, cost and 3D view show the design before anyone orders a part.",
    document: graphql(`mutation SaveWorkshopAssembly($input: SaveWorkshopAssemblyInput!) {
      saveWorkshopAssembly(input: $input) { id name purpose revision createdBy updatedBy createdAt updatedAt }
    }`),
  },
  DeleteWorkshopProject: {
    story: "As a member, I want to delete a project at the revision I saw, so that I never remove what someone else just changed.",
    document: graphql(`mutation DeleteWorkshopProject($input: DeleteWorkshopProjectInput!) { deleteWorkshopProject(input: $input) }`),
  },
  RemoveWorkshopConcept: {
    story: "As a member, I want to remove a concept mockup that no longer shows what we mean to build, so that the gallery and the next publish carry only current design intent.",
    document: graphql(`mutation RemoveWorkshopConcept($input: RemoveWorkshopConceptInput!) {
      removeWorkshopConcept(input: $input) { id name purpose revision createdBy updatedBy createdAt updatedAt }
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

// Only these reach MCP clients, on the platform's /mcp and on Workshop's own /mcp/workshop;
// the single-action documents stay for Workshop's own pages. Design turns and concept
// images are Workshop workflows: platform StartTasks and WorkflowRuns with app workshop.
export const documents = publishDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups), {
  WorkshopSourceFile:{description:"Read a CAD source file from the organization's connected Forgejo repository. Supply repository, path and ref. Returns base64 content, byte size and Git blob SHA."},
  ResolvedWorkshopAssemblyPage: { description: "Read large resolved records including geometry, motion, meshes, sources and build price. Use includeIdentifiers:true. Pass input.projectId and optional configuration, parameters, revision. Repeat the same input with cursor set to nextCursor until null. Concatenate jsonText chunks in order, verify UTF-8 totalBytes and sha256, then JSON.parse. If the source graph changed, restart at page one." },
  ResolvedWorkshopAssembly: { description: "Read the expanded CAD, BOM and power assembly, buildPrice (knownSubtotal, estimatedSubtotal and unpricedUnits), and source revisions. Supply input.projectId and optional revision, configuration and numeric parameters. On RESPONSE_TOO_LARGE use ResolvedWorkshopAssemblyPage. Use WorkshopAssembly for edits." },
  WorkshopAssembly: { description: "Call graph_query with includeIdentifiers:true to read the complete saved assembly, including usage quantities, placements, joints, named operations and power inputs, with its current project revision." },
  UpdateWorkshopAssembly: { description: "Save the full assembly returned by WorkshopAssembly with your edits and its observed revision. Reference another source with an empty assembly item reference {projectId, configuration?, parameters?, revision?}. Omit revision to follow source updates. Author joints on uses and operations on their owning assembly item. Tracks and handoffs address installed usageUUID#copy paths relative to the owner. On conflict, reread and reapply the intended edit." },
  UploadWorkshopAssemblyFile:{description:"Attach an original JPEG/PNG reference photo, CAD file or animation. Supply projectId, itemId, expectedRevision, fileName, sha256, bytes and STL-only meshBounds {min,max} in mm. PUT the raw file to upload.url using upload.headers; repeat the same input to attach it. Returns revision and file receipt."},
  VerifyWorkshopAssemblyFile:{description:"Supply projectId, itemId and fileName. Rehash the stored original and return its digest, size and downloadPath. To read original bytes through MCP, pass byteOffset:0 and includeIdentifiers:true. Decode each base64 page and follow nextByteOffset with expectedSha256 set to the receipt digest until null."},
  SubmitWorkshopPcb: { description: "Import a KiCad PCB review package. Send projectId, observed revision, stable snapshotId, reviewPath and Workshop build manifest. PUT raw files to each returned URL with its headers, then repeat the same input to verify the bytes and read the PCB page path." },
  DescribeWorkshopProject: { description: "Set model purpose to product (hardware to manufacture) or component (purchased/reference library model), and optionally update name, phase, brief or requirements. Supply input.id and observed input.revision; fields omitted remain unchanged. Classification preserves geometry and cross-model references." },
  WorkshopProjects: { description: "Find products or reusable component library models (filter purpose to product or component) by name, product revision or creator, with their current revision, before changes, references or PCB imports. Use includeIdentifiers:true for IDs and revisions.", collection: true },
  WorkshopProjectHandoff: { description: "Read one project as persisted: brief, requirements, stage, product revision and its whole assembly with usage lines. Changes nothing." },
  WorkshopUnits: { description: "Find physical units (boards, parts) by part number, MAC, status or project.", collection: true },
  CreateWorkshopProject: { description: "Create a Workshop project for a product or PCB package and return its ID and revision." },
  ProjectChanges: { description: "Create a project from a starter example, write its brief, requirements and stage, or delete it. Edits and deletes need the id and revision from WorkshopProjects; stable item keys make retries safe." },
  UnitChanges: { description: "Record, update or delete physical units by MAC address or serial. Updates and deletes need the id and revision from WorkshopUnits." },
  ConceptChanges: { description: "Publish a project's concept mockups to its product revision in the Wiki, or remove one mockup, at the project's current revision." },
  ProductRevisionChanges: { description: "Name the Wiki product revision a project builds, at the project's current revision." },
  StartWorkshopDesign: { description: "Start Workshop's design agent on a part or project request (a new project, or a follow-up to one at the revision you saw) without waiting for the model. Answers the run id and status; follow it with WorkshopDesignRun." },
  WorkshopDesignRun: { description: "Read a design run started with StartWorkshopDesign: running, complete (with the projectId and revision it saved) or failed." },
  AcceptCreativeHandoff: { description: "Attach a selected mockup as a design request without modifying CAD." },
  AttachCreativeResult: { description: "Link a committed result candidate back to its design request." },
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<WorkshopContext>(() => graphqlSchema);
