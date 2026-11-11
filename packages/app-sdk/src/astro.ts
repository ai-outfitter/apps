import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { parse } from "yaml";
import type { AppMiddlewareOptions } from "./cloudflare/middleware";
import type { StandaloneOptions, StandaloneWorkflows } from "./standalone-host";
import { type AppMigration, storageMigration, validateMigrationLineage } from "./migrations";

export type OutfitterAppOptions = Omit<AppMiddlewareOptions, "dev"> & {
  /** Standalone mode (docs/standalone-apps.md): the app signs people in, keeps
   * its own database and answers its own workflow host calls, with no
   * Outfitter platform in front of it. Defaults to `OUTFITTER_STANDALONE=1`. */
  standalone?: boolean;
  /** The product name on the sign-in page; defaults to the app slug. */
  name?: string;
};

/**
 * The standard Outfitter app request contract, so an app needs no
 * `src/middleware.ts`: `/__health`, GET/HEAD-only pages, forwarded identity on
 * `/api/*`, `Cache-Control: private, no-store`, `nosniff`, and
 * `contentSecurityPolicy` on built responses without one of their own.
 * In standalone mode a sign-in and local host middleware runs first.
 */
export function outfitterApp({ standalone = process.env.OUTFITTER_STANDALONE === "1", name, ...options }: OutfitterAppOptions): AstroIntegration {
  return {
    name: "@ai-outfitter/app-sdk",
    hooks: {
      "astro:config:setup": ({ addMiddleware, command, createCodegenDir, config }) => {
        const dev = command === "dev";
        if (standalone) {
          const root = config?.root ? fileURLToPath(config.root) : process.cwd();
          const settings: StandaloneOptions = {
            app: options.app,
            name: name ?? options.app,
            dev,
            migrations: standaloneMigrations(root, Boolean(options.storage)),
            workflows: standaloneWorkflows(root),
          };
          const entrypoint = new URL("standalone.mjs", createCodegenDir());
          writeFileSync(
            entrypoint,
            `import { standaloneMiddleware } from "@ai-outfitter/app-sdk/cloudflare/standalone";\nexport const onRequest = standaloneMiddleware(${JSON.stringify(settings)});\n`,
          );
          addMiddleware({ entrypoint, order: "pre" });
        }
        const entrypoint = new URL("middleware.mjs", createCodegenDir());
        writeFileSync(
          entrypoint,
          `import { appMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";\nexport const onRequest = appMiddleware(${JSON.stringify({ ...options, dev })});\n`,
        );
        addMiddleware({ entrypoint, order: "pre" });
      },
    },
  };
}

/** The app's `migrations/*.sql`, after the storage table when it declares buckets,
 * as install applies them (packages/app-build). */
export function standaloneMigrations(root: string, storage: boolean): AppMigration[] {
  const folder = join(root, "migrations");
  const files = existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".sql")).sort() : [];
  const migrations = [
    ...(storage ? [storageMigration] : []),
    ...files.map((file) => ({ name: file.slice(0, -4), sql: readFileSync(join(folder, file), "utf8") })),
  ];
  return validateMigrationLineage(migrations).migrations;
}

/** Each `workflows/<id>/workflow.yaml`: its steps' inference settings and output slots. */
export function standaloneWorkflows(root: string): StandaloneWorkflows {
  const folder = join(root, "workflows");
  if (!existsSync(folder)) return {};
  const workflows: StandaloneWorkflows = {};
  for (const directory of readdirSync(folder).sort()) {
    const file = join(folder, directory, "workflow.yaml");
    if (!existsSync(file)) continue;
    const definition = parse(readFileSync(file, "utf8")) as {
      id: string;
      steps?: { id: string; inference?: Record<string, unknown>; outputs?: Record<string, unknown> }[];
    };
    workflows[definition.id] = Object.fromEntries(
      (definition.steps ?? []).map((step) => [
        step.id,
        { ...(step.inference ? { inference: step.inference } : {}), outputs: Object.keys(step.outputs ?? {}) },
      ]),
    );
  }
  return workflows;
}
