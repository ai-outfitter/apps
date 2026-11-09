import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  homeCardAPI,
  homeCardCatalog,
  homeCardReadResult,
} from "@ai-outfitter/app-sdk/home-cards";
import {
  type AppIdentity,
  identityHeaderValues,
} from "@ai-outfitter/app-sdk/server";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";
import { homeCards } from "../src/server/home-cards";
import { createIssue, createProject } from "../src/server/planning";

// Synthetic members of one organization's Planning, another organization's
// installation and a personal installation.
const org = { kind: "organization" as const, id: "org" };
const member: AppIdentity = {
  userId: "member",
  installationId: "planning-a",
  organizationId: "org",
  owner: org,
  role: "member",
  canEdit: false,
};
const owner: AppIdentity = { ...member, userId: "owner", role: "owner", canEdit: true };
const otherOrg: AppIdentity = {
  ...owner,
  installationId: "planning-b",
  organizationId: "other",
  owner: { kind: "organization", id: "other" },
};
const personal: AppIdentity = {
  userId: "member",
  installationId: "planning-mine",
  owner: { kind: "user", id: "member" },
  role: "owner",
  canEdit: true,
};

const project = (name: string) => ({
  name,
  githubRepository: "",
  goals: "",
  userStories: "",
  pressRelease: "",
  demoInstructions: "",
  demoResults: "",
});
const issue = (projectId: string, title: string, status = "todo") => ({
  projectId,
  title,
  description: "",
  category: "stone",
  status,
  assigneeId: null,
  dueDate: null,
  parentId: null,
});

