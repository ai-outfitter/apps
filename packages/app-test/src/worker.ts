// A built app package running in Miniflare with an optional installation D1
// database, migrated from the package exactly as install does, and one R2
// bucket per declared storage bucket, bound as install binds them. Tests call it
// with forwarded identity headers, or hand `dispatch` to platform code that
// reaches the app through dispatch. The caller supplies the built artifact path.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { type AppActor, encodeActor, identityHeaders, identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { type AppMigration, migrateAppDatabase } from "@ai-outfitter/app-sdk/migrations";
import { type StorageManifest, storageBinding } from "@ai-outfitter/app-sdk/storage";
import { platformIdentityResponse } from "./platform-identity";
import type { WorkflowHostScope, WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";

type Package = {
  manifest: { database?: { migrations: AppMigration[] }; storage?: StorageManifest };
  artifact: {
    mainModule: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
    modules: Record<string, string>;
    assets: Record<string, { content: string; encoding?: string }>;
  };
};

export type Member = {
  userId: string; organizationId: string; role: string;
  /** Trusted entity delegation; platform dispatch sets it only for an app with entities.write.delegated. */
  entityWriter?: string;
  /** The verified caller, as platform dispatch forwards it; an app calling another app is {kind:"app",id:<its installation>}. Absent means the member. */
  actor?: AppActor;
};
/** The identity headers platform dispatch sets for `member`, including its forwarded actor. */
function memberHeaders(member: Member | undefined, installationId: string): Record<string, string> {
  if (!member) return {};
  return {
    ...identityHeaderValues({ ...member, installationId }),
    ...(member.actor ? { [identityHeaders.actor]: encodeActor(member.actor) } : {}),
  };
}
/** Dispatch props as the platform passes them: a workflow host scope, never a stub. */
export type DispatchProps = { workflowHost: WorkflowHostScope };
export type AppWorkerOptions = {
  /** Optional durable local storage; tests remain disposable by default. */
  persistencePath?: string;
  /** Answers the app's workflow host calls for a dispatch that carries a scope,
   * as the platform's host service would (a double, or the platform's own host). */
  workflowHost?: (scope: WorkflowHostScope) => WorkflowHostStub;
};

// With a workflow host, this entry wraps the app's own: a dispatch that carries a
// scope reaches the app through a real workerd RPC entrypoint as `ctx.props.workflowHost`,
// and each call goes back to the test process. The token names that dispatch's scope.
const hostHeader = "x-outfitter-test-workflow-host";
const hostEntry = "outfitter-test-host.mjs";
const hostEntrySource = (main: string) => `import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./${main}";
export * from "./${main}";
export class OutfitterTestWorkflowHost extends WorkerEntrypoint {
  async call(operation, input) {
    const response = await this.env.OUTFITTER_TEST_HOST.fetch("https://host.test/", {
      method: "POST", body: JSON.stringify({ token: this.ctx.props.token, operation, input }) });
    return response.json();
  }
}
export class OutfitterTestApp extends WorkerEntrypoint {
  fetch(request) { return app.fetch(request, this.env, this.ctx); }
}
export default {
  fetch(request, env, ctx) {
    const token = request.headers.get(${JSON.stringify(hostHeader)});
    if (!token) return app.fetch(request, env, ctx);
    const headers = new Headers(request.headers);
    headers.delete(${JSON.stringify(hostHeader)});
    const workflowHost = ctx.exports.OutfitterTestWorkflowHost({ props: { token } });
    return ctx.exports.OutfitterTestApp({ props: { workflowHost } }).fetch(new Request(request, { headers }));
  },
};
`;

export async function appWorker(slug: string, packagePath: string | URL, installationId = `${slug}-installation`, options: AppWorkerOptions = {}) {
  const pack = JSON.parse(await readFile(packagePath, "utf8")) as Package;
  const hosts = new Map<string, WorkflowHostStub>();
  const modules: Record<string, string> = { ...pack.artifact.modules,
    ...(options.workflowHost ? { [hostEntry]: hostEntrySource(pack.artifact.mainModule) } : {}) };
  const directory = await mkdtemp(join(tmpdir(), `outfitter-${slug}-`));
  let worker: Miniflare | undefined;
  try {
    for (const [path, asset] of Object.entries(pack.artifact.assets)) {
      const destination = join(directory, path.slice(1));
      await mkdir(dirname(destination), { recursive: true });
      const bytes = Buffer.from(asset.content, "base64");
      await writeFile(destination, asset.encoding ? gunzipSync(bytes) : bytes);
    }
    worker = new Miniflare({
      ...(options.persistencePath ? { resourcePersistencePath: options.persistencePath } : {}),
      workers: [
        {
          config: {
            name: slug,
            compatibilityDate: pack.artifact.compatibilityDate,
            compatibilityFlags: pack.artifact.compatibilityFlags,
            manifest: {
              mainModule: options.workflowHost ? hostEntry : pack.artifact.mainModule,
              modulesRoot: directory,
              modules: Object.fromEntries(
                Object.entries(modules).map(([name, contents]) => [
                  name,
                  { type: "esm" as const, contents },
                ]),
              ),
            },
            env: {
              ASSETS: { type: "assets" },
              ...(pack.manifest.database ? { DB: { type: "d1" as const, id: `${installationId}-db` } } : {}),
              ...(options.workflowHost ? { OUTFITTER_TEST_HOST: { type: "fetcher" as const, handler: async (request: { json(): Promise<unknown> }) => {
                const { token, operation, input } = await request.json() as { token: string; operation: string; input: unknown };
                const host = hosts.get(token);
                return MiniflareResponse.json(host ? await host.call(operation, input) : { ok: false, status: 503, message: "Workflow host unavailable" });
              } } } : {}),
              // Each installation's buckets are its own, as on the platform.
              ...Object.fromEntries(Object.keys(pack.manifest.storage?.buckets ?? {}).map((bucket) => [
                storageBinding(bucket),
                { type: "r2" as const, name: `${installationId}-${bucket}` },
              ])),
            },
            assets: {
              directory,
              hasUserWorker: true,
              htmlHandling: "none",
              notFoundHandling: "none",
            },
          },
        },
      ],
    });
    const host = worker;
    const database = pack.manifest.database ? await host.getD1Database("DB") : undefined;
    if (database) await migrateAppDatabase(
      {
        query: async (statement) =>
          (await database.prepare(statement).all<Record<string, unknown>>()).results,
        batch: async (statements) => {
          await database.batch(statements.map((statement) => database.prepare(statement)));
        },
      },
      pack.manifest.database?.migrations ?? [],
    );
    const origin = `https://${slug}.alpha.localhost`;
    /** A request as platform dispatch sends it; `props` carries a workflow host scope. */
    const dispatch = async (_script: string, request: Request, props?: DispatchProps) => {
      const headers = new Headers(request.headers);
      headers.delete(hostHeader);
      if (props?.workflowHost && options.workflowHost) {
        const token = crypto.randomUUID();
        hosts.set(token, options.workflowHost(props.workflowHost));
        headers.set(hostHeader, token);
      }
      return (await host.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(headers),
        body: request.body ? await request.arrayBuffer() : undefined,
        redirect: request.redirect,
      })) as unknown as Response;
    };
    return {
      installationId,
      origin,
      /** The artifact's encoded assets, so tests can compare served bytes without re-reading it. */
      assets: pack.artifact.assets,
      hasDatabase: !!database,
      get database() {
        if (!database) throw new Error("This package has no installation database");
        return database;
      },
      dispatch,
      /** The R2 bucket bound for a declared storage bucket, to inspect stored bytes. */
      bucket(name: string) {
        if (!pack.manifest.storage?.buckets[name]) throw new Error(`This package declares no bucket ${name}`);
        return host.getR2Bucket(storageBinding(name));
      },
      /** Fetch a complete request, including app-owned browser routing headers. */
      fetch(input: string | URL | Request, init?: RequestInit) {
        const request = new Request(input, init);
        // As a browser sees the app: the platform answers its identity routes on every app mount.
        return Promise.resolve(platformIdentityResponse(request.method, request.url) ?? dispatch("", request));
      },
      /** A request as the platform forwards it for `member`; no member sends none.
       * `workflowHost` is the scope the platform would pass as dispatch props. */
      async call(path: string, member?: Member, init: { method?: string; body?: unknown; headers?: HeadersInit; workflowHost?: WorkflowHostScope } = {}) {
        // The platform answers its identity routes itself; it never forwards them to the app.
        const identity = platformIdentityResponse(init.method ?? "GET", origin + path);
        if (identity) return identity;
        const headers = new Headers(init.headers);
        // Identity comes only from `member`; caller headers cannot forge it.
        for (const name of Object.values(identityHeaders)) headers.delete(name);
        for (const [name, value] of Object.entries(memberHeaders(member, installationId))) headers.set(name, value);
        if (init.body !== undefined) headers.set("Content-Type", "application/json");
        return dispatch(
          "",
          new Request(origin + path, {
            method: init.method ?? "GET",
            headers,
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
          init.workflowHost ? { workflowHost: init.workflowHost } : undefined,
        );
      },
      async dispose() {
        await host.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await worker?.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
