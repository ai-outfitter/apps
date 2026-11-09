// Start work: turn a Wiki knowledge graph into an issue and start it.
// The Wiki flattens the graph through Foundry's feature request template
// (`knowledge-graph.render`) and stores the result as a Wiki Issue. Foundry's
// `work.submit` opens the GitHub issue and starts the run, and the Wiki Issue
// then links to both. Retries converge on the Wiki Issue and the Foundry
// receipt, so no other state is kept.
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { entityRef, type EntityRecord } from "@ai-outfitter/app-sdk/entities";
import type { GraphSelectionDefinition } from "@ai-outfitter/app-sdk/graph-selection";
import { type GraphTemplate, renderKnowledgeGraph } from "@ai-outfitter/app-sdk/graph-templates";
import { defaultWiki, stableGraphId, wikiAdapter } from "@ai-outfitter/onto/client";
import { repositoryName } from "./projects";
import {
  approvedTarget,
  bodyLimit,
  foundryActions,
  intakeIssueBody,
  type IntakeContext,
  submissionKey,
  submitInput,
  submitOutput,
  workPackageDigest,
} from "./intake";
import { workSubmissions } from "./schema";

/** The graph a piece of work needs, around its root. Versioned code. */
const featureRequestSelection: GraphSelectionDefinition = {
  id: "foundry.feature-request",
  version: 1,
  purpose: "What a feature needs: its use cases, stories, requirements, acceptance criteria and the problems they address.",
  rootTypes: ["Project", "UseCase", "UserStory", "Requirement"],
  relationships: ["has_use_case", "has_story", "has_requirement", "has_acceptance_criterion", "addresses"],
  // Project → UseCase → UserStory → Requirement → AcceptanceCriterion.
  maxDepth: 4,
  maxNodes: 120,
  terminalTypes: ["Problem", "AcceptanceCriterion"],
  stopAtTypes: [],
  stopAfterTypes: [],
};
const rootTypes = featureRequestSelection.rootTypes.join(", ");
const each = (type: string, label: string, fields: [string, string][], content = "$item.summary") => ({
  rows: { op: "query", type },
  heading: { op: "concat", parts: [`${label}: `, "$item.title"] },
  level: 3,
  fields: fields.map(([fieldLabel, value]) => ({ label: fieldLabel, value })),
  content,
});
/** The feature request template the Wiki renders the selection through. Versioned code. */
const featureRequestTemplate: GraphTemplate = {
  version: 1,
  order: 0,
  name: "Foundry feature request v1",
  bindings: { root: { op: "ref", id: "$params.rootId" }, problems: { op: "query", type: "Problem" } },
  require: [{ op: "present", value: "$root" }],
  sections: [
    {
      heading: "Problem",
      level: 2,
      fields: [{
        label: "Problems",
        value: { op: "map", from: "$problems", value: { op: "concat", parts: ["$item.title", " — ", "$item.summary"] } },
        missing: "No Problem is linked to this work in the Wiki.",
      }],
    },
    { heading: "Requested change", level: 2, fields: [{ label: "Starting from", value: "$root.title" }], content: "$root.summary" },
    each("UseCase", "Use case", [], "$item.body"),
    each("UserStory", "Story", [["As", "$item.data.actor"], ["I want", "$item.data.capability"], ["So that", "$item.data.benefit"]]),
    each("Requirement", "Requirement", [["Statement", "$item.data.statement"], ["Rationale", "$item.data.rationale"], ["Status", "$item.data.status"]]),
    each("AcceptanceCriterion", "Acceptance criterion", [
      ["Condition", "$item.data.condition"], ["Expected outcome", "$item.data.expectedOutcome"],
      ["Given", "$item.data.given"], ["When", "$item.data.when"], ["Then", "$item.data.then"],
    ]),
  ],
};

const criterionBudget = 2000;
const wikiBodyLimit = 20_000;

