import {
  defineAction,
  type ActionContext,
} from "@ai-outfitter/app-sdk/actions";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import { documentPolicyBinding, documentPolicyResult, documentPolicySubjectResult } from "@ai-outfitter/app-sdk/document-policy";
import { graphGraphqlInput } from "@ai-outfitter/app-sdk/graph-protocol";
import {
  readGraphProvider,
  resolveGraphProvider,
  graphSourceCompleteness,
} from "@ai-outfitter/app-sdk/graph-provider";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { documentDefinition } from "@ai-outfitter/onto/contracts";
import {
  githubSourceBinding,
  githubSourceProvider,
  readGithubBinding,
} from "../sources/github";
import {
  createDocument,
  enqueue,
  evaluatePolicy,
  policySubject,
  getJob,
  getRevision,
  putDefinition,
  readLive,
  requeueJob,
  seal,
  type Capture,
  type Definition,
  type Host,
  type PolicyResult,
  type Scope,
} from "./service";

const id = z.string().min(1).max(128);
const graphConfig = graphGraphqlInput;
const source = z.union([
  githubSourceBinding,
  z.strictObject({
    provider: id.refine((value) => value !== githubSourceProvider),
    config: graphConfig,
  }),
]);
// Providers own config semantics; this app validates the adapters it supports.
const definition = documentDefinition.extend({
  sources: z.array(source).min(1).max(8),
});
const doc = z.strictObject({ id });
const revisionInput = doc.extend({ revision: z.number().int().positive() });
const scopeOf = (identity: AppIdentity): Scope => ({
  owner: `${identity.owner.kind}:${identity.owner.id}`,
  identity: { owner: identity.owner, installationId: identity.installationId },
});
const admin = ({ identity }: ActionContext) =>
  identity.canEdit &&
  identity.role
    .split(",")
    .some((role) => ["owner", "admin"].includes(role.trim()));
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

