import { appInstallations, organization, user } from "@ai-outfitter/server/schema";
import { createClient } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/libsql";
import * as threadSchema from "../../src/schema";
import { createThreadService } from "../../src/service";
import type { ThreadAdapters, ThreadDatabase, ThreadPrincipal } from "../../src/types";

/** A fresh in-memory SQLite database with the thread tables and the identity tables they reference. */
export async function threadDatabase() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  const schema = { user, organization, appInstallations, ...threadSchema };
  const empty = await generateSQLiteDrizzleJson({});
  const statements = await generateSQLiteMigration(empty, await generateSQLiteDrizzleJson(schema));
  for (const statement of statements) await client.execute(statement);
  const db = drizzle(client, { schema });
  const at = Date.now();
  for (const id of ["alice", "bob", "carol"])
    await client.execute({ sql: "INSERT INTO user(id,name,email,emailVerified,adminCreated,profile,createdAt,updatedAt) VALUES(?,?,?,0,0,'{}',?,?)", args: [id, id, `${id}@example.test`, at, at] });
  for (const id of ["acme", "other"])
    await client.execute({ sql: "INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)", args: [id, id, id, at] });
  for (const id of ["chat-app", "flow-app", "planning", "another-app"])
    await client.execute({ sql: "INSERT INTO app_installations(id,organizationId,template,capabilities,workflowPackages,storageBuckets,createdAt) VALUES(?,?,?,'[]','[]','{}',?)", args: [id, "acme", id, at] });
  return { client, db: db as unknown as ThreadDatabase };
}

export function memoryObjects() {
  const store = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    store,
    async put(key: string, bytes: Uint8Array, type: string) { store.set(key, { bytes, type }); },
    async get(key: string) { const found = store.get(key); return found ? new Blob([found.bytes.slice()], { type: found.type }) : null; },
    async delete(keys: string[]) { for (const key of keys) store.delete(key); },
    async presignGet(key: string) { return `https://objects.test/${key}?signed=1`; },
  };
}

export const member = (userId: string, organizationId: string | null, extra: Partial<ThreadPrincipal> = {}): ThreadPrincipal => ({
  userId, organizationId, memberContext: true, canAdminister: false, installationId: "chat-app",
  actor: { kind: "member", id: userId }, origin: { kind: "member", id: userId }, ...extra,
});

export const conversationTypes = [
  { type: "chat.conversation", version: 1, label: "Chat", kind: "conversation" as const, operations: ["list", "get", "entries", "create", "append", "send", "cancel", "upload", "delete"] as const },
];

export type ProviderCall = { installationId: string; operation: string; input: unknown; principal: ThreadPrincipal };
/** A service with fake inference/accounting and a scripted provider. */
export function service(db: ThreadDatabase, options: {
  model: ThreadAdapters["inference"] extends { resolve(...a: never[]): Promise<infer R> } ? () => R : never;
  provider?: (call: ProviderCall) => Promise<unknown> | unknown;
  objects?: ReturnType<typeof memoryObjects>;
  installations?: string[];
  retained?: Promise<unknown>[];
  settled?: string[];
  types?: unknown[] | (() => unknown);
  platformTools?: ThreadAdapters["platformTools"];
  inspector?: ThreadAdapters["inspector"];
  platform?: ThreadAdapters["platform"];
}) {
  const calls: ProviderCall[] = [];
  const objects = options.objects ?? memoryObjects();
  const adapters: ThreadAdapters = {
    db, objects,
    inference: { resolve: async () => options.model() },
    accounting: { start: async () => ({ observe() {}, settle: async (outcome) => { options.settled?.push(outcome); } }) },
    providers: {
      installations: async () => options.installations ?? ["chat-app"],
      async call(principal, installationId, operation, input) {
        calls.push({ installationId, operation, input, principal });
        if (operation === "types") return typeof options.types === "function" ? options.types() : options.types ?? conversationTypes;
        const answer = await options.provider?.({ installationId, operation, input, principal });
        if (answer !== undefined) return answer;
        if (operation === "prepare") return { instructions: "Fixture app" };
        return { ok: true };
      },
    },
    retain: (work) => { options.retained?.push(work); },
    ...(options.platformTools ? { platformTools: options.platformTools } : {}),
    ...(options.inspector ? { inspector: options.inspector } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  };
  return { threads: createThreadService(adapters), calls, objects };
}
