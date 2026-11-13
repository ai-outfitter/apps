import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestActor, requestIdentity, requestOriginActor, requireEditor, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { reviewBatchOntology } from "../../../../../server/batch-review";
import {
  batchIdInput, batchListInput, batchReviewInput, getBatch, listBatches, recordHistory, recordHistoryInput,
  reviewBatch, sealDueBatches, validateBatch,
} from "../../../../../server/graph-batches";

// The Changes pages: list and read batches, member review, a fresh steward
// review (a new batch-review run; advisory only), record history.
// Reading the list first seals batches whose review window has ended.
export const GET: APIRoute = ({ request, params }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return new Response("Read-only demo", { status: 403 });
  return respond(async () => {
    const who = requestIdentity(request), db = installationDatabase();
    const query = Object.fromEntries(new URL(request.url).searchParams);
    if (params.operation === "list") {
      await sealDueBatches(db, who);
      return listBatches(db, who, batchListInput.parse(query.state ? { state: query.state } : {}));
    }
    if (params.operation === "get") {
      await sealDueBatches(db, who);
      const input = batchIdInput.parse({ batchId: query.id });
      return { ...await getBatch(db, who, input), validation: await validateBatch(db, who, input) };
    }
    if (params.operation === "history") return recordHistory(db, who, recordHistoryInput.parse({ id: query.id }));
    throw new Response("Not found", { status: 404 });
  });
};

export const POST: APIRoute = ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return new Response("Read-only demo", { status: 403 });
  return respond(async () => {
    const who = requestIdentity(request), db = installationDatabase();
    if (params.operation === "review")
      return reviewBatch(db, who, requestActor(request, who), requestOriginActor(request, who), await readJSON(request, batchReviewInput, 64000));
    if (params.operation === "steward-review") {
      requireEditor(who);
      const { batchId } = await readJSON(request, batchIdInput, 4000);
      await reviewBatchOntology(db, who, workflowHost<"interactive">(locals as never), batchId);
      return getBatch(db, who, { batchId });
    }
    throw new Response("Not found", { status: 404 });
  });
};