async function setup() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const cards = homeCards(() => db);
  // A request exactly as platform dispatch forwards it for `who`.
  const call = async (operation: string, who: AppIdentity, body?: unknown) => {
    const { canEdit: _, ...identity } = who;
    const response = await homeCardAPI(
      new Request(`https://planning.internal/api/internal/home-cards/v1/${operation}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...identityHeaderValues(identity),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      operation,
      cards,
    );
    return {
      status: response.status,
      body: response.ok ? await response.json() : await response.text(),
    };
  };
  const read = async (who: AppIdentity, size = "large") => {
    const result = await call("read", who, { cardId: "projects", size });
    assert.equal(result.status, 200, String(result.body));
    const parsed = homeCardReadResult.parse(result.body);
    assert.equal(parsed.status, "ready");
    return parsed.status === "ready" ? parsed.body : [];
  };
  return { db, client, call, read };
}

type Body = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["read"]>>;
const listOf = (body: Body) => {
  const list = body.find((node) => node.kind === "list");
  assert.ok(list && list.kind === "list");
  return list.items;
};

test("the catalog declares one read-only projects card for every member", async () => {
  const { call, client } = await setup();
  try {
    for (const who of [member, owner, personal]) {
      const { status, body } = await call("catalog", who);
      assert.equal(status, 200);
      assert.deepEqual(homeCardCatalog.parse(body).cards, [
        {
          cardId: "projects",
          title: "Projects",
          description:
            "Projects in this Planning installation with their open and completed issue counts.",
          sizes: ["small", "medium", "large"],
          defaultSize: "medium",
          actionIds: [],
        },
      ]);
    }
    assert.equal((await call("read", member, { cardId: "other", size: "small" })).status, 404);
    assert.equal((await call("read", member, { cardId: "projects", size: "huge" })).status, 400);
    const action = await call("action", member, { cardId: "projects", actionId: "complete", input: {}, revision: 1 });
    assert.equal(action.status, 404);
  } finally {
    client.close();
  }
});

test("an empty installation says so without inventing projects", async () => {
  const { db, client, read } = await setup();
  try {
    await createProject(db, otherOrg, project("Elsewhere"));
    for (const size of ["small", "medium", "large"]) {
      const body = await read(member, size);
      assert.equal(body.length, 1);
      assert.equal(body[0].kind, "empty");
      assert.doesNotMatch(JSON.stringify(body), /Elsewhere/);
    }
  } finally {
    client.close();
  }
});

test("lists this installation's projects in page order at 1/3/6 with honest issue counts", async () => {
  const { db, client, read } = await setup();
  try {
    const names = ["Launch", "Billing", "Hiring", "Docs", "Analytics", "Ops", "Search"];
    const made: Record<string, string> = {};
    for (const name of names) made[name] = (await createProject(db, owner, project(name))).id;
    const { Launch: launch, Billing: billing } = made;
    for (const [title, status] of [["Pick date", "todo"], ["Draft notes", "in-progress"], ["Book venue", "done"]])
      await createIssue(db, member, issue(launch, title, status));
    await createIssue(db, member, issue(billing, "Invoice", "done"));
    // Another organization and a personal install never appear or count.
    const foreign = await createProject(db, otherOrg, project("Acme secret"));
    await createIssue(db, otherOrg, issue(foreign.id, "Foreign open"));
    const mine = await createProject(db, personal, project("Personal side project"));
    await createIssue(db, personal, issue(mine.id, "Personal open"));

    const large = await read(member, "large");
    assert.deepEqual(
      large.filter((node) => node.kind === "metric"),
      [
        { kind: "metric", label: "Projects", value: 7 },
        { kind: "metric", label: "Open issues", value: 2 },
      ],
    );
    const items = listOf(large);
    assert.deepEqual(
      items.map((item) => item.title),
      ["Analytics", "Billing", "Docs", "Hiring", "Launch", "Ops"],
    );
    const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
    assert.deepEqual(byTitle.Launch, {
      id: launch,
      title: "Launch",
      meta: "2 open · 1 completed",
      link: { path: `/projects/${launch}` },
    });
    assert.equal(byTitle.Billing.meta, "0 open · 1 completed");
    assert.equal(byTitle.Docs.meta, "No issues yet");
    assert.deepEqual(large.at(-1), { kind: "link", label: "1 more project", target: { path: "/" } });
    assert.doesNotMatch(JSON.stringify(large), /Acme|Foreign|Personal|progress/i);

    const small = await read(member, "small");
    assert.deepEqual(listOf(small).map((item) => item.title), ["Analytics"]);
    assert.equal(small.some((node) => node.kind === "metric"), false);
    assert.deepEqual(small.at(-1), { kind: "link", label: "6 more projects", target: { path: "/" } });
    const medium = await read(member, "medium");
    assert.deepEqual(listOf(medium).map((item) => item.title), ["Analytics", "Billing", "Docs"]);
    // A non-editor member reads exactly what the owner reads.
    assert.deepEqual(await read(owner, "medium"), medium);

    // The personal installation sees only its own project; no "more" link when all fit.
    const own = await read(personal, "large");
    assert.deepEqual(listOf(own).map((item) => [item.title, item.meta]), [["Personal side project", "1 open · 0 completed"]]);
    assert.equal(own.some((node) => node.kind === "link"), false);
  } finally {
    client.close();
  }
});

test("long project names stay within card limits", async () => {
  const { db, client, read } = await setup();
  try {
    await createProject(db, owner, project("P".repeat(160)));
    const [item] = listOf(await read(member, "small"));
    assert.equal(item.title.length, 120);
    assert.ok(item.title.endsWith("…"));
  } finally {
    client.close();
  }
});

test("the packaged Worker serves the card from the installation database for a non-editor member", async () => {
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    const viewer: Member = { userId: "member", organizationId: "org", role: "member" };
    const route = "/api/internal/home-cards/v1/";
    assert.equal((await app.call(`${route}catalog`)).status, 401);
    const created = await app.call("/api/apps/planning/projects", viewer, { method: "POST", body: { name: "Launch" } });
    assert.equal(created.status, 200, await created.clone().text());
    const { id } = (await created.json()) as { id: string };
    for (const [title, status] of [["Open", "todo"], ["Done", "done"]]) {
      const made = await app.call("/api/apps/planning/issues", viewer, { method: "POST", body: issue(id, title, status) });
      assert.equal(made.status, 200, await made.clone().text());
    }
    const response = await app.call(`${route}read`, viewer, { method: "POST", body: { cardId: "projects", size: "small" } });
    assert.equal(response.status, 200, await response.clone().text());
    const result = homeCardReadResult.parse(await response.json());
    assert.equal(result.status, "ready");
    assert.deepEqual(result.status === "ready" && listOf(result.body), [
      { id, title: "Launch", meta: "1 open · 1 completed", link: { path: `/projects/${id}` } },
    ]);
  } finally {
    await app.dispose();
  }
});
