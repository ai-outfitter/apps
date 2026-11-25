import { expect, test } from "@playwright/test";
import { pageURLHeader } from "@ai-outfitter/app-sdk/server";
import { type WorkflowHostScope } from "@ai-outfitter/app-sdk/workflow-host";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { authoredWiki, oceanMorning, timezone } from "../evals/daily-brief/issue-273-fixtures";

const origin = "https://outfitter.example";
const mount = "/apps/forerunner/";
const viewer = { userId: "morning-member", organizationId: "", role: "owner", owner: { kind: "user" as const, id: "morning-member" } };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());

test("installed Today keeps date, scope and source filters on an empty timeline and empty filtered activity", async ({ page }) => {
  const date = today();
  const brief = { id: "today-receipt", revision: 3, generatedBody: "Saved morning brief.", archived: false, provenance: JSON.stringify({ kind: "forerunner.daily-brief" }) };
  const scope: WorkflowHostScope = { organizationId: null, installationId: "morning-install", userId: viewer.userId, packageHash: "test-package", phase: "interactive", expiresAt: Date.now() + 120_000 };
  const wikiReads: { start: string; end: string }[] = [];
  const ontoReads: string[] = [];
  const unexpected: string[] = [];
  const allowedScopes = new Set(["personal", "fixture-team"]);
  let denyTeam = false;
  let wikiUnavailable = false;
  let noSavedBrief = false;
  const attempts = new Map<string, { date: string; status: string; reason: string }>();
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), scope.installationId, {
    workflowHost: grant => ({ async call(operation, input) {
      // The dispatch carries member read authority. Filtering by URL cannot add a scope.
      if (grant.installationId !== scope.installationId || grant.userId !== scope.userId || grant.organizationId !== null ||
          grant.phase !== "interactive" || grant.initiation || grant.expiresAt <= Date.now()) {
        return { ok: false, status: 403, message: "Wrong installation, member or phase" };
      }
      const request = input as Record<string, unknown>;
      const ok = (value: unknown) => ({ ok: true as const, value });
      if (operation === "schedules") return ok([{
        id: "brief-schedule", workflowId: "forerunner-daily-brief", timezone, cron: "0 5 * * *", enabled: true,
        inputs: {}, connectionId: null, resource: null, createdBy: viewer.userId,
        nextRunAt: Date.now(), lastRunAt: null, lastRunId: null, lastOutcome: null,
      }]);
      if (operation === "workflow.activity") return ok({ total: attempts.size, items: [...attempts.keys()].reverse().map(id => ({
        id, workflowId: "forerunner-daily-brief", status: "complete", createdBy: viewer.userId,
        createdAt: Date.now(), updatedAt: Date.now(), inputs: {},
      })) });
      if (operation === "workflow.read") {
        const id = String(request.id);
        const receipt = attempts.get(id);
        return ok(receipt ? { run: { id, workflowId: "forerunner-daily-brief", status: "complete", createdBy: viewer.userId,
          createdAt: Date.now(), updatedAt: Date.now() }, inputs: {}, readiness: { run: "complete", steps: {} },
          outputs: { "collect.outputs.brief": { complete: true, value: receipt } }, attempts: [] } : null);
      }
      if (operation === "workflow.start") return ok({ id: request.id, workflow: request.workflow, created: true });
      if (operation === "workflow.collect") {
        attempts.set(String(request.runId), request.value as { date: string; status: string; reason: string });
        return ok({ run: "complete", steps: { collect: "complete" } });
      }
      if (operation === "profile.read") return { ok: false, status: 503, message: "No profile evidence" };
      if (operation === "entities.types") return ok([]);
      if (operation === "actions.call" && request.template === "wiki-map" && request.action === "graph.graphql" && request.readOnly === true) {
        const { query, variables } = request.input as { query: string; variables: Record<string, string> };
        if (query.includes("SavedPages")) return ok({ data: { p0: null } });
        if (query.includes("DailyHomeBriefs")) return ok({ data: Object.fromEntries(Object.entries(variables).map(([key, slug]) =>
          ["d" + key.slice(1), !noSavedBrief && slug.startsWith(`forerunner-brief-${date}-`) ? { document: brief } : null])) });
      }
      if (operation === "platform.document" && request.document === "Viewer" && !request.app) {
        return ok({ viewer: { orgs: denyTeam ? [] : [{ slug: "fixture-team", name: "Fixture team", appSlugs: ["wiki-map"] }] } });
      }
      if (operation === "platform.document" && request.kind === "query") {
        if (!request.app && !request.scopes && (request.document === "Schedules" || request.document === "WorkflowRuns")) {
          return ok({ items: [] });
        }
        const variables = request.variables as Record<string, string>;
        if (request.app === "wiki-map" && !request.scopes && request.document === "DailyAppUpdates") {
          ontoReads.push(variables.date);
          return ok({ data: { dailyAppUpdates: !noSavedBrief && variables.date === oceanMorning.yesterday ? [{
            id: "onto-report", revision: 4, slug: "onto-yesterday", scope: "personal", app: "Onto", summary: "Two committed record revisions.", timezone, complete: true,
          }] : [] } });
        }
        if (request.app === "wiki-map" && !request.scopes && request.document === "WikiRevisionActivity") {
          wikiReads.push({ start: variables.start, end: variables.end });
          if (wikiUnavailable) return { ok: false, status: 503, message: "Wiki store is unavailable" };
          return ok({ data: { wikiRevisionActivity: authoredWiki.filter(row =>
            allowedScopes.has(row.scope) && !(denyTeam && row.scope === "fixture-team") && !("provenance" in row) &&
            row.createdAt >= variables.start && row.createdAt < variables.end) } });
        }
      }
      unexpected.push(operation + (request.document ? `:${request.document}` : ""));
      return { ok: false, status: 403, message: "Operation is outside the read-only fixture" };
    } }),
  });

  try {
    await page.route(`${origin}/**`, async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (await fulfillPlatformIdentity(route)) return;
      const inner = url.pathname.startsWith(mount) ? "/" + url.pathname.slice(mount.length) :
        url.pathname.startsWith("/_astro/") ? url.pathname : null;
      if (inner === null) return route.fulfill({ status: 404 });
      expect(request.method()).toBe(inner === "/api/apps/forerunner/daily-brief" ? "POST" : "GET");
      await fulfillFrom(route, await app.call(inner + url.search, viewer, {
        method: request.method(), ...(request.method() === "POST" ? { body: request.postDataJSON() } : {}),
        headers: { [pageURLHeader]: url.href }, workflowHost: scope,
      }));
    });

    const response = await page.goto(`${origin}${mount}?briefDate=${oceanMorning.yesterday}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Today/);
    await expect(page.getByRole("heading", { name: "Nothing on the timeline yet" })).toBeVisible();
    const morning = page.getByRole("region", { name: "Morning brief" });
    const saved = morning.getByRole("link", { name: `Read the ${date} brief` });
    await expect(saved).toHaveAttribute("href", /\?revision=3$/);
    await expect(morning.getByText("Partial coverage", { exact: false })).toBeVisible();
    const filters = {
      date: morning.getByLabel("Date", { exact: true }),
      scope: morning.getByRole("combobox", { name: "Scope", exact: true }),
      source: morning.getByRole("combobox", { name: "Source", exact: true }),
      apply: morning.getByRole("button", { name: "Apply filters" }),
    };
    const wiki = morning.getByRole("region", { name: "Wiki activity" });
    const onto = morning.getByRole("region", { name: "Onto activity" });
    await expect(filters.date).toHaveValue(oceanMorning.yesterday);
    await expect(wiki.getByRole("link", { name: "Reviewed field notes" })).toHaveAttribute("href", "/apps/wiki-map/p/review-notes?revision=3");
    await expect(wiki.getByRole("link", { name: "Documented the handoff" })).toHaveAttribute("href", "/o/fixture-team/wiki-map/revision/legacy/legacy-authored?revision=2");
    await expect(onto.getByRole("link", { name: "Personal report, revision 4" })).toHaveAttribute("href", "/apps/wiki-map/p/onto-yesterday?revision=4");
    await expect(morning.getByText(/sentinel/i)).toHaveCount(0);
    expect(wikiReads).toContainEqual({ start: oceanMorning.start, end: oceanMorning.end });
    expect(ontoReads).toContain(oceanMorning.yesterday);

    await filters.scope.selectOption("fixture-team");
    await filters.source.selectOption("wiki");
    await filters.apply.click();
    await expect(wiki.getByRole("link")).toHaveCount(1);
    await expect(wiki.getByRole("link")).toHaveText("Documented the handoff");
    await expect(onto).toHaveCount(0);

    denyTeam = true;
    await page.reload();
    await expect(wiki.getByText("No authored Wiki revisions for this selection.")).toBeVisible();
    await expect(filters.scope).toHaveValue("fixture-team");
    await expect(filters.source).toHaveValue("wiki");
    await expect(filters.date).toHaveValue(oceanMorning.yesterday);
    await expect(saved).toHaveAttribute("href", /\?revision=3$/);
    await expect(page.getByRole("heading", { name: "Nothing on the timeline yet" })).toBeVisible();

    await filters.date.fill("2026-11-23");
    await filters.scope.selectOption("all");
    await filters.source.selectOption("onto");
    await filters.apply.click();
    await expect(onto.getByText("No saved Onto report for this selection.")).toBeVisible();
    await expect(wiki).toHaveCount(0);
    await expect(filters.date).toHaveValue("2026-11-23");
    expect(ontoReads).toContain("2026-11-23");
    await expect(page).toHaveURL(/\/apps\/forerunner\/\?briefDate=2026-11-23&briefScope=all&briefSource=onto#morning-brief$/);

    wikiUnavailable = true;
    await filters.source.selectOption("wiki");
    await filters.apply.click();
    await expect(wiki.getByText("Some Wiki revisions could not be read.")).toBeVisible();
    await expect(wiki.getByText("No authored Wiki revisions for this selection.")).toHaveCount(0);
    await expect(filters.apply).toBeVisible();
    await expect(saved).toHaveAttribute("href", /\?revision=3$/);
    expect(unexpected).toEqual([]);

    noSavedBrief = true;
    await page.reload();
    await expect(saved).toHaveCount(0);
    await morning.getByRole("button", { name: "Generate brief now" }).click();
    const reason = "No saved evidence was available to write a brief from. Nothing was saved.";
    await expect(morning.getByText(`The latest brief run failed. ${reason}`)).toBeVisible();
    await expect(morning.getByRole("button", { name: "Retry brief" })).toBeVisible();
    await expect(filters.scope).toHaveValue("all");
    await expect(filters.date).toHaveValue("2026-11-23");
    await expect(filters.source).toHaveValue("wiki");
    await expect(saved).toHaveCount(0);
    expect([...attempts.values()]).toEqual([{ date, status: "failed", reason }]);
  } finally {
    try { await page.unrouteAll({ behavior: "wait" }); }
    finally { await app.dispose(); }
  }
});
