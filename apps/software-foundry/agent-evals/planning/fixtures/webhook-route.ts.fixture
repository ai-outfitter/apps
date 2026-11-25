// This route is installed only in the network-disabled replay container. It
// adapts a real signed Forgejo event to the platform's authenticated app phase.
import type { APIRoute } from "astro";
import { appendFileSync, readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { eventResult } from "@ai-outfitter/app-sdk/workflow-host";
import { runtime } from "#runtime";
import { workflowSubscriptions } from "../../../db/schema";
import { invokeWorkflowApp, wireObject } from "../../../lib/workflow-app-host";

export const POST: APIRoute = async ({ request }) => {
  const body = Buffer.from(await request.arrayBuffer());
  const secret = readFileSync("/box/planning-webhook-secret", "utf8");
  const signature = request.headers.get("x-forgejo-signature") ?? request.headers.get("x-gitea-signature") ?? "";
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (!/^[a-f\d]{64}$/i.test(signature) || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return new Response("Invalid Forgejo signature", { status: 401 });

  const payload = JSON.parse(body.toString("utf8"));
  const type = request.headers.get("x-forgejo-event") ?? request.headers.get("x-gitea-event");
  const deliveryId = request.headers.get("x-forgejo-delivery") ?? request.headers.get("x-gitea-delivery");
  if (type !== "issues" || !deliveryId || payload.action !== "opened" ||
      payload.repository?.full_name !== "box/native-apple" || !Number.isSafeInteger(payload.repository.id))
    return new Response("Unexpected fixture event", { status: 400 });

  const host = runtime();
  const resource = String(payload.repository.id);
  const [subscription] = await host.primaryDb.select().from(workflowSubscriptions).where(and(
    eq(workflowSubscriptions.connectionId, "box-forgejo"),
    eq(workflowSubscriptions.resource, resource),
    eq(workflowSubscriptions.workflowId, "issue-to-merge-actions-ci"),
    eq(workflowSubscriptions.enabled, true),
  ));
  if (!subscription) return new Response("Expected an approved fixture subscription", { status: 404 });

  const runId = crypto.randomUUID();
  const result = await invokeWorkflowApp(host, {
    organizationId: subscription.organizationId,
    installationId: subscription.installationId,
    userId: subscription.createdBy,
  }, "event", {
    runId, deliveryId,
    subscription: { id: subscription.id, workflowId: subscription.workflowId, inputs: wireObject(subscription.inputs) },
    trigger: { input: "triage.inputs.event" },
    event: { type: "github.issue", resource, subject: String(payload.issue.number), payload },
  }, { subscriptionId: subscription.id }, eventResult);

  appendFileSync("/out/webhooks.jsonl", JSON.stringify({
    deliveryId, runId, resource, issue: payload.issue.number, authorId: payload.issue.user.id, signatureVerified: true, result,
  }) + "\n");
  return Response.json(result);
};
