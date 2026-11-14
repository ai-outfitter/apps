import { inspectBody, parseThreadRefKey, submissionBody } from "@ai-outfitter/app-sdk/threads";
import { z } from "zod";
import type { ThreadService } from "./service";
import type { ThreadPrincipal } from "./types";

/**
 * The browser API under `/api/platform/threads`, over the real service: the
 * platform's Astro route and app test hosts serve the same handler. `path` is
 * what follows the base (`""`, `"<id>"`, `"<id>/entries"`, ...). Answers
 * JSON, the reply's UI message stream, or an image; refusals are Responses.
 */
export async function threadBrowserRequest(service: ThreadService, principal: ThreadPrincipal, request: Request, path: string): Promise<Response> {
  try {
    const response = await route(service, principal, request, path.replace(/^\/+|\/+$/g, ""));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return new Response("Invalid input", { status: 400 });
    throw error;
  }
}

const notFound = () => new Response("Not found", { status: 404 });
async function body(request: Request, limit: number): Promise<unknown> {
  const text = await request.text();
  if (text.length > limit) throw new Response("Request too large", { status: 413 });
  try { return text ? JSON.parse(text) : {}; } catch { throw new Response("Invalid input", { status: 400 }); }
}

type Context = { service: ThreadService; principal: ThreadPrincipal; request: Request; query: URLSearchParams };
const json = (value: unknown) => Response.json(value ?? null);
const optional = (query: URLSearchParams, names: Record<string, string>) =>
  Object.fromEntries(Object.entries(names).flatMap(([param, field]) => (query.get(param) ? [[field, query.get(param)]] : [])));

async function collection({ service, principal, request, query }: Context) {
  if (request.method === "POST") return json(await service.create(principal, await body(request, 256 * 1024)));
  if (request.method !== "GET") return notFound();
  const context = query.get("context");
  const separator = context?.lastIndexOf(":") ?? -1;
  const types = query.getAll("type");
  if (query.has("view")) {
    if (query.get("view") !== "snapshot") throw new Response("Unknown thread view", { status: 400 });
    return json(await service.snapshot(principal, {
      type: query.get("type"),
      context: { type: context?.slice(0, separator), id: context?.slice(separator + 1) },
      ...optional(query, { preferred: "preferred" }),
      ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
    }));
  }

  return json(await service.list(principal, {
    ...(types.length === 1 ? { type: types[0] } : types.length ? { types } : {}),
    ...(context && separator > 0 ? { context: { type: context.slice(0, separator), id: context.slice(separator + 1) } } : {}),
    ...optional(query, { parent: "parentId", provider: "installationId", cursor: "cursor" }),
    ...(query.get("mine") ? { mine: true } : {}),
    ...(query.get("limit") ? { limit: Number(query.get("limit")) } : {}),
  }));
}

async function single({ service, principal, request }: Context, id: string) {
  if (request.method === "GET") {
    const ref = parseThreadRefKey(id);
    const thread = ref ? await service.get(principal, ref) : null;
    return thread ? json(thread) : notFound();
  }
  if (request.method === "PATCH") {
    const patch = z.record(z.string(), z.unknown()).parse(await body(request, 16 * 1024));
    return json(await service.update(principal, { ...patch, threadId: id }));
  }
  if (request.method === "DELETE") return json(await service.remove(principal, id));
  return notFound();
}

async function entries({ service, principal, query }: Context, id: string) {
  const ref = parseThreadRefKey(id);
  if (!ref) return notFound();
  return json(await service.entries(principal, {
    ref, ...optional(query, { before: "before", after: "after" }), ...(query.get("limit") ? { limit: Number(query.get("limit")) } : {}),
  }));
}

async function submissions({ service, principal, request }: Context, id: string, submissionId?: string) {
  if (!submissionId) {
    if (request.method !== "POST") return notFound();
    const input = submissionBody.parse(await body(request, 192 * 1024));
    const result = await service.send(principal, { ...input, threadId: id }, { stream: true, signal: request.signal });
    return result.response ?? json({ submission: result.state });
  }
  if (request.method === "GET") {
    const state = await service.submission(principal, id, submissionId);
    return state ? json(state) : notFound();
  }
  return request.method === "DELETE" ? json(await service.cancel(principal, id, submissionId)) : notFound();
}

function route(service: ThreadService, principal: ThreadPrincipal, request: Request, path: string): Promise<Response> {
  const parts = path ? path.split("/").map((part) => decodeURIComponent(part)) : [];
  const context: Context = { service, principal, request, query: new URL(request.url).searchParams };
  const [id, section, child] = parts;
  const get = request.method === "GET";
  if (!parts.length) return collection(context);
  // Administrators' debug view: `inspect` answers whether it is offered; `<id>/inspect` prepares the latest turn again, from the page the member is on now.
  if (id === "inspect" && parts.length === 1 && get) return service.inspector(principal).then((allowed) => (allowed ? json({ inspect: true }) : notFound()));
  if (section === "inspect" && parts.length === 2 && request.method === "POST")
    return body(request, 192 * 1024).then((input) => service.inspect(principal, id, inspectBody.parse(input))).then(json);
  if (parts.length === 1) return single(context, id);
  if (section === "entries" && parts.length === 2 && get) return entries(context, id);
  if (section === "submissions" && parts.length <= 3) return submissions(context, id, child);
  if (section === "uploads" && parts.length === 2 && request.method === "POST") return service.upload(principal, id, request).then(json);
  if (section === "attachments" && parts.length === 3 && get) return service.readAttachment(principal, id, child);
  return Promise.resolve(notFound());
}
