import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The repository the box left on its default branch.
const root = import.meta.dirname;
const app = join(root, "apps/release-radar");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const { NODE_TEST_CONTEXT, VITEST, VITEST_MODE, VITEST_POOL_ID, VITEST_WORKER_ID, ...env } = process.env;
// Builds and installs print a lot; only a failure's output matters.
const run = (command: string, ...args: string[]) =>
  execFileSync(command, args, { cwd: root, env, stdio: "pipe", encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
/** A page's visible text, without tags, scripts or styles. */
const text = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("the manifest and package describe a demo-only Astro app", () => {
  const manifest = json(join(app, "app.json"));
  expect(manifest).toMatchObject({ id: "outfitter/release-radar", version: "0.1.0", runtime: "cloudflare-workers-for-platforms",
    dataLocation: "managing-outfitter-instance", modes: { demo: { capabilities: [] } },
    catalog: { access: "demo-only", demo: { slug: "release-radar", name: "Release Radar" } } });
  expect(manifest.modes.operational).toBeUndefined();
  const pkg = json(join(app, "package.json"));
  expect(pkg).toMatchObject({ name: "@ai-outfitter/app-release-radar", version: "0.1.0", outfitter: { kind: "app" } });
  expect(pkg.dependencies).toHaveProperty("astro");
  expect(pkg.dependencies).toHaveProperty("@astrojs/cloudflare");
  expect(pkg.dependencies).toHaveProperty("@ai-outfitter/app-sdk");
  expect(pkg.scripts.build).toMatch(/outfitter-app-build/);
  expect(pkg.scripts["test:unit"]).toBeTruthy();
  expect(pkg.scripts.dev).toMatch(/astro dev/);
  expect(readdirSync(join(app, "tests")).some((file) => readFileSync(join(app, "tests", file), "utf8").includes("summarize"))).toBe(true);
  // The request contract comes from the SDK's integration, not a copy of it.
  expect(readFileSync(join(app, "astro.config.mjs"), "utf8")).toMatch(/outfitterApp\(/);
  expect(existsSync(join(app, "src/middleware.ts"))).toBe(false);
});

test("packages/ and apps/hr are unchanged", () => {
  expect(run("git", "status", "--porcelain", "--", "packages", "apps/hr").trim()).toBe("");
  // The box's default branch: nothing under packages/ or apps/hr differs from the first commit.
  const first = run("git", "rev-list", "--max-parents=0", "HEAD").trim().split("\n").at(-1)!;
  expect(run("git", "diff", "--stat", first, "HEAD", "--", "packages", "apps/hr").trim()).toBe("");
});

describe("the built demo package", () => {
  let worker: { call(path: string, member?: unknown, init?: { method?: string }): Promise<Response>; dispose(): Promise<void> };
  let summary: { name: string; count: number }[];
  let repositories: { name: string; pullRequests: { number: number; title: string; author: string }[] }[];

  beforeAll(async () => {
    run("npm", "ci", "--no-audit", "--no-fund");
    run("npm", "test");
    expect(existsSync(join(app, ".outfitter/packages/demo.json"))).toBe(true);
    const fixtures = await import(join(app, "src/fixtures.ts"));
    repositories = fixtures.repositories;
    // The request names the row's name but not its count field: its one number, or the one named like a count.
    summary = fixtures.summarize(repositories).map((row: Record<string, unknown>) => {
      const numbers = Object.entries(row).filter((entry): entry is [string, number] => typeof entry[1] === "number");
      return { name: String(row.name), count: (numbers.length === 1 ? numbers[0] : numbers.find(([key]) => /count|merged/i.test(key)))?.[1] as number };
    });
    const { appWorker } = await import(join(root, "packages/app-test/src/worker.ts"));
    worker = await appWorker("release-radar", join(app, ".outfitter/packages/demo.json"));
  }, 900_000);
  afterAll(async () => worker?.dispose());

  test("staged data and summarize", () => {
    expect(repositories.length).toBeGreaterThanOrEqual(3);
    expect(summary).toHaveLength(repositories.length);
    for (const row of summary) expect(row.count).toBe(repositories.find((repository) => repository.name === row.name)!.pullRequests.length);
    expect(summary.map((row) => row.count)).toEqual([...summary.map((row) => row.count)].sort((a, b) => b - a));
  });

  test("/ lists every repository with its count and link", async () => {
    const response = await worker.call("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*>\s*Release Radar\s*<\/h1>/);
    // Each count is shown with its repository: between its name and the next repository's.
    const page = text(html);
    const at = summary.map((row) => {
      expect(html).toContain(`/repos/${row.name}`);
      const index = page.indexOf(row.name);
      expect(index, `${row.name} is shown`).toBeGreaterThanOrEqual(0);
      return index;
    });
    summary.forEach((row, i) => {
      const next = Math.min(...at.filter((index) => index > at[i]), page.length);
      expect(page.slice(at[i] + row.name.length, next), `${row.name}'s count`).toMatch(new RegExp(`(^|\\D)0*${row.count}(\\D|$)`));
    });
  });

  test("/repos/<name> lists its pull requests and an unknown name is 404", async () => {
    for (const repository of repositories) {
      const response = await worker.call(`/repos/${repository.name}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const page = text(html);
      for (const pull of repository.pullRequests) {
        expect(page).toContain(String(pull.number));
        expect(page).toContain(pull.title);
        expect(page).toContain(pull.author);
      }
    }
    expect((await worker.call("/repos/no-such-repository")).status).toBe(404);
  });

  test("/__health, methods and headers", async () => {
    const health = await worker.call("/__health");
    expect(await health.json()).toMatchObject({ app: "release-radar", status: "ok" });
    expect((await worker.call("/", undefined, { method: "POST" })).status).toBe(405);
    const page = await worker.call("/");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