/** A Wiki node at the revision the caller read (StartWork's root, RequestFeature's related nodes). */
export const nodeWitness = z.strictObject({
  ref: entityRef.extend({ type: z.literal("graph-node") }),
  revision: z.number().int().positive(),
});
export const startWorkDescription = "Start Foundry work from the Wiki: name a root Wiki node (Project, UseCase, UserStory or Requirement) at its current revision and a repository or Foundry project. The Wiki flattens the knowledge graph around it through the feature request template and stores it as a Wiki Issue; Foundry then opens the GitHub issue and starts the configured workflow (as submitWork does), and the Wiki Issue links to both. The root needs at least one linked AcceptanceCriterion. Retry with the same requestId to resume. Needs an organization installation and editor access.";
export const startWorkInput = z.strictObject({
  requestId: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .describe("Caller-generated ID. Reuse it to resume; changed content conflicts."),
  target: z.strictObject({ repository: repositoryName.optional(), project: z.uuid().optional() })
    .refine((value) => value.repository || value.project, "Name a repository or Foundry project"),
  root: nodeWitness.describe(`The Wiki node the work is about, at the revision you read: a ${rootTypes}.`),
  title: z.string().trim().min(1).max(160).optional(),
});
export const startWorkOutput = submitOutput.extend({
  /** The Wiki Issue holding the rendered request; its website is the GitHub issue. */
  wikiIssue: z.strictObject({ ref: entityRef, revision: z.number().int().positive() }),
  /** What the graph did not supply on this attempt; the work still started. */
  gaps: z.array(z.string()),
});

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
function data(record: EntityRecord): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(record.attributes.body ?? ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Select and render through the Wiki; refuse anything that cannot become an issue. */
async function render(context: IntakeContext, wikiId: string, input: z.output<typeof startWorkInput>) {
  let rendered: Awaited<ReturnType<typeof renderKnowledgeGraph>>;
  try {
    rendered = await renderKnowledgeGraph(context.host(), wikiId, {
      definition: featureRequestSelection,
      rootIds: [input.root.ref.id],
      templates: [featureRequestTemplate],
    });
  } catch (error) {
    if (error instanceof Response && [404, 409].includes(error.status))
      throw new Response(`Start work from a ${rootTypes} node in this organization's Wiki`, { status: 409 });
    throw error;
  }
  const { selection, document } = rendered;
  const root = selection.nodes.find((node) => node.ref.id === input.root.ref.id);
  if (!root || root.revision !== input.root.revision)
    throw new Response("The root node changed since you read it; read it again and retry", { status: 409 });
  const typeName = new Map(selection.types.map((type) => [type.ref.id, String(type.attributes.name)]));
  const named = (name: string) => selection.nodes.filter((node) => typeName.get(String(node.attributes.typeId)) === name);
  const criteria = named("AcceptanceCriterion").map((node) => {
    const fields = data(node);
    return {
      ...node.ref,
      revision: node.revision,
      condition: (text(fields.condition) || node.title).slice(0, criterionBudget),
      expectedOutcome: (text(fields.expectedOutcome) || text(node.attributes.summary) || node.title).slice(0, criterionBudget),
    };
  });
  if (!criteria.length)
    throw new Response(
      `"${root.title}" has no acceptance criteria in its knowledge graph. Link at least one AcceptanceCriterion (has_acceptance_criterion) and retry.`,
      { status: 422 },
    );
  if (criteria.length > 50) throw new Response("More than 50 acceptance criteria; start work from a narrower node", { status: 413 });
  const title = (input.title ?? root.title).slice(0, 160);
  const markdown = `# ${title}\n\n${document.markdown}\n_Flattened by the Wiki from ${featureRequestSelection.id} v${featureRequestSelection.version} with ${featureRequestTemplate.name}._\n`;
  if (markdown.length > wikiBodyLimit)
    throw new Response(`The request renders to ${markdown.length} characters; a Wiki issue holds ${wikiBodyLimit}. Start work from a narrower node.`, { status: 413 });
  const gaps = [
    ...(document.omitted.length || document.unresolved.length ? ["The knowledge graph was larger than one request holds, or referenced missing records."] : []),
    ...(selection.missingTypes.length ? [`This Wiki lacks: ${selection.missingTypes.join(", ")}.`] : []),
  ];
  return {
    title,
    markdown,
    criteria,
    sources: document.sources.map((source) => ({ ...source.ref, revision: source.revision })),
    requirements: named("Requirement").map((node) => node.ref.id),
    gaps,
  };
}

type Records = ReturnType<typeof wikiAdapter>;
type Input = z.output<typeof startWorkInput>;

/** Write the Wiki Issue (or bring an unsubmitted one up to date) and check the result is ours. */
async function storeIssue(context: IntakeContext, records: Records, wikiId: string, issueId: string, title: string, body: string) {
  let issue = await records.get("graph-node", issueId);
  if (!issue) {
    const typeId = (await records.typeIds()).get("Issue");
    if (!typeId) throw new Response("This Wiki has no Issue type; initialize its standard ontology", { status: 409 });
    issue = await records.createOrRead("graph-node", { id: issueId, typeId, title, body });
  } else if (issue.title !== title || issue.attributes.body !== body) {
    // Nothing reached GitHub yet, so the latest attempt's text wins.
    issue = await context.host().call("entities.update", {
      installationId: wikiId, type: "graph-node", id: issueId, revision: issue.revision, attributes: { title, body },
    });
  }
  if (issue.title !== title || issue.attributes.body !== body)
    throw new Response("Another attempt with this requestId is in progress; retry", { status: 409 });
  return issue;
}

/** First attempt (no Foundry receipt yet): render, check the target, store the Wiki Issue, then submit. */
async function prepare(context: IntakeContext, records: Records, wikiId: string, issueId: string, input: Input) {
  const flat = await render(context, wikiId, input);
  const pkg = { version: 1 as const, rendered: flat.markdown, sources: flat.sources, criteria: flat.criteria };
  const parsed = submitInput.safeParse({
    target: input.target,
    workPackage: { ...pkg, digest: await workPackageDigest(pkg) },
    requestId: input.requestId,
    title: flat.title,
    description: flat.markdown,
    acceptanceCriteria: flat.criteria.map((c) => `${c.condition} → ${c.expectedOutcome}`.slice(0, criterionBudget)),
    context: [
      { installationId: wikiId, type: "graph-node", id: issueId, title: flat.title },
      { ...input.root.ref, title: "Root" },
    ],
  });
  if (!parsed.success) throw new Response(`The request cannot become an issue: ${z.prettifyError(parsed.error)}`, { status: 422 });
  const submit = parsed.data;
  // Refuse before writing: the GitHub issue must hold the request, and the target must accept it.
  const length = intakeIssueBody(context, submit).length;
  if (length > bodyLimit)
    throw new Response(`The request renders to ${length} characters; an issue holds ${bodyLimit}. Start work from a narrower node.`, { status: 413 });
  const { repo } = await approvedTarget(context, submit.target);
  if (!repo.connection.operations.includes("issues.create")) throw new Response("Connector access unavailable", { status: 403 });

  const wikiIssue = await storeIssue(context, records, wikiId, issueId, flat.title, flat.markdown);
  const targets = (await records.typeIds()).get("targets_requirement");
  if (targets) for (const requirement of flat.requirements) await records.link(targets, issueId, requirement);
  return { submit, wikiIssue, gaps: flat.gaps };
}

/** Retry after Foundry claimed the request: its receipt is the frozen submission. */
function replay(payload: unknown, input: Input) {
  const submit = submitInput.parse(payload);
  const root = submit.context.at(1);
  const same =
    JSON.stringify(submit.target) === JSON.stringify(input.target) &&
    (!input.title || input.title === submit.title) &&
    root?.installationId === input.root.ref.installationId && root.id === input.root.ref.id;
  if (!same) throw new Response("Request ID already belongs to different work", { status: 409 });
  return submit;
}

/** Point the Wiki Issue at the GitHub issue and the Foundry submission; retried once on a concurrent Wiki edit. */
async function linkBack(context: IntakeContext, records: Records, wikiId: string, issueId: string, url: string, submissionId: string) {
  const source = { installationId: context.identity.installationId, type: "work-submission", id: submissionId };
  for (let attempt = 0; ; attempt++) {
    const issue = await records.get("graph-node", issueId);
    if (!issue) throw new Response("The Wiki issue for this request is missing; restore it or use a new requestId", { status: 409 });
    if (issue.attributes.website === url && JSON.stringify(issue.references) === JSON.stringify([source])) return issue;
    try {
      return await context.host().call("entities.update", {
        installationId: wikiId, type: "graph-node", id: issueId, revision: issue.revision, attributes: { website: url }, references: [source],
      });
    } catch (error) {
      if (attempt > 0 || !(error instanceof Response) || error.status !== 409) throw error;
    }
  }
}

/** Who may start work: an editor of an organization installation. startWork enforces it itself. */
export const organizationEditor = (context: Pick<ActionContext, "identity">) =>
  context.identity.canEdit && context.identity.owner.kind === "organization";

export async function startWork(context: IntakeContext, input: Input) {
  if (!organizationEditor(context)) throw new Response("App action not allowed", { status: 403 });
  const host = context.host();
  const wiki = await defaultWiki(host);
  if (input.root.ref.installationId !== wiki.installationId)
    throw new Response("The root must belong to this organization's Wiki", { status: 409 });
  if (!wiki.writable) throw new Response("Wiki is not writable", { status: 403 });
  const records = wikiAdapter(host, wiki.installationId);
  const { identity, actor } = context;
  const issueId = await stableGraphId("foundry-start-work-v1", identity.installationId, identity.userId, actor.kind, actor.id, input.requestId);

  const key = await submissionKey(context, input.requestId);
  const [receipt] = await context.db().select().from(workSubmissions).where(eq(workSubmissions.key, key));
  const prepared = receipt
    ? { submit: replay(receipt.payload, input), gaps: [] as string[] }
    : await prepare(context, records, wiki.installationId, issueId, input);

  const submitted = submitOutput.parse(await foundryActions["work.submit"].invoke(context, prepared.submit));
  let wikiIssue: EntityRecord;
  const gaps = [...prepared.gaps];
  try {
    wikiIssue = await linkBack(context, records, wiki.installationId, issueId, submitted.issue.url, submitted.submissionId);
  } catch (error) {
    if (!(error instanceof Response) || error.status !== 409) throw error;
    // The work started; the link is repaired by retrying with the same requestId.
    const current = await records.get("graph-node", issueId);
    if (!current) throw error;
    wikiIssue = current;
    gaps.push("The Wiki issue does not link to the GitHub issue yet; retry with the same requestId to link it.");
  }
  return { wikiIssue: { ref: wikiIssue.ref, revision: wikiIssue.revision }, ...submitted, gaps };
}
