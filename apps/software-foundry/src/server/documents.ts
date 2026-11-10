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
    story:"As an authorized editor, I want expiring upload links for release evidence assets, so that I can transfer verified files without sending their bytes through MCP or approving a release.",
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
  SubmitReleaseEvidence:{description:"Get expiring PUT links for PNG/JSON release evidence. Supply stable asset keys, size and SHA-256; upload with the same authenticated account, then repeat to read verified receipts. No approval or deployment."},
  "Requests": {
    "description": "Read your feature and bug requests with their GitHub issues."
  },
  "RequestChanges": {
    "description": "File feature or bug requests (kind, title, problem, requested change, acceptance criteria; strict JSON Schema). Each opens a GitHub issue in the named repository or Foundry project and starts Foundry's issue-to-merge workflow. Returns the issue and run; if execution is unavailable the issue is still recorded with execution details. Retry with the same requestId; use a new item key."
  }
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<IntakeContext>(() => graphqlSchema);
