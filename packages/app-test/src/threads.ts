import { threadOperations } from "@ai-outfitter/app-sdk/threads";
import type { WorkflowHostResult, WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import { appInstallations, organization, user } from "@ai-outfitter/server/schema";
import { createThreadService, threadBrowserRequest, type ThreadAdapters, type ThreadPrincipal } from "@ai-outfitter/threads";
import { threadRoutesBase } from "@ai-outfitter/app-sdk/threads";
import * as threadSchema from "@ai-outfitter/threads/schema";
import { createClient } from "@libsql/client";
import type { LanguageModel } from "ai";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/libsql";

/**
 * The real platform thread service on an in-memory libSQL database, for app
 * tests: apps exercise `threads.*` host operations and their own provider
 * callbacks (`/api/internal/threads/v1/<op>`) against the actual privacy,
 * idempotency, lease and deletion rules. Inference, accounting and object
 * storage are fakes; a passing test proves no live provider.
 */
export type ThreadTestPrincipal = Pick<ThreadPrincipal, "userId" | "organizationId" | "installationId"> & Partial<ThreadPrincipal>;
export type ThreadTestProvider = (call: { installationId: string; operation: string; input: unknown; principal: ThreadPrincipal }) => Promise<unknown>;

export async function threadTestHost(options: {
  /** The model each reply uses (e.g. `MockLanguageModelV3` from `ai/test`). */
  model: () => LanguageModel;
  /** Provider callbacks; route them to a built app Worker with {@link workerProvider}. */
  provider: ThreadTestProvider;
  /** Installations that publish thread types (same owner as the caller). */
  installations: string[];
  users?: string[];
  organizations?: string[];
  /** The platform's own tools, offered when prepare asks for `platformTools` (as the platform adds its MCP tools). */
  platformTools?: ThreadAdapters["platformTools"];
  /** Platform administrators, who may open the sidebar's debug view. */
  admins?: string[];
}) {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  const schema = { user, organization, appInstallations, ...threadSchema };
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema));
  for (const statement of statements) await client.execute(statement);
  const at = Date.now();
  const users = options.users ?? ["owner", "member"], organizations = options.organizations ?? ["org"];
  for (const id of users)
    await client.execute({ sql: "INSERT INTO user(id,name,email,emailVerified,adminCreated,profile,createdAt,updatedAt) VALUES(?,?,?,0,0,'{}',?,?)", args: [id, id, `${id}@example.test`, at, at] });
  for (const id of organizations)
    await client.execute({ sql: "INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)", args: [id, id, id, at] });
  for (const id of options.installations)
    await client.execute({ sql: "INSERT INTO app_installations(id,organizationId,template,capabilities,workflowPackages,storageBuckets,createdAt) VALUES(?,?,?,'[]','[]','{}',?)", args: [id, organizations[0], id, at] });
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const retained: Promise<unknown>[] = [];
  const adapters: ThreadAdapters = {
    db: drizzle(client, { schema }) as never,
    objects: {
      async put(key, bytes, type) { objects.set(key, { bytes, type }); },
      async get(key) { const found = objects.get(key); return found ? new Blob([found.bytes.slice()], { type: found.type }) : null; },
      async delete(keys) { for (const key of keys) objects.delete(key); },
      async presignGet(key) { return `https://objects.test/${key}`; },
    },
    inference: { resolve: async () => ({ model: options.model(), effort: false, describe: { provider: "Fixture provider", model: "fixture-model" } }) },
    accounting: { start: async () => ({ observe() {}, settle: async () => {} }) },
    providers: {
      installations: async () => options.installations,
      call: (principal, installationId, operation, input) => options.provider({ installationId, operation, input, principal }),
    },
    retain: (work) => { retained.push(work); },
    ...(options.platformTools ? { platformTools: options.platformTools } : {}),
    inspector: async (principal) => principal.memberContext && (options.admins ?? []).includes(principal.userId),
  };
  const service = createThreadService(adapters);
  const principalOf = (who: ThreadTestPrincipal): ThreadPrincipal => ({
    memberContext: true, canAdminister: false,
    actor: { kind: "app", id: who.installationId ?? "app" }, origin: { kind: "member", id: who.userId }, ...who,
  });
  /** A `WorkflowHostStub` answering `threads.*` for one principal, validated like the platform host. */
  function stub(who: ThreadTestPrincipal): WorkflowHostStub {
    const principal = principalOf(who);
    return {
      async call(operation: string, raw: unknown): Promise<WorkflowHostResult> {
        if (!Object.hasOwn(threadOperations, operation)) return { ok: false, status: 400, message: "Unknown thread operation" };
        const parsed = threadOperations[operation as keyof typeof threadOperations].input.safeParse(raw);
        if (!parsed.success) return { ok: false, status: 400, message: "Invalid workflow host input" };
        const input = parsed.data as Record<string, unknown>;
        try {
          const value = await ({
            "threads.types": () => service.types(principal),
            "threads.list": () => service.list(principal, input),
            "threads.get": () => service.get(principal, input.ref as never),
            "threads.entries": () => service.entries(principal, input),
            "threads.create": () => service.create(principal, input),
            "threads.update": () => service.update(principal, input),
            "threads.append": () => service.append(principal, input),
            "threads.send": async () => (await service.send(principal, input)).state,
            "threads.submission": () => service.submission(principal, String(input.threadId), String(input.submissionId)),
            "threads.cancel": () => service.cancel(principal, String(input.threadId), input.submissionId as string | undefined),
            "threads.delete": () => service.remove(principal, String(input.threadId)),
          } as Record<string, () => Promise<unknown>>)[operation]();
          return { ok: true, value: structuredClone(value) };
        } catch (error) {
          if (error instanceof Response) return { ok: false, status: error.status, message: (await error.text()).slice(0, 1024) };
          throw error;
        }
      },
    };
  }
  /** The platform's real browser API for one member: route `<mount>/api/platform/threads/**` page requests to it. */
  function browser(who: ThreadTestPrincipal) {
    const principal = principalOf({ actor: { kind: "member", id: who.userId }, ...who });
    return (request: Request) => {
      const { pathname } = new URL(request.url);
      const at = pathname.indexOf(threadRoutesBase);
      if (at < 0) return Promise.resolve(new Response("Not found", { status: 404 }));
      return threadBrowserRequest(service, principal, request, pathname.slice(at + threadRoutesBase.length));
    };
  }
  return {
    service, stub, browser, principal: principalOf, objects, client,
    /** Wait for background replies and cleanup started so far. */
    settle: () => Promise.all(retained.splice(0)),
  };
}

/** Provider callbacks served by an app's own handler or built Worker: POSTs
 * `/api/internal/threads/v1/<op>` with forwarded identity headers. */
export function workerProvider(fetcher: (request: Request) => Promise<Response>, options: { origin?: string; role?: string } = {}): ThreadTestProvider {
  return async ({ installationId, operation, input, principal }) => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-outfitter-user": principal.userId,
      "x-outfitter-installation": installationId,
      "x-outfitter-role": options.role ?? "member",
      ...(principal.organizationId ? { "x-outfitter-organization": principal.organizationId, "x-outfitter-owner": `organization:${principal.organizationId}` } : { "x-outfitter-owner": `user:${principal.userId}` }),
    });
    const response = await fetcher(new Request(`${options.origin ?? "https://app.example"}/api/internal/threads/v1/${operation}`, { method: "POST", headers, body: JSON.stringify(input) }));
    const text = await response.text();
    if (!response.ok) throw new Response(text, { status: response.status });
    return text ? JSON.parse(text) : null;
  };
}
