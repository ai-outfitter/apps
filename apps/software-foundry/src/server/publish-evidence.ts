// Publish an uploaded evidence bundle to a Planning project in one call.
// SubmitReleaseEvidence stores the files; this stages the graph records that
// make Planning's project Evidence page show them (the app SDK's
// evidenceBundleOperations) as one Onto change batch, submits it for a member's
// review and returns the review and Planning links. It never approves the batch.
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { graphGraphqlResult, graphMutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { discoverEntityTypes } from "@ai-outfitter/app-sdk/entity-discovery";
import { evidenceBundleOperations, evidenceStep } from "@ai-outfitter/app-sdk/evidence-bundle";
import { readWikiGraph, stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { wikiChangeDocuments } from "@ai-outfitter/app-sdk/graph-contracts";
import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { storage } from "@ai-outfitter/app-sdk/storage";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { evidencePublishInput } from "./evidence";
import type { IntakeContext } from "./intake";
import { evidencePublications } from "./schema";

export const publishEvidenceDescription =
  "Show an uploaded evidence bundle on a Planning project's Evidence page. Name the bundle you uploaded with SubmitReleaseEvidence, the Planning project id, a Markdown body (result counts, environment, limits, how to reproduce) and the screenshots in step order by their bundle path or receipt URL. Foundry stages one Onto change batch (the bundle Document, one numbered Demonstration per screenshot, and their links to the project), submits it for a member's review and returns the review link and the Planning Evidence link. Nothing shows in Planning until a member approves the batch; this never approves it. Repeat with the same input to read the same batch.";

export const publishEvidenceInput = z.strictObject({
  bundle: evidencePublishInput.shape.bundle.describe("The bundle name the files were uploaded under."),
  projectId: z.uuid().describe("The Planning project, as Planning's Projects document lists it."),
  title: z.string().trim().min(1).max(160).describe("The bundle's title, such as 'iOS happy path, November 14'."),
  summary: z.string().trim().max(280).default(""),
  body: z.string().trim().min(1).max(65536).describe("Markdown: the result (e.g. 1 passed, 0 failed), environment, limits and how to reproduce. Images in it are not shown; list screenshots as steps."),
  environment: z.string().trim().min(1).max(500).describe("Where it ran, e.g. 'iPhone 16 simulator, iOS 26, fixture API'."),
  capturedAt: z.iso.datetime({ offset: true }).optional().describe("When the run captured the screenshots (ISO 8601 with a time zone). Leave it out to use when they were uploaded."),
  limitations: z.array(z.string().trim().min(1).max(500)).min(1).max(20).describe("What this evidence does not show, e.g. 'Simulator only' or 'Checkout is mocked'."),
  steps: z.array(z.strictObject({
    title: evidenceStep.shape.title,
    path: z.string().trim().min(1).max(1000).describe("The screenshot's path inside the bundle as uploaded, or its URL from the upload receipt."),
    caption: evidenceStep.shape.caption,
  })).min(1).max(40).describe("Screenshots in step order; each becomes a numbered Demonstration."),
});
type Input = z.output<typeof publishEvidenceInput>;

const refused = (message: string, status = 409) => new Response(message, { status });

async function mutate<T>(context: IntakeContext, ontoId: string, name: "StageChanges" | "SubmitBatch", input: Record<string, unknown>) {
  const result = graphGraphqlResult.parse(await context.host().call("actions.call", {
    installationId: ontoId, action: graphMutateAction,
    input: { query: wikiChangeDocuments[name].document, operationName: name, variables: { input } } as never,
  }));
  const error = result.errors?.[0];
  if (error || !result.data) throw refused(error?.message ?? `${name} returned no data`, Number(error?.extensions?.status ?? 422));
  return result.data as T;
}

const appBase = (app: { hostname?: string | null; slug?: string }, fallback: string) =>
  app.hostname ? `https://${app.hostname}/` : `/apps/${app.slug ?? fallback}/`;

const reference = z.object({ installationId: z.string(), type: z.string(), id: z.string() });

/** The Onto Project whose reference is the Planning project: the only link Planning follows. */
function projectNode(snapshot: Awaited<ReturnType<typeof readWikiGraph>>["snapshot"], projectId: string) {
  const typeName = new Map(snapshot.types.map((type) => [type.id, type.name]));
  const matches = snapshot.nodes.flatMap((node) => {
    const source = reference.safeParse(node.source);
    return !node.archived && typeName.get(node.typeId) === "Project" && source.success && source.data.type === "project" && source.data.id === projectId
      ? [{ id: node.id, revision: node.revision, source: source.data }] : [];
  });
  if (!matches.length)
    throw refused(`No Onto Project references Planning project ${projectId}, so Planning has nowhere to show this evidence. Link the Planning project to a Wiki project from its page, then retry.`, 404);
  if (matches.length > 1) throw refused("Several Onto Projects reference this Planning project; resolve the duplicates first.");
  return matches[0];
}

type Batch = { id: string; state: string; counts?: Record<string, number> };

export async function publishEvidence(context: IntakeContext, input: Input) {
  requireEditor(context.identity);
  if (!context.storageLocals) throw refused("Evidence storage unavailable", 503);
  const files = storage(context.storageLocals, "main");
  const steps: { title: string; caption: string; url: string }[] = [];
  let uploadedAt = 0;
  for (const step of input.steps) {
    const path = bundlePath(input.bundle, step.path);
    const file = await files.head({ space: "evidence", key: `${input.bundle}/${path}` });
    if (!file) throw refused(`${input.bundle}/${path} is not uploaded; publish it with SubmitReleaseEvidence first.`, 404);
    if (file.contentType !== "image/png") throw refused(`${path} is not a screenshot; steps take PNG files.`, 422);
    uploadedAt = Math.max(uploadedAt, file.createdAt);
    steps.push({ title: step.title, caption: step.caption, url: new URL(files.url(file), context.origin).href });
  }

  const { wiki, snapshot } = await readWikiGraph(context.host());
  if (!wiki.writable) throw refused("Onto is not writable for you", 403);
  const project = projectNode(snapshot, input.projectId);
  const documentId = await stableGraphId("foundry-evidence-bundle", context.identity.installationId, input.bundle);
  const planning = (await discoverEntityTypes(context.host(), { installationId: project.source.installationId }))[0];
  const planningUrl = `${appBase(planning ?? {}, "planning")}projects/${encodeURIComponent(input.projectId)}/evidence?bundle=${documentId}`;
  const reviewUrl = (batchId: string) => `${appBase(wiki, "onto")}changes/${encodeURIComponent(batchId)}`;
  const fingerprint = await sha256Hex(canonicalActionValue(input));

  const [published] = await context.db().select().from(evidencePublications).where(eq(evidencePublications.bundle, input.bundle));
  if (published && published.fingerprint !== fingerprint) throw refused("This bundle was already published with different content; use a new bundle.");
  const existing = snapshot.nodes.some((node) => node.id === documentId && !node.archived);
  if (existing && !published) throw refused("This bundle's Document already exists; it was published another way.");

  let batch: Batch | undefined;
  if (published?.batchId) batch = { id: published.batchId, state: published.state };
  if (!existing && (!batch || batch.state === "open")) {
    const operations = await evidenceBundleOperations({
      types: snapshot.types.filter((type) => !type.archived),
      document: { id: documentId, slug: slugFor(input.bundle), title: input.title, summary: input.summary, body: documentBody(input) },
      projectNodeId: project.id,
      subject: { id: project.id, revision: project.revision },
      environment: input.environment,
      capturedAt: input.capturedAt ?? new Date(uploadedAt).toISOString(),
      limitations: input.limitations,
      steps,
    });
    const proposals = operations.map((operation) => ({
      operation,
      evidence: [{ provider: "software-foundry", recordId: `evidence/${input.bundle}`, uri: steps[0].url }],
      confidence: 1,
      reason: "Test evidence uploaded to Software Foundry, linked to the Planning project it belongs to.",
    }));
    const staged = (await mutate<{ stageChanges: Batch }>(context, wiki.installationId, "StageChanges", batch
      ? { batchId: batch.id, proposals }
      : { title: `Evidence: ${input.title}`.slice(0, 200), purpose: `Show bundle ${input.bundle} on the Planning project's Evidence page.`, source: { kind: "agent-task", ref: `evidence/${input.bundle}`, label: "Software Foundry evidence" }, anchors: [project.id], proposals })).stageChanges;
    await context.db().insert(evidencePublications).values({ bundle: input.bundle, fingerprint, batchId: staged.id, documentId, state: staged.state, createdBy: context.identity.userId, createdAt: Date.now() })
      .onConflictDoUpdate({ target: evidencePublications.bundle, set: { batchId: staged.id, state: staged.state } });
    batch = (await mutate<{ submitBatch: Batch }>(context, wiki.installationId, "SubmitBatch", {
      batchId: staged.id,
      summary: `${steps.length} screenshots from bundle ${input.bundle} for the Planning project's Evidence page.`,
    })).submitBatch;
    await context.db().update(evidencePublications).set({ state: batch.state }).where(eq(evidencePublications.bundle, input.bundle));
  }
  const state = existing ? "committed" : batch!.state;
  return {
    documentId,
    batchId: batch?.id ?? null,
    state,
    reviewUrl: batch ? reviewUrl(batch.id) : null,
    planningUrl,
    next: state === "committed"
      ? "The evidence shows on the Planning project's Evidence page."
      : "A member reviews the batch at reviewUrl; the evidence shows on planningUrl only after they approve it. Do not approve it yourself. If no Planning issue on this project holds the acceptance criteria this evidence proves, add one (Planning IssueChanges) listing them with their status and linking planningUrl; leave unrelated issues as they are.",
  };
}

/** The member reads the Document, not the Demonstrations' bodies: it always states where the run happened and its limits. */
function documentBody(input: Input) {
  const known = input.body.toLowerCase();
  const missing = [input.environment, ...input.limitations].filter((line) => !known.includes(line.toLowerCase()));
  if (!missing.length) return input.body;
  return `${input.body}\n\n## Where it ran and its limits\n\n- Environment: ${input.environment}\n${input.limitations.map((line) => `- ${line}`).join("\n")}\n`;
}

/** A step's file inside the bundle: its path, or the URL the upload receipt returned for it. */
function bundlePath(bundle: string, value: string) {
  const marker = `/files/main/evidence/${bundle}/`;
  let path = value;
  if (/^https?:\/\//.test(value)) {
    const pathname = decodeURIComponent(new URL(value).pathname);
    const at = pathname.indexOf(marker);
    if (at < 0) throw refused(`${value} is not a file of bundle ${bundle}.`, 422);
    path = pathname.slice(at + marker.length);
  }
  const parsed = evidencePublishInput.shape.path.safeParse(path.replace(/^\/+/, ""));
  if (!parsed.success) throw refused(`${value} is not a screenshot path in bundle ${bundle}.`, 422);
  return parsed.data;
}

/** A Document slug from the bundle name (slugs are lower-case words joined by hyphens). */
function slugFor(bundle: string) {
  return `${bundle.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70)}-evidence`.replace(/^-/, "");
}
