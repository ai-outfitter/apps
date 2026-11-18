import { z } from "zod";
import { entityRef } from "./entities";
import {
  graphGraphqlInput,
  graphGraphqlResult,
  type GraphGraphqlInput,
} from "./graph-protocol";
import type { WorkflowHost } from "./workflow-host";

export const graphDescribeAction = "graph.describe";
const contract = z.strictObject({
  id: z.string().min(1).max(200),
  version: z.number().int().positive(),
});
/** An address is not authority. Qualifying a local reference requires the host's deployment identity. */
export const graphReference = entityRef.extend({
  deploymentId: z.string().min(1).max(200),
});
export type GraphReference = z.infer<typeof graphReference>;
export const qualifyGraphReference = (
  deploymentId: string,
  ref: z.infer<typeof entityRef>,
) => graphReference.parse({ ...ref, deploymentId });

/** Providers describe their own schema; they need not implement Onto's ontology. */
export const graphProviderDescriptor = z.strictObject({
  version: z.literal(1),
  contracts: z.array(contract).min(1).max(32),
  capabilities: z.array(z.string().min(1).max(100)).min(1).max(64),
  types: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(200),
        kind: z.enum(["record", "relationship"]),
      }),
    )
    .max(2000),
  queryAction: z.literal("graph.graphql"),
});
export type GraphProvider = z.infer<typeof graphProviderDescriptor> & {
  installationId: string;
};
type Host = Pick<WorkflowHost<"interactive">, "call">;
export type GraphRequirement = {
  contract: { id: string; version: number };
  capabilities?: string[];
};
export const compatibleGraphProvider = (
  provider: GraphProvider,
  required: GraphRequirement,
) =>
  provider.contracts.some(
    (item) =>
      item.id === required.contract.id &&
      item.version === required.contract.version,
  ) &&
  (required.capabilities ?? []).every((capability) =>
    provider.capabilities.includes(capability),
  );

/**
 * Discovery stays within the host's ordinary owner/actor authorization. No cross-request cache.
 * A `template` narrows the host's listing to installations of that package, so
 * only those are asked to describe themselves; it is a lookup hint and grants
 * nothing. Callers that cannot name a package omit it and every provider is asked.
 */
export async function discoverGraphProviders(
  host: Host,
  binding?: { installationId?: string; template?: string },
) {
  const selected =
    binding &&
    z
      .strictObject({
        installationId: z.string().min(1).max(200).optional(),
        template: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(128)
          .optional(),
      })
      .parse(binding);
  const installations = await host.call("actions.list", {
    ...(selected?.installationId
      ? { installationId: selected.installationId }
      : {}),
    ...(selected?.template ? { template: selected.template } : {}),
  });
  const candidates = installations.filter(
    (item) =>
      (!selected?.installationId ||
        item.installationId === selected.installationId) &&
      item.actions.some(
        (action) =>
          action.name === graphDescribeAction &&
          action.access === "read" &&
          action.permitted,
      ),
  );
  if (candidates.length > 32)
    throw new Response("Bind a graph provider to narrow discovery", {
      status: 413,
    });
  return Promise.all(
    candidates.map(async ({ installationId }): Promise<GraphProvider> => ({
      ...graphProviderDescriptor.parse(
        await host.call("actions.call", {
          installationId,
          action: graphDescribeAction,
          input: {},
          readOnly: true,
        }),
      ),
      installationId,
    })),
  );
}

/** A binding is explicit when multiple compatible providers exist. Discovery grants no access. */
export async function resolveGraphProvider(
  host: Host,
  required: GraphRequirement,
  binding?: { installationId: string },
) {
  const candidates = (await discoverGraphProviders(host, binding)).filter(
    (provider) => compatibleGraphProvider(provider, required),
  );
  if (candidates.length !== 1)
    throw new Response(
      candidates.length
        ? "Choose an explicit graph provider binding"
        : "No compatible graph provider is available",
      { status: 409 },
    );
  return candidates[0];
}

export type GraphRead = {
  provider: string;
  observedAt: string;
  state: "complete" | "partial" | "unavailable" | "unauthorized";
  result: z.infer<typeof graphGraphqlResult> | null;
  reason?: string;
};

