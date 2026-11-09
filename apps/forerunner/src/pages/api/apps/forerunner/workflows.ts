import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { z } from "zod";
import { forerunnerContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";
import { suggestionInput } from "../../../../server/suggestions";
import { cancelAction, cancelRun, changeWorkflow, scheduleAction, workflowsView } from "../../../../server/workflows";

// The Workflows page. Workflows, schedules and runs come from the platform documents
// the member's MCP client uses (Schedules, WorkflowRuns, ScheduleChanges and
// WorkflowRunChanges); suggestions from Forerunner's published Suggestions and
// UpdateSuggestion documents.

export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const context = forerunnerContext(request, locals);
    const [view, { suggestions }] = await Promise.all([
      workflowsView(context.host(), context.db(), context.identity),
      runDocument(documents.Suggestions.document, {}, context) as Promise<{ suggestions: unknown[] }>,
    ]);
    return { ...view, suggestions };
  });

const change = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("schedule"), item: scheduleAction }),
  z.strictObject({ action: z.literal("cancel"), item: cancelAction }),
  suggestionInput.extend({ action: z.literal("suggestion") }),
]);

/** One change from the page: `schedule` (run now, pause, resume or delete), `cancel` (a run), or `suggestion` (apply or dismiss one by its status). */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const context = forerunnerContext(request, locals);
    const body = await readJSON(request, change, 2000);
    if (body.action === "schedule") return changeWorkflow(context.host(), context.identity, body.item);
    if (body.action === "cancel") return cancelRun(context.host(), context.db(), context.identity, body.item);
    const { action: _action, ...input } = body;
    return runDocument(documents.UpdateSuggestion.document, { input }, context);
  });
