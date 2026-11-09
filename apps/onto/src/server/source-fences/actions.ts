import { defineAction } from "@ai-outfitter/app-sdk/actions";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import {
  defineSourceFenceInput,
  captureSourceFenceInput,
  sourceFenceInput,
  sourceFenceStatusInput,
  sourceFenceProof,
  sourceFenceResult,
} from "@ai-outfitter/onto/contracts";
import { z } from "zod";
import type { SourceDatabase } from "./service";
import {
  defineSource,
  captureSource,
  fenceSource,
  fenceStatus,
} from "./service";

/** Source-local protocol actions, always under the dispatched installation identity. */
export function createSourceFenceActions(context: {
  db: () => AgentDatabase;
  graph: () => SourceDatabase;
}) {
  const forIdentity = (
    identity: Parameters<typeof defineSource>[0]["identity"],
  ) => ({ db: context.db(), graph: context.graph(), identity });
  return {
    "source.define": defineAction({
      description:
        "Review an immutable type-membership or direct-neighborhood source definition as owner/admin.",
      access: "write",
      input: defineSourceFenceInput,
      output: z.json(),
      run: ({ identity }, input) =>
        defineSource(
          forIdentity(identity),
          input.provider,
          input.id,
          input.version,
          input.definition,
        ),
    }),
    "source.capture": defineAction({
      description:
        "Issue a server-authored bounded membership proof for an existing immutable local subject. Not arbitrary GraphQL capture.",
      access: "write",
      input: captureSourceFenceInput,
      output: sourceFenceProof,
      run: ({ identity }, input) =>
        captureSource(
          forIdentity(identity),
          input.provider,
          input.definitionId,
          input.definitionVersion,
          input.requestKey,
          input.subject,
        ),
    }),
    "source.fence": defineAction({
      description:
        "Atomically fence the stored source proof and create an immutable source seal, with a durable idempotent pending receipt.",
      access: "write",
      input: sourceFenceInput,
      output: sourceFenceResult,
      run: ({ identity }, input) =>
        fenceSource(
          forIdentity(identity),
          input.provider,
          input.proofId,
          input.subject,
          input.idempotencyKey,
        ),
    }),
    "source.fence-status": defineAction({
      description:
        "Reconcile an existing source-local fence receipt under current editor authority.",
      access: "write",
      input: sourceFenceStatusInput,
      output: sourceFenceResult,
      run: ({ identity }, input) =>
        fenceStatus(
          forIdentity(identity),
          input.provider,
          input.idempotencyKey,
        ),
    }),
  };
}
