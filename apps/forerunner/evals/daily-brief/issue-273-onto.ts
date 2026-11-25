import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { parseAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import { oceanMorning, timezone, ontoBatches, ontoRevisions } from "./issue-273-fixtures";

const scope = { owner: { kind: "user", id: "fixture-member" }, userId: "fixture-member", installationId: "fixture-onto", canEdit: true, role: "owner" } as const;

/** Supply the production producer's Cloudflare binding with an isolated SQLite database. */
export async function collectOnto(confirmedEmpty: boolean, generate: (step: InferenceStep) => Promise<unknown>) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../../onto/migrations/", import.meta.url);
  try {
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    if (!confirmedEmpty) {
      const batch = db.prepare("insert into graph_batches (id,title,state,policy,openedBy,openedVia,createdAt,updatedAt,expiresAt) values (?,?,?,'{}','fixture','fixture',?,?,?)");
      for (const row of ontoBatches) batch.run(row.id, row.title, row.state, row.updatedAt - 86_400_000, row.updatedAt, row.updatedAt + 86_400_000);
      const revision = db.prepare("insert into graph_revisions (kind,recordId,revision,batchId,proposedBy,approval,snapshot,createdAt) values (?,?,?,?,'fixture','{}','{}',?)");
      for (const row of ontoRevisions) revision.run(row.kind, row.recordId, row.revision, row.batchId, row.createdAt);
    }

    const binding = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        const prepare = (parameters: SQLInputValue[]) => ({
          bind: (...values: SQLInputValue[]) => prepare(values),
          all: async () => ({ results: statement.all(...parameters) }),
          raw: async () => statement.all(...parameters).map(row => Object.values(row)),
        });
        return prepare([]);
      },
    };
    const globals = globalThis as typeof globalThis & { issue273Env?: { DB: typeof binding } };
    const hook = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === "cloudflare:workers") return { shortCircuit: true, url: "data:text/javascript,export const env = new Proxy({}, {get: (_, key) => globalThis.issue273Env?.[key]});" };
        return next(specifier, context);
      },
    });
    globals.issue273Env = { DB: binding };
    try {
      const { dailyUpdate } = await import("../../../onto/src/server/daily-update");
      const receipt: { writes: { slug: string; generatedBody: string }[]; phaseCalls: string[]; prompt?: InferenceStep } = { writes: [], phaseCalls: [] };
      const host = { call: async (op: string, args: any) => {
        receipt.phaseCalls.push(op);
        switch (op) {
          case "schedules": return [{ id: "onto-schedule", timezone }];
          case "workflow.start":
          case "workflow.collect": return {};
          case "inference.generate":
            receipt.prompt = args;
            return { output: await generate(args) };
          case "actions.call":
            if (args.input.query.includes("SavedPages")) return { data: { p0: null } };
            if (args.input.query.includes("SaveGeneratedDocument")) {
              receipt.writes.push(args.input.variables.input);
              return { data: { saveGeneratedDocument: { id: "onto-daily-document", revision: 1 } } };
            }
        }
        throw new Error(`Unexpected Onto host call ${op}`);
      } } as never;
      await dailyUpdate(host, scope, {
        runId: "00000000-0000-4000-8000-000000000001",
        scheduledFor: Date.parse(oceanMorning.briefAt) - 15 * 60_000,
        schedule: { id: "onto-schedule", workflowId: "onto-daily-update", inputs: {}, connectionId: null, resource: null },
      });
      const write = receipt.writes[0];
      if (!write) throw new Error("Onto did not save its daily page");
      return { ...receipt, update: {
        id: "onto-daily-document", revision: 1, slug: write.slug, scope: "personal", app: "Onto", timezone, ...parseAppUpdate(write.generatedBody),
      } };
    } finally {
      delete globals.issue273Env;
      hook.deregister();
    }
  } finally {
    db.close();
  }
}

export type InferenceStep = { runId: string; step: string; instructions: string; data: unknown; schema: Record<string, unknown> };
