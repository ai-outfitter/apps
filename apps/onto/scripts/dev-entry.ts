/** Node-only development entry. Never imported by app pages or packaged workers. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { appWorker, type AppWorkerOptions } from "@ai-outfitter/app-test/worker";
import type { WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import { drizzle } from "drizzle-orm/d1";
import { importEntities } from "../src/server/entity-import";
import { loadPersonalSeed } from "./personal-seed";

export async function localWikiWorker(installationId: string, options: AppWorkerOptions = {}) {
  if (process.env.OUTFITTER_LOCAL_DEV !== "1" || process.env.NODE_ENV === "production")
    throw new Error("The local wiki entry is only available through the development server.");
  const worker = await appWorker("wiki-map", fileURLToPath(new URL("../.outfitter/packages/operational.json", import.meta.url)), installationId, options);
  try {
    const db = drizzle(worker.database);
    const identity = { userId: "local-seed", installationId, owner: { kind: "user" as const, id: "local-seed" }, role: "owner", canEdit: true };
    // Reconcile missing defaults, but never overwrite authored records.
    const shared = JSON.parse(await readFile(new URL("../seeds/entities-v1.json", import.meta.url), "utf8"));
    await importEntities(db, identity, { format: shared.format, nodes: shared.nodes });
    const dispatch = worker.dispatch.bind(worker);
    let seeded: Promise<void> | undefined;
    worker.dispatch = async (url, request, props) => {
      const host = props?.workflowHost && options.workflowHost?.(props.workflowHost);
      if (host && !new URL(request.url).pathname.startsWith("/api/internal/entities/")) {
        seeded ??= (async () => {
          await loadPersonalSeed(db, identity, host, new URL("../seeds/entities-v1.json", import.meta.url), new URL("../seeds/public.local.json", import.meta.url));
          await loadPersonalSeed(db, identity, host);
        })().catch((error) => { seeded = undefined; throw error; });
        await seeded;
      }
      return dispatch(url, request, props);
    };
    return worker;
  } catch (error) { await worker.dispose(); throw error; }
}

const scopes = new WeakMap<object, WorkflowHostStub>();
let loaded: ReturnType<typeof localWikiWorker> | undefined;
export default {
  async fetch(request: Request, _env: unknown, ctx: { props?: { workflowHost?: WorkflowHostStub } }) {
    const installationId = process.env.OUTFITTER_LOCAL_WIKI_INSTALLATION_ID;
    if (!installationId) throw new Error("Set OUTFITTER_LOCAL_WIKI_INSTALLATION_ID for the local wiki entry.");
    loaded ??= localWikiWorker(installationId, { workflowHost: (scope) => { const host = scopes.get(scope); if (!host) throw new Error("Local workflow host unavailable"); return host; } });
    const worker = await loaded;
    const host = ctx.props?.workflowHost;
    // This key routes calls to the already-authorized platform stub.
    const scope = { organizationId: null, installationId, userId: "local-host", packageHash: "local", phase: "interactive" as const, expiresAt: Date.now() + 3_600_000 };
    if (host) scopes.set(scope, host);
    return worker.dispatch("", request, host ? { workflowHost: scope } : undefined);
  },
};
