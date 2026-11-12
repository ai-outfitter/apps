import { withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
// Internal page documents and the explicitly selected MCP subset below reuse
// the same app-owned schema, services and authorization. Generated helpers alone
// do not publish agent capabilities.
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { documentRunner } from "@ai-outfitter/app-sdk/app-graphql";
import { graphql } from "../../graph/graphql";
import { graphqlSchema } from "./graphql";
import type { IntakeContext } from "./intake";

const legacyDocuments = defineDocuments({
  SubmitReleaseEvidence:{
    story:"As an authorized editor, I want presigned upload URLs for release evidence assets, so that I can transfer verified files without sending their bytes through MCP or approving a release.",
    document:graphql(`mutation SubmitReleaseEvidence($input:SubmitReleaseEvidenceInput!){submitReleaseEvidence(input:$input)}`),
  },
  Requests:{story:"As a caller, I want to search my feature and bug requests, so that I can find their GitHub issues.",document:`query Requests($input:RequestsInput! = {}) {requests(input:$input)}`},
  WorkTargets: {
    hidden:true,
    story: "As an agent, I want the Foundry projects with their repositories, so that I can name a target before filing a request.",
    document: graphql(`query WorkTargets { foundryProjects(first: 50) { nodes { id name repositories } } }`),
  },
  DailyShipped: {
    hidden:true,publicName:"ShippedChanges",
    story: "As a stakeholder or their agent, I want every pull request merged in a window (yesterday, by default a day) with its kind and the parts of the repository it touched, so that I can read or write a daily report of what shipped.",
    document: graphql(`query DailyShipped($since: DateTime!, $until: DateTime, $repositories: [String!]) {
      changes(since: $since, until: $until, repositories: $repositories) {
        changes { repository number title url mergedAt author mergeCommit kind areas } failed complete
      }
    }`),
  },
  CreateProject: {
    story: "As an owner, I want to add a project from the projects page or an agent, so that work can be routed to its repositories.",
    document: graphql(`mutation CreateProject($input: CreateProjectInput!) {
      createProject(input: $input) { id name position repositories milestones revision updatedAt }
    }`),
  },
});

export const documents = publishDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups, {foundryProjects:"Projects",work:"WorkRecords"}), {
  SubmitReleaseEvidence:{description:"Get presigned R2 PUT URLs for PNG/JSON release evidence (screenshots, manifests). Supply stable asset keys, size and SHA-256; PUT each file to its uploadUrl with the listed headers (no sign-in), then repeat with the same keys to verify, publish and read each file's URL. No approval or deployment."},
  "Requests": {
    "description": "Read your feature and bug requests with their GitHub issues."
  },
  "RepositoryChanges": {
    "description": "Turn Foundry execution on for a repository (action enable, input {repository}): approves Foundry's role agents and subscribes to the repository's issues, so RequestChanges there starts work instead of answering that execution is not configured. Repeat to refresh after a Foundry change. Owners and admins only; use a new item key each time."
  },
  "RequestChanges": {
    "description": "File feature or bug requests (kind, title, problem, acceptance criteria with ids, and bug details for bugs; strict JSON Schema, the same work request the Foundry box reads). Each opens a GitHub issue in the named repository or Foundry project and starts Foundry's issue-to-merge workflow. Returns the issue and run; if execution is unavailable the issue is still recorded with execution details. Retry with the same requestId; use a new item key. Action resume {requestId, resumeId} starts a request's failed or awaiting-details run again on the same issue."
  }
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<IntakeContext>(() => graphqlSchema);
