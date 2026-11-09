import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { planningContext } from "../../../../server/context";
import {
  documents,
  pageWrite,
  runDocument,
} from "../../../../server/documents";
const writes = {
  POST: pageWrite(documents.GenerateProductReport.document),
  PUT: pageWrite(documents.ChangeProductReportSchedule.document),
};
const route: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const context = planningContext(request, locals);
    if (request.method === "GET") {
      const [schedule, runs] = await Promise.all([
        runDocument(documents.ProductReportSchedule.document, {}, context),
        runDocument(documents.ProductReportRuns.document, {}, context),
      ]);
      return { ...schedule, ...runs };
    }
    const write = writes[request.method as keyof typeof writes];
    if (!write) throw new Response("Method not allowed", { status: 405 });
    return write(
      await readJSON(request, z.record(z.string(), z.unknown()), 4096),
      context,
    );
  });
export const GET = route;
export const POST = route;
export const PUT = route;