/** Re-enter normal scoped dispatch on every read. Pagination remains in the provider's schema. */
export async function readGraphProvider(
  host: Host,
  provider: GraphProvider,
  raw: GraphGraphqlInput,
): Promise<GraphRead> {
  const input = graphGraphqlInput.parse(raw);
  const base = {
    provider: provider.installationId,
    observedAt: new Date().toISOString(),
  };
  try {
    const result = graphGraphqlResult.parse(
      await host.call("actions.call", {
        installationId: provider.installationId,
        action: provider.queryAction,
        input,
        readOnly: true,
        maxResponseBytes: input.maxBytes + 8192,
      }),
    );
    if (
      new TextEncoder().encode(JSON.stringify(result)).length > input.maxBytes
    )
      throw new Response("Graph provider exceeded its response budget", {
        status: 502,
      });
    if (
      result.errors?.some(
        (error) =>
          error.extensions?.status === 401 || error.extensions?.status === 403,
      )
    )
      return {
        ...base,
        state: "unauthorized",
        result: null,
        reason: "Source access was refused",
      };
    // A source may finish after membership or installation access is revoked.
    // Re-enter the host immediately before releasing its returned data.
    const current = await host.call("actions.list", {
      installationId: provider.installationId,
    });
    const permitted = current.some(
      (installation) =>
        installation.installationId === provider.installationId &&
        installation.actions.some(
          (action) =>
            action.name === provider.queryAction &&
            action.access === "read" &&
            action.permitted,
        ),
    );
    if (!permitted)
      return {
        ...base,
        state: "unauthorized",
        result: null,
        reason: "Source access was revoked before the result was returned",
      };
    return {
      ...base,
      result,
      state:
        result.errors?.length || result.extensions?.truncated === true
          ? "partial"
          : "complete",
    };
  } catch (error) {
    if (error instanceof z.ZodError)
      return {
        ...base,
        state: "unavailable",
        result: null,
        reason: "Graph provider returned an invalid response",
      };
    if (!(error instanceof Response)) throw error;
    if (error.status === 401 || error.status === 403)
      return {
        ...base,
        state: "unauthorized",
        result: null,
        reason: "Source access was refused",
      };
    if (error.status === 404 || error.status >= 500)
      return {
        ...base,
        state: "unavailable",
        result: null,
        reason: `Graph provider unavailable (${error.status})`,
      };
    throw error;
  }
}

/** Prove a source capture is complete from provider-owned pagination metadata.
 * Raw record arrays need an explicit provider completeness envelope, or a caller's
 * declared bounded selection. Scalar arrays carry no pagination assumption.
 * Neither declaration overrides a truncated result or an unfinished connection. */
export function graphSourceCompleteness(
  result: z.infer<typeof graphGraphqlResult> | null,
  options: { boundedSelection?: boolean } = {},
): { complete: boolean; reason?: string } {
  if (!result || result.data === null || result.errors?.length)
    return {
      complete: false,
      reason: "Graph result unavailable or contains errors",
    };
  const declared =
    result.extensions?.complete === true || options.boundedSelection === true;
  function inspect(
    value: unknown,
    path: string,
    connectionNodes = false,
  ): string | undefined {
    if (Array.isArray(value)) {
      if (
        !connectionNodes &&
        !declared &&
        value.some(
          (item) =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        )
      )
        return `${path}: record array has no completeness declaration`;
      for (let index = 0; index < value.length; index++) {
        const error = inspect(value[index], `${path}[${index}]`);
        if (error) return error;
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (
      object.truncated === true ||
      object.complete === false ||
      object.hasNextPage === true
    )
      return `${path}: source is partial`;
    if (Array.isArray(object.nodes)) {
      const page = object.pageInfo;
      if (
        !page ||
        typeof page !== "object" ||
        Array.isArray(page) ||
        typeof (page as Record<string, unknown>).hasNextPage !== "boolean"
      )
        return `${path}: connection requires pageInfo.hasNextPage`;
      if ((page as Record<string, unknown>).hasNextPage !== false)
        return `${path}: connection has another page`;
    }
    for (const [key, item] of Object.entries(object)) {
      const error = inspect(
        item,
        `${path}.${key}`,
        key === "nodes" && Array.isArray(object.nodes),
      );
      if (error) return error;
    }
  }
  const reason =
    inspect(result.extensions, "extensions") ?? inspect(result.data, "data");
  return reason ? { complete: false, reason } : { complete: true };
}
