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
  WorkshopCotsEvidence:{
    story:"As a hardware builder, I want to read shared purchased-part evidence in my assembly, so that I can check the mating features in CAD.",
    document:graphql(`query WorkshopCotsEvidence($input:WorkshopCotsEvidenceInput!){workshopCotsEvidence(input:$input)}`),
  },
  RecordWorkshopCotsEvidence:{
    story:"As a hardware builder, I want to preserve photos and measured dimensions on their purchased part, so that every consuming assembly can reuse them.",
    document:graphql(`mutation RecordWorkshopCotsEvidence($input:RecordWorkshopCotsEvidenceInput!){recordWorkshopCotsEvidence(input:$input)}`),
  },
  RecordWorkshopPrintPlate:{story:"As a hardware builder, I want to record time and material from the actual grouped print plates, so that I can prepare the correct amount of filament.",document:graphql(`mutation RecordWorkshopPrintPlate($input:RecordWorkshopPrintPlateInput!){recordWorkshopPrintPlate(input:$input)}`)},
  WorkshopPrint:{story:"As a hardware builder, I want to review print preflight and sliced plate estimates for my assembly, so that I can plan the fabrication run.",document:graphql(`query WorkshopPrint($input:WorkshopPrintInput!){workshopPrint(input:$input)}`)},
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
      updateWorkshopAssembly(projectId: $projectId, expectedRevision: $expectedRevision, assembly: $assembly) { projectId revision printFindings cotsWarnings }
    }`),
  },
  // Planning calls this exact document. New receipt fields belong on UpdateWorkshopAssembly.
  SaveWorkshopAssembly: {
    story: "As a member, I want an agent to lay out a device's product structure, its assemblies, parts, boards and firmware with the quantities and placements between them, so that the BOM, cost and 3D view show the design before anyone orders a part.",
    document: graphql(`mutation SaveWorkshopAssembly($input: SaveWorkshopAssemblyInput!) {
      saveWorkshopAssembly(input: $input) { id name purpose revision createdBy updatedBy createdAt updatedAt printFindings }
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

export const documents = publishDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups), {
  WorkshopCotsEvidence:{description:"Read resolved evidence for the selected assembly or COTS item. Returns the canonical owner, verified original photo locations, nominal and measured dimensions, tolerance and fit observations. Use includeIdentifiers:true; pass itemId for a focused read. An unpinned evidence reference follows the owner's current revision even when reading a historical consumer."},
  RecordWorkshopCotsEvidence:{description:"Record reference photos and structured per-interface evidence on the owning COTS item at expectedRevision. Photos reference existing original JPEG/PNG uploads by filename, digest and historical attachment revision. Use attachmentOwner {projectId,itemId} when the original was attached to another item. Distinguish nominal, measured and unknown dimensions; only record a fit observation against the tested project revision and configuration. Workshop records which matching owner revision was resolved when the observation was entered. An untested interface may carry a reason and exact historical trial without asserting fit. Reuse evidence from another item through cotsEvidenceRef in WorkshopAssembly."},
  RecordWorkshopPrintPlate:{description:"Register the native Bambu Studio 3MF and CLI result.json by their byte counts and SHA-256 digests. Include every physical plate's index and membership as itemId, sha256 and quantity. Workshop verifies the embedded 3MF instances against the stored STL geometry. PUT raw bytes to each returned uploads URL with its headers, then repeat the operation to preserve the grouped estimates."},
  WorkshopPrint:{description:"Read the current print preflight, independent estimates, assigned plate groups and evidence receipts for a project configuration. Pass itemId to inspect only that part or subassembly."},
  WorkshopSourceFile:{description:"Read a CAD source file from the organization's connected Forgejo repository. Supply repository, path and ref. Returns base64 content, byte size and Git blob SHA."},
  ResolvedWorkshopAssemblyPage: { description: "Read large resolved records including geometry, motion, meshes, sources and build price. Use includeIdentifiers:true. Pass input.projectId and optional configuration, parameters, revision. Repeat the same input with cursor set to nextCursor until null. Concatenate jsonText chunks in order, verify UTF-8 totalBytes and sha256, then JSON.parse. If the source graph changed, restart at page one." },
  ResolvedWorkshopAssembly: { description: "Read the expanded CAD, BOM and power assembly, buildPrice (knownSubtotal, estimatedSubtotal and unpricedUnits), and source revisions. Supply input.projectId and optional revision, configuration and numeric parameters. On RESPONSE_TOO_LARGE use ResolvedWorkshopAssemblyPage. Use WorkshopAssembly for edits." },
  WorkshopAssembly: { description: "Call graph_query with includeIdentifiers:true to read the complete saved assembly, including usage quantities, placements, explode instructions, joints, named operations and power inputs, with its current project revision." },
  UpdateWorkshopAssembly: { description: "Save the full assembly returned by WorkshopAssembly with your edits and its observed revision. Reference another source with an empty assembly item reference {projectId, configuration?, parameters?, revision?}. Omit revision to follow source updates. Author joints on uses and operations on their owning assembly item. Tracks and handoffs address installed usageUUID#copy paths relative to the owner. Any uses[].explode makes its parent inspection level authored-only. Siblings with no instruction stay put. A level with no instructions spreads automatically. Set explode {offset: [x,y,z], step?} in parent-local mm. An offset of [0,0,0] stays put. The largest step divides the slider into equal intervals, including gaps. Each move uses its numbered interval (1–100, default 1). Alternatively set explode {fixed: true} without offset or step to keep that occurrence fixed at its parent level. Add rigid: true to either form to keep all descendants assembled when inspecting that occurrence or any level inside it. Explosion is view-only. On conflict, reread and reapply the intended edit. Use cotsEvidenceRef {projectId,itemId,revision?} on a COTS item to reuse its owner's evidence. The receipt includes cotsWarnings for missing evidence and structured printFindings with the current checked item, digest, profile, state and location." },
  UploadWorkshopAssemblyFile:{description:"Attach an original JPEG/PNG reference photo, CAD file or animation. Supply projectId, itemId, expectedRevision, fileName, sha256, bytes and STL-only meshBounds {min,max} in mm, and optional STL-only supportPolicy. Use retryPrintCheck:true to request a retry of a failed STL check. PUT the raw file to upload.url using upload.headers; repeat the same input to attach it. Returns revision, file receipt and printFindings with the checked item, digest, profile, state and warning location for STL."},
  VerifyWorkshopAssemblyFile:{description:"Supply projectId, itemId and fileName; pass revision to verify a historical attachment. Rehash the stored original and return its digest, size and downloadPath. To read original bytes through MCP, pass byteOffset:0 and includeIdentifiers:true. Decode each base64 page and follow nextByteOffset with expectedSha256 set to the receipt digest until null."},
  SubmitWorkshopPcb: { description: "Import a KiCad PCB review package. Send projectId, observed revision, stable snapshotId, reviewPath and Workshop build manifest. PUT raw files to each returned URL with its headers, then repeat the same input to verify the bytes and read the PCB page path." },
  DescribeWorkshopProject: { description: "Set model purpose to product (hardware to manufacture) or component (purchased/reference library model), and optionally update name, phase, brief or requirements. Supply input.id and observed input.revision; fields omitted remain unchanged. Classification preserves geometry and cross-model references." },
  WorkshopProjects: { description: "Find products or reusable component library models and their current revision. Filter purpose to product or component; references can use either." },
  CreateWorkshopProject: { description: "Create a Workshop project for a product or PCB package and return its ID and revision." },
  StartWorkshopDesign: { description: "Start Workshop's design agent on a part or project request (a new project, or a follow-up to one at the revision you saw) without waiting for the model. Answers the run id and status; follow it with WorkshopDesignRun." },
  WorkshopDesignRun: { description: "Read a design run started with StartWorkshopDesign: running, complete (with the projectId and revision it saved) or failed." },
  AcceptCreativeHandoff: { description: "Attach a selected mockup as a design request without modifying CAD." },
  AttachCreativeResult: { description: "Link a committed result candidate back to its design request." },
});


/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<WorkshopContext>(() => graphqlSchema);
