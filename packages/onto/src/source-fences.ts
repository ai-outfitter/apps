import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { resolveGraphProvider } from "@ai-outfitter/app-sdk/graph-provider";
import { z } from "zod";
import {
  ontoSourceFenceContract,
  ontoSourceFenceCapability,
  captureSourceFenceInput,
  defineSourceFenceInput,
  sourceFenceInput,
  sourceFenceStatusInput,
  sourceFenceProof,
  sourceFenceResult,
} from "./source-fence-contracts";
export * from "./source-fence-contracts";
/** No default provider: each source receipt belongs to one explicitly bound installation. */
export async function resolveOntoSourceFence(
  host: WorkflowHost<"interactive">,
  binding: { installationId: string },
) {
  const bound = z
    .strictObject({ installationId: z.string().min(1).max(128) })
    .parse(binding);
  const provider = await resolveGraphProvider(
    host,
    {
      contract: ontoSourceFenceContract,
      capabilities: [ontoSourceFenceCapability],
    },
    bound,
  );
  if (provider.installationId !== bound.installationId)
    throw new Response("Source provider returned a different installation", {
      status: 409,
    });
  const target = {
    installationId: provider.installationId,
    contract: ontoSourceFenceContract.id,
    version: 1 as const,
  };
  const call = async (action: string, input: unknown) =>
    host.call("actions.call", {
      installationId: provider.installationId,
      action,
      input: z.json().parse(input),
    });
  return {
    provider: target,
    define: (input: Omit<z.input<typeof defineSourceFenceInput>, "provider">) =>
      call(
        "source.define",
        defineSourceFenceInput.parse({ ...input, provider: target }),
      ),
    capture: async (
      input: Omit<z.input<typeof captureSourceFenceInput>, "provider">,
    ) => {
      const request = captureSourceFenceInput.parse({
        ...input,
        provider: target,
      });
      if (request.subject.installationId !== target.installationId)
        throw new Response("Source subject belongs to another installation", {
          status: 409,
        });
      const proof = sourceFenceProof.parse(
        await call("source.capture", request),
      );
      if (
        proof.provider.installationId !== target.installationId ||
        proof.selection.definitionId !== request.definitionId ||
        proof.selection.definitionVersion !== request.definitionVersion ||
        Object.keys(request.subject).some(
          (key) =>
            proof.subject[key as keyof typeof proof.subject] !==
            request.subject[key as keyof typeof request.subject],
        )
      )
        throw new Response("Source proof differs from the requested capture", {
          status: 409,
        });
      return proof;
    },
    fence: async (
      input: Omit<z.input<typeof sourceFenceInput>, "provider">,
    ) => {
      const request = sourceFenceInput.parse({ ...input, provider: target });
      if (request.subject.installationId !== target.installationId)
        throw new Response("Source subject belongs to another installation", {
          status: 409,
        });
      const result = sourceFenceResult.parse(
        await call("source.fence", request),
      );
      if (
        result.status === "sealed" &&
        (result.proofId !== request.proofId ||
          result.sourceSeal.installationId !== target.installationId)
      )
        throw new Response("Source seal differs from the requested fence", {
          status: 409,
        });
      return result;
    },
    status: async (
      input: Omit<z.input<typeof sourceFenceStatusInput>, "provider">,
    ) => {
      const result = sourceFenceResult.parse(
        await call(
          "source.fence-status",
          sourceFenceStatusInput.parse({ ...input, provider: target }),
        ),
      );
      if (
        result.status === "sealed" &&
        result.sourceSeal.installationId !== target.installationId
      )
        throw new Response("Source seal belongs to another installation", {
          status: 409,
        });
      return result;
    },
  };
}
