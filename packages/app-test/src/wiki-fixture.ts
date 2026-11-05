import type { EntityRef } from "@ai-outfitter/app-sdk/entities";
type FixtureRecord = { ref: { id: string }; revision?: number; title?: string; attributes: Record<string, unknown>; references?: EntityRef[] };

/** Serialize synthetic entity fixtures into the Wiki graph.read wire format. */
export function wikiGraphFixture(
  installationId: string,
  graph: { types?: FixtureRecord[]; nodes?: FixtureRecord[]; edges?: FixtureRecord[] },
) {
  const rows = (records: NonNullable<typeof graph.types> = []) => records.map(record => ({
    ...record.attributes, id: record.ref.id, revision: record.revision ?? 1,
    title: record.title ?? String(record.attributes.title ?? ""),
    ...(record.references?.[0] ? { source: record.references[0] } : {}),
  }));
  return { version: 1, installationId, types: rows(graph.types), nodes: rows(graph.nodes), edges: rows(graph.edges), selection: null, truncated: false, missingTypes: [] };
}

export async function wikiFixtureResult(response: Response) {
  return response.ok
    ? { ok: true as const, value: await response.json() }
    : { ok: false as const, status: response.status, message: await response.text() };
}

/** Route synthetic host reads/writes through the real Wiki Worker contract. */
export async function wikiFixtureCall(
  wiki: Awaited<ReturnType<typeof import("./worker").appWorker>>,
  owner: NonNullable<Parameters<typeof wiki.call>[1]>,
  operation: string,
  raw: unknown,
  hostname = "wiki.example.localhost",
) {
  const { installationId, ...input } = raw as Record<string, unknown>;
  if (operation !== "entities.types" && installationId !== wiki.installationId)
    return { ok: false as const, status: 403, message: "Outside owner scope" };
  if (operation === "actions.call") return wikiFixtureResult(await wiki.call(
    "/api/internal/actions/v1/call", owner, { method: "POST", body: { action: input.action, input: input.input, ...(input.readOnly ? { access: "read" } : {}) } },
  ));
  const name = operation.replace("entities.", "");
  const result = await wikiFixtureResult(await wiki.call(`/api/internal/entities/v1/${name}`, owner,
    name === "types" ? {} : { method: "POST", body: input }));
  if (!result.ok || name !== "types") return result;
  return { ok: true as const, value: (result.value as object[]).map(type => ({ ...type, installationId: wiki.installationId, hostname })) };
}
