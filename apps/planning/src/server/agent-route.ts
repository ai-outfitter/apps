import { intakeAgent, intakeAgentFocus } from "./intake-agent";
import { requestActor, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestMemberIds } from "@ai-outfitter/app-sdk/members";
import {
  readJSON,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { parseThreadRefKey, threadRef } from "@ai-outfitter/app-sdk/threads";
import {
  workflowHost,
  type WorkflowHost,
} from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { intakeFocus, productsFocus } from "../agent-focus";
import { actions, intakeActions } from "./agent";
import {
  conversationType,
  intakeContext,
  planningConversations,
  projectContext,
  productsContext,
} from "./conversations";

/** The live member directory, or undefined while it is unavailable (assignments then fail closed). */
export function memberSnapshot(request: Request) {
  try {
    return requestMemberIds(request);
  } catch (error) {
    if (error instanceof Response && error.status === 503) return undefined;
    throw error;
  }
}
function agentId(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new Response("Invalid agent id", { status: 400 });
  return parsed.data;
}
const revisionInput = z.strictObject({ revision: z.number().int().positive() });
const notFound = () => new Response("Not found", { status: 404 });

/** Read-only workflow histories other installed apps publish, for browsing beside a conversation. */
async function histories(host: WorkflowHost<"interactive">, cursor?: string) {
  const providers = (await host.call("threads.types", {})).filter(
    (type) => type.kind === "history" && type.operations.includes("list"),
  );
  const groups = [];
  for (const provider of providers.slice(0, 8)) {
    try {
      const page = await host.call("threads.list", {
        type: provider.type,
        installationId: provider.installationId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      groups.push({
        installationId: provider.installationId,
        type: provider.type,
        label: provider.label,
        threads: page.threads,
        cursor: page.cursor,
      });
    } catch (error) {
      // One unavailable provider does not hide the others; say so explicitly.
      groups.push({
        installationId: provider.installationId,
        type: provider.type,
        label: provider.label,
        threads: [],
        cursor: null,
        error:
          error instanceof Response
            ? `Unavailable (${error.status})`
            : "Unavailable",
      });
    }
  }
  return { providers: groups };
}

/**
 * Planning's browser API beside the platform thread routes: page context and
 * actions, the member's proposals, review decisions, deletion and workflow
 * history browsing. Conversations and messages use `/api/platform/threads`.
 */
export function agentRoute(
  request: Request,
  operation: string,
  locals: unknown,
) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one dispatcher over Planning's agent browser operations, each a short guarded branch.
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const host = workflowHost<"interactive">(locals as never);
    const identity = requestIdentity(request);
    const cacheKey = `${identity.owner.kind}:${identity.owner.id}:${identity.userId}:${identity.installationId}`;
    const discovery = () =>
      intakeAgent({
        identity,
        actor: requestActor(request, identity),
        originActor: requestOriginActor(request, identity),
        db: () => installationDatabase(),
        store: () => agentDatabase(),
        host: () => host,
      });
    // Route only the governed intake type to its app-action adapter. Project and transcript conversations retain their provider.
    const opParts = operation.split("/").filter(Boolean);
    if (
      opParts[0] === "context" &&
      new URL(request.url).searchParams.get("focus") === intakeAgentFocus
    )
      return discovery().browser(request, operation);
    if (opParts[0] === "proposals") {
      const id = opParts[1];
      if (id) {
        const row = await new (await import("./proposals")).ProposalStore(
          agentDatabase(),
          identity,
        ).get(agentId(id));
        if (row.action.startsWith("intake."))
          return discovery().browser(request, operation);
      } else {
        const thread = await host.call("threads.get", {
          ref: {
            id: agentId(new URL(request.url).searchParams.get("thread")),
          },
        });
        if (thread?.type === "planning.discovery-conversation")
          return discovery().browser(request, operation);
      }
    }
    const planning = planningConversations(
      agentDatabase(),
      requestIdentity(request),
      memberSnapshot(request),
      host,
    );
    const url = new URL(request.url);
    const parts = operation.split("/").filter(Boolean);
    const body = ["GET", "DELETE"].includes(request.method)
      ? undefined
      : await readJSON(request, z.unknown(), 150000);
    try {
      if (
        request.method === "GET" &&
        parts[0] === "context" &&
        parts.length === 1
      ) {
        const focus = z
          .string()
          .min(1)
          .max(200)
          .parse(url.searchParams.get("focus"));
        if (focus === productsFocus.id)
          return { cacheKey, type: conversationType, context: { type: productsContext, id: productsFocus.id, label: productsFocus.label }, privateOnly: true, actions: [] };
        if (focus === intakeFocus.id)
          return {
            cacheKey,
            type: conversationType,
            context: {
              type: intakeContext,
              id: intakeFocus.id,
              label: intakeFocus.label,
            },
            actions: intakeActions,
          };
        return {
          cacheKey,
          type: conversationType,
          context: { type: projectContext, id: z.uuid().parse(focus) },
          actions,
        };
      }
      if (
        request.method === "GET" &&
        parts[0] === "proposals" &&
        parts.length === 1
      )
        return {
          proposals: await planning.proposals.forThread(
            z.uuid().parse(url.searchParams.get("thread")),
          ),
        };
      if (parts[0] === "proposals" && parts.length >= 2) {
        const id = z.uuid().parse(parts[1]);
        if (request.method === "PUT" && parts.length === 2) {
          const v = revisionInput.extend({ changes: z.unknown() }).parse(body);
          return planning.proposals.revise(id, v.revision, v.changes);
        }
        if (request.method === "POST" && parts.length === 3)
          return planning.proposals.decide(
            id,
            revisionInput.parse(body).revision,
            z.enum(["approve", "reject"]).parse(parts[2]),
          );
      }
      if (
        request.method === "GET" &&
        parts[0] === "history" &&
        parts.length === 1
      )
        return histories(host, url.searchParams.get("cursor") ?? undefined);
      if (
        request.method === "GET" &&
        parts[0] === "history" &&
        parts[1] === "entries" &&
        parts.length === 2
      ) {
        const ref = threadRef.parse(
          parseThreadRefKey(
            z.string().min(1).max(600).parse(url.searchParams.get("ref")),
          ),
        );
        if ("id" in ref)
          throw new Response("Not a workflow history", { status: 400 });
        const [thread, page] = await Promise.all([
          host.call("threads.get", { ref }),
          host.call("threads.entries", {
            ref,
            limit: 50,
            ...(url.searchParams.get("before")
              ? { before: url.searchParams.get("before")! }
              : {}),
          }),
        ]);
        if (!thread) throw new Response("History not found", { status: 404 });
        return { thread, ...page };
      }
      return notFound();
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new Response("Invalid agent input", { status: 400 });
      throw error;
    }
  });
}