/** Every source read re-enters host authorization and verifies the provider contract. */
export function documentHost(
  host: WorkflowHost<"interactive"> | WorkflowHost<"schedule">,
  phase: "interactive" | "schedule" = "interactive",
): Host {
  // Both phases support actions.list/actions.call; discovery does not grant authority.
  const graphHost = host as WorkflowHost<"interactive">;
  const read: Host["read"] = async (binding) => {
    if (binding.provider === githubSourceProvider) {
      if (phase !== "interactive")
        throw new Response(
          "GitHub repository source requires an interactive member host",
          { status: 503 },
        );
      return readGithubBinding(graphHost, binding);
    }
    const input = graphConfig.parse(JSON.parse(binding.config));
    const provider = await resolveGraphProvider(
      graphHost,
      {
        contract: { id: "outfitter.graph", version: 1 },
        capabilities: ["graphql.read"],
      },
      { installationId: binding.provider },
    );
    const result = await readGraphProvider(graphHost, provider, input);
    const proof = graphSourceCompleteness(result.result);
    const complete = result.state === "complete" && proof.complete;
    return {
      complete,
      errors: complete
        ? []
        : [
            `${binding.provider}: ${result.state === "complete" ? (proof.reason ?? "pagination incomplete") : result.state}`,
          ],
      provenance: { provider: binding.provider, query: input },
      snapshot: result.result,
    };
  };
  return {
    read,
    verifyCapture: async (capture: Capture) => {
      if (!capture.complete || capture.errors.length) return false;
      try {
        for (const entry of capture.sources) {
          const current = await read(entry);
          if (
            !current.complete ||
            stable(current.provenance) !== stable(entry.provenance) ||
            stable(current.snapshot) !== stable(entry.snapshot)
          )
            return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    policy: async (binding) => {
      const result = await graphHost.call("actions.call", {
        installationId: binding.provider,
        action: "document.policy",
        input: binding,
        readOnly: true,
      });
      return documentPolicyResult.parse(result) as PolicyResult;
    },
    deliver: async (event) =>
      graphHost.call("actions.call", {
        installationId: event.binding.provider,
        action: "document.event",
        input: event,
      }),
  };
}

/** Supply the request's trusted workflow host; never accept a host, owner or capture in action input. */
export function createDocumentActions(context: {
  db: () => AgentDatabase;
  host: () => WorkflowHost<"interactive">;
}) {
  const host = () => documentHost(context.host());
  return {
    "document.define": defineAction({
      description:
        "Create an immutable document definition version and its trusted provider bindings; organization owner or admin only.",
      access: "write",
      canInvoke: admin,
      input: z.strictObject({
        id,
        version: z.number().int().positive(),
        definition,
      }),
      output: z.json(),
      run: async ({ identity }, input) => {
        const d: Definition = {
          ...input.definition,
          sources: input.definition.sources.map((s) => ({
            provider: s.provider,
            config: stable(s.config),
          })),
        };
        await putDefinition(
          context.db(),
          scopeOf(identity),
          input.id,
          input.version,
          d,
        );
        return { saved: true };
      },
    }),
    "document.create": defineAction({
      description: "Create a document from an owned versioned definition.",
      access: "write",
      input: z.strictObject({
        id,
        definitionId: id,
        version: z.number().int().positive(),
      }),
      output: z.json(),
      run: async ({ identity }, i) => {
        await createDocument(
          context.db(),
          scopeOf(identity),
          i.id,
          i.definitionId,
          i.version,
        );
        return { created: true };
      },
    }),
    "document.live": defineAction({
      description:
        "Read live authorized graph sources, with completeness and provenance; this does not generate a revision.",
      access: "read",
      input: doc,
      output: z.json(),
      run: ({ identity }, i) =>
        readLive(context.db(), scopeOf(identity), i.id, host()),
    }),
    "document.generate": defineAction({
      description:
        "Queue durable generation and request an authorized background task; generation never runs in this request.",
      access: "write",
      input: doc.extend({ jobId: id }),
      output: z.json(),
      run: async ({ identity }, i) => {
        await enqueue(context.db(), scopeOf(identity), i.id, i.jobId);
        try {
          const run = await context.host().call("task.start", {
            task: "document-generation",
            id: crypto.randomUUID(),
            inputs: { jobId: i.jobId },
          });
          return { queued: true, jobId: i.jobId, runId: run.id };
        } catch {
          return {
            queued: true,
            jobId: i.jobId,
            dispatch: "pending",
            message:
              "Generation is queued; an authorized schedule or retry can process it.",
          };
        }
      },
    }),
    "document.revision": defineAction({
      description:
        "Read an immutable generated revision and its captured evidence.",
      access: "read",
      input: revisionInput,
      output: z.json(),
      run: ({ identity }, i) =>
        getRevision(context.db(), scopeOf(identity), i.id, i.revision),
    }),
    "document.job": defineAction({
      description:
        "Read generation status, attempts, failures and supersession.",
      access: "read",
      input: doc,
      output: z.json(),
      run: ({ identity }, i) => getJob(context.db(), scopeOf(identity), i.id),
    }),
    "document.retry": defineAction({
      description:
        "Retry a failed current generation job; owner or admin only.",
      access: "write",
      canInvoke: admin,
      input: doc,
      output: z.json(),
      run: async ({ identity }, i) => {
        await requeueJob(context.db(), scopeOf(identity), i.id);
        try {
          const run = await context.host().call("task.start", {
            task: "document-generation",
            id: crypto.randomUUID(),
            inputs: { jobId: i.id },
          });
          return { queued: true, jobId: i.id, runId: run.id };
        } catch {
          return {
            queued: true,
            jobId: i.id,
            dispatch: "pending",
            message:
              "Generation is queued; invoke generation again to dispatch an authorized task.",
          };
        }
      },
    }),
    "document.seal": defineAction({
      description:
        "Seal the current exact revision after verifying captured sources. A seal is not approval.",
      access: "write",
      input: revisionInput.extend({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      output: z.json(),
      run: ({ identity }, i) =>
        seal(
          context.db(),
          scopeOf(identity),
          i.id,
          i.revision,
          i.digest,
          host(),
          Date.now(),
        ),
    }),
    "document.policy-subject": defineAction({
      description:
        "Read current policy subject metadata for the exact configured document revision; grants no approval.",
      access: "read",
      input: documentPolicyBinding,
      output: documentPolicySubjectResult,
      run: ({ identity }, binding) =>
        policySubject(context.db(), scopeOf(identity), binding),
    }),
    "document.policy": defineAction({
      description:
        "Evaluate a configured cross-app policy for the exact current revision. Unavailable and require-review are not approval.",
      access: "read",
      input: revisionInput.extend({ action: id }),
      output: z.json(),
      run: ({ identity }, i) =>
        evaluatePolicy(
          context.db(),
          scopeOf(identity),
          i.id,
          i.revision,
          i.action,
          host(),
        ),
    }),
  };
}
export { scopeOf };
