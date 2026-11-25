import { AssemblyReferenceSchema } from "./assembly";

export function assemblySelection(projectId: string | undefined, query: URLSearchParams) {
  let parameters: unknown;
  try {
    if (query.has("parameters")) parameters = JSON.parse(query.get("parameters")!);
  } catch {
    throw new Response("Invalid configuration parameters", { status: 400 });
  }
  const ref = AssemblyReferenceSchema.safeParse({
    projectId, parameters, configuration: query.get("configuration") ?? undefined,
    revision: query.has("revision") ? Number(query.get("revision")) : undefined,
  });
  if (!ref.success) throw new Response("Invalid assembly selection", { status: 400 });
  return ref.data;
}
