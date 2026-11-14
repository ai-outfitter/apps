import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { outfitterApp } from "../src/astro";

test("outfitterApp registers the app middleware with its options before the app's own", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outfitter-app-"));
  try {
    const options = { app: "example", contentSecurityPolicy: "default-src 'none'", readOnly: true };
    // Only `astro dev` drops the policy; a build keeps it whatever NODE_ENV says.
    for (const [command, dev] of [["build", false], ["dev", true], ["preview", false]] as const) {
      const added: { entrypoint: string | URL; order: string }[] = [];
      const setup = outfitterApp(options).hooks["astro:config:setup"] as (hooks: unknown) => void;
      setup({ addMiddleware: (middleware: (typeof added)[number]) => added.push(middleware), command, createCodegenDir: () => pathToFileURL(`${directory}/`) });
      assert.equal(added.length, 1);
      assert.equal(added[0].order, "pre");
      assert.equal(
        await readFile(added[0].entrypoint, "utf8"),
        `import { appMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";\nexport const onRequest = appMiddleware(${JSON.stringify({ ...options, dev })});\n`,
        command,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
