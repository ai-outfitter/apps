import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { discoveryRuns, discoverySources, previewDiscovery, readableConnection } from "../src/server/discovery";

// GitHub and Slack read like Gmail: a person's own connection, newest first,
// each record in full, cited by the shared evidence convention.
const types = ["Person"].map((name, i) => ({ id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, name, category: "node", body: `A ${name}.` }));
const who: AppIdentity = { installationId: "forerunner", userId: "alice", owner: { kind: "user", id: "alice" }, role: "owner", canEdit: true };
const github = { id: "c0000000-0000-4000-8000-000000000003", provider: "github", resource: "42", label: "alice-gh", operations: ["activity.read"] };
const slack = { id: "c0000000-0000-4000-8000-000000000004", provider: "slack", resource: "T1", label: "Acme", operations: ["channels.selected", "history.read", "thread.read"] };
const semantic = { entities: [{ key: "bob", name: "Bob", type: "Person", summary: "Reviewed the offsite plan.", existingId: null, certainty: "mentioned", confidence: 0.7, evidence: ["e0"] }], relationships: [] };

function fakeHost(connector: (input: { operation: string; input: Record<string, unknown> }) => unknown) {
  const reads: { operation: string; input: Record<string, unknown> }[] = [];
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    snapshot: () => ({ connections: [github, slack] }),
    "identity.current": () => ({ id: "alice", name: "Alice", email: "alice@example.test" }),
    "workflow.start": (input) => ({ id: input.id }),
    "workflow.collect": () => ({}),
    "session.append": () => ({}),
    "inference.generate": () => ({ output: semantic }),
    "entities.types": () => ["graph-type", "graph-node", "graph-edge"].map((type) => ({ type, installationId: "wiki", writable: true })),
    "connector.execute": (input) => { const call = input as { operation: string; input: Record<string, unknown> }; reads.push(call); return connector(call); },
    "actions.call": () => wikiGraphFixture("wiki", { types: types.map((t) => ({ ref: { installationId: "wiki", type: "graph-type", id: t.id }, attributes: t })) }),
  };
  const host = { call: async (name: string, input: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(name);
    return handler(input);
  } } as unknown as WorkflowHost<"interactive">;
  return { host, reads };
}
async function database() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}

test("GitHub and Slack connections are listed as discovery sources", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  assert.ok(readableConnection(github) && readableConnection(slack));
  assert.ok(!readableConnection({ ...slack, operations: ["history.read"] }), "Slack needs every read it uses");
  const { host } = fakeHost(() => ({}));
  const { sources } = await discoverySources(db, who, host);
  assert.deepEqual(sources.map((s) => [s.provider, s.label]), [["github", "GitHub · alice-gh"], ["slack", "Slack · Acme"]]);
});

test("GitHub reads issues and pull requests in full, newest first, cited by owner/repo/kind/number", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const item = (n: number, updatedAt: string, comments: { author: string; body: string }[] = []) => ({
    id: `acme/web#${n}`, kind: n === 7 ? "pull-request" : "issue", repository: "acme/web", number: n, title: `Item ${n}`, state: "open",
    url: `https://github.com/acme/web/${n === 7 ? "pull" : "issues"}/${n}`, createdAt: updatedAt, updatedAt, author: "bob", assignees: ["alice-gh"],
    body: `<!-- template guidance -->Plan for ${n}.`, comments: comments.map((c) => ({ ...c, createdAt: updatedAt })), commentCount: comments.length,
  });
  const { host, reads } = fakeHost(() => ({ login: "alice-gh", more: true, total: 80,
    items: [item(7, "2026-11-03T10:00:00Z", [{ author: "carol", body: "Older" }, { author: "bob", body: "Newest" }]), item(3, "2026-11-02T10:00:00Z")] }));
  const preview = await previewDiscovery(db, who, host, { sources: [`connection:${github.id}`], range: "all" });
  const calls = reads.filter((r) => r.operation === "activity.read");
  assert.deepEqual(calls.map((c) => c.input), [{ limit: 25, page: 1 }], "a short page is the last one read");
  const [read] = preview.sources;
  assert.equal(read.count, 2);
  assert.equal(read.more, true);
  assert.deepEqual(read.next, { to: "2026-11-02T10:00:00.000Z" });
  const input = preview.inputs?.[0];
  assert.equal(input?.provider, "github");
  assert.match(input?.excerpt ?? "", /Plan for 7\./);
  assert.doesNotMatch(input?.excerpt ?? "", /template guidance/);
  assert.match(input?.excerpt ?? "", /@bob \(2026-11-03\): Newest\n\n@carol \(2026-11-03\): Older/);
  assert.match(input?.excerpt ?? "", /@alice-gh \(GitHub, the operating user's own account\)/);
  const evidence = preview.proposals?.[0].evidence[0];
  assert.equal(evidence?.provider, "github");
  assert.equal(evidence?.recordId, "acme/web/pull/7");
  assert.equal(evidence?.version, "2026-11-03T10:00:00Z");
});

test("Slack reads selected channels newest first, each thread with its replies, cited by team/channel/ts", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const message = (channel: string, ts: string, text: string, thread?: string) => ({
    id: `slack:T1:${channel}:${ts}`, sourceId: `slack:T1:${channel}`, timestamp: ts, authorId: "U_BOB", text, threadId: thread ?? null,
    reference: `https://slack.com/app_redirect?team=T1&channel=${channel}&message_ts=${ts}`,
  });
  const { host, reads } = fakeHost(({ operation, input }) => {
    if (operation === "channels.selected") return { items: [{ id: "CGEN", name: "general" }, { id: "CDIN", name: "dinner" }], coverage: { outcome: "complete" }, userId: "U_ALICE" };
    if (operation === "thread.read") return { items: [message("CDIN", "1730600000.000100", "Dinner Friday at <https://example.test|Luigi's>?", "1730600000.000100"), { ...message("CDIN", "1730600100.000100", "Yes!", "1730600000.000100"), authorId: "U_ALICE" }], coverage: { outcome: "complete" } };
    return input.channel === "CGEN"
      ? { items: [message("CGEN", "1730500000.000100", "<@U0CAROL> has joined the channel"), message("CGEN", "1730400000.000100", "Quarterly plan is up")], coverage: { outcome: "complete" } }
      : { items: [message("CDIN", "1730600000.000100", "Dinner Friday at <https://example.test|Luigi's>?", "1730600000.000100")], coverage: { outcome: "complete" } };
  });
  const preview = await previewDiscovery(db, who, host, { sources: [`connection:${slack.id}`], range: "7d" });
  const history = reads.filter((r) => r.operation === "history.read");
  assert.deepEqual(history.map((r) => r.input.channel), ["CGEN", "CDIN"]);
  assert.match(String(history[0].input.oldest), /^\d+\.\d{6}$/);
  assert.deepEqual(reads.filter((r) => r.operation === "thread.read").map((r) => r.input), [{ channel: "CDIN", thread: "1730600000.000100", maxPages: 1 }]);
  const [read] = preview.sources;
  assert.equal(read.count, 2, "a channel join is not a record");
  assert.equal(read.more, false);
  const [first, second] = preview.inputs ?? [];
  assert.equal(first.subject, "#dinner: Dinner Friday at Luigi's (https://example.test)?");
  assert.match(first.excerpt, /Replies \(1\):\n\n@U_ALICE: Yes!/);
  assert.match(first.excerpt, /@U_ALICE \(Slack, the operating user's own account\)/);
  assert.equal(second.subject, "#general: Quarterly plan is up");
  const evidence = preview.proposals?.[0].evidence[0];
  assert.equal(evidence?.provider, "slack");
  assert.equal(evidence?.recordId, "T1/CDIN/1730600000.000100");
});


test("Slack without channel access explains how to select channels and retains the read failure", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const { host, reads } = fakeHost(({ operation }) => {
    assert.equal(operation, "channels.selected", "no history is read without selected channels");
    return { items: [], coverage: { outcome: "complete" }, userId: "U_ALICE" };
  });
  let refusal: Response | undefined;
  await assert.rejects(previewDiscovery(db, who, host, { sources: [`connection:${slack.id}`] }), (error: unknown) => {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 409);
    refusal = error;
    return true;
  });
  assert.ok(refusal);
  assert.match(await refusal.text(), /No Slack channels selected.*Profile.*Manage.*Save channel access/);
  assert.equal(reads.length, 1);
  const [summary] = await discoveryRuns(db, who) as { id: string }[];
  const run = await discoveryRuns(db, who, summary.id) as { status: string; failedWhile: string; error: string; sources: string[]; sourceReads: { error?: string; count: number }[] };
  assert.equal(run.status, "failed");
  assert.equal(run.failedWhile, "reading");
  assert.deepEqual(run.sources, [`connection:${slack.id}`]);
  assert.equal(run.sourceReads[0].count, 0);
  assert.match(run.sourceReads[0].error ?? "", /No Slack channels selected/);
  assert.match(run.error, /Save channel access/);
});


test("selected Slack channels with no messages suggest a wider range without reporting missing access", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const { host, reads } = fakeHost(({ operation }) => operation === "channels.selected"
    ? { items: [{ id: "CGEN", name: "general" }], coverage: { outcome: "complete" } }
    : { items: [], coverage: { outcome: "complete" } });
  let refusal: Response | undefined;
  await assert.rejects(previewDiscovery(db, who, host, { sources: [`connection:${slack.id}`] }), (error: unknown) => {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 409);
    refusal = error;
    return true;
  });
  assert.ok(refusal);
  assert.match(await refusal.text(), /No source records found.*wider range/);
  assert.deepEqual(reads.map((read) => read.operation), ["channels.selected", "history.read"]);
  const [summary] = await discoveryRuns(db, who) as { id: string }[];
  const run = await discoveryRuns(db, who, summary.id) as { sourceReads: { error?: string; count: number; window: string }[] };
  assert.equal(run.sourceReads[0].error, undefined);
  assert.equal(run.sourceReads[0].count, 0);
  assert.match(run.sourceReads[0].window, /#general/);
});

test("a Slack huddle thread reads as its AI huddle notes, action items first, attendees as participants", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const huddle = {
    id: "slack:T1:CSTAND:1793898215.921579", sourceId: "slack:T1:CSTAND", timestamp: "1793898215.921579", authorId: "USLACKBOT", text: "A huddle started",
    threadId: "1793898215.921579", reference: "https://slack.com/app_redirect?team=T1&channel=CSTAND&message_ts=1793898215.921579",
  };
  const notes = [
    "# :headphones: Huddle notes: 11/5/26 in <#CSTAND>", "",
    "AI took notes for this huddle from **12:03:36 PM - 12:56:58 PM EST**.", "",
    "## :handshake: Attendees", "", "<@UALICE> and <@UDIMITRI>", "",
    "## :star: Summary", "", "* <@UDIMITRI> found holds and promotions drive behavior. [3:18][3:42]", "",
    "## :white_check_mark: Action items", "", "* [ ] <@UALICE> notify team before switching VPN to Tailscale. [49:19]", "", "---", "",
    "*This tool uses AI to generate notes, so some information may be inaccurate.*", "",
    "![F_TRANSCRIPT](https://acme.slack.com/files/USLACKBOT/F_TRANSCRIPT/huddle_transcript)",
  ].join("\n");
  const { host } = fakeHost(({ operation }) => {
    if (operation === "channels.selected") return { items: [{ id: "CSTAND", name: "standup" }], coverage: { outcome: "complete" }, userId: "UALICE" };
    if (operation === "thread.read") return {
      items: [huddle, { ...huddle, id: "slack:T1:CSTAND:1793901519.127689", timestamp: "1793901519.127689", text: "AI huddle notes are ready." }],
      coverage: { outcome: "complete" }, huddleNotes: { fileId: "F_NOTES", title: ":headphones: Huddle notes: 11/5/26 in <#CSTAND>", text: notes },
    };
    return { items: [huddle], coverage: { outcome: "complete" } };
  });
  const preview = await previewDiscovery(db, who, host, { sources: [`connection:${slack.id}`], range: "7d" });
  const [record] = preview.inputs ?? [];
  assert.equal(record.subject, "#standup: Huddle notes: 11/5/26");
  assert.match(record.excerpt, /Slack AI huddle notes/);
  assert.match(record.excerpt, /## Action items\n\n\* \[ \] @UALICE notify team before switching VPN to Tailscale\.\n\n## Attendees/);
  assert.match(record.excerpt, /@UDIMITRI found holds and promotions drive behavior\./);
  assert.doesNotMatch(record.excerpt, /\[3:18\]|:star:|This tool uses AI|huddle_transcript|AI huddle notes are ready|USLACKBOT/);
  assert.match(record.excerpt, /12:03:36 PM/, "clock times are not emoji codes");
  assert.match(record.excerpt, /UDIMITRI \(Slack/);
});

test("a huddle whose notes Slack would not lend says to reconnect Slack", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const huddle = {
    id: "slack:T1:CSTAND:1793898215.921579", sourceId: "slack:T1:CSTAND", timestamp: "1793898215.921579", authorId: "USLACKBOT", text: "A huddle started",
    threadId: "1793898215.921579", reference: "https://slack.com/app_redirect?team=T1&channel=CSTAND&message_ts=1793898215.921579",
  };
  const { host } = fakeHost(({ operation }) => {
    if (operation === "channels.selected") return { items: [{ id: "CSTAND", name: "standup" }], coverage: { outcome: "complete" }, userId: "UALICE" };
    if (operation === "thread.read") return { items: [huddle], coverage: { outcome: "complete" }, huddleNotes: { fileId: "F_NOTES", unavailable: "missing_scope" } };
    return { items: [huddle], coverage: { outcome: "complete" } };
  });
  const preview = await previewDiscovery(db, who, host, { sources: [`connection:${slack.id}`], range: "7d" });
  assert.match(preview.inputs?.[0].excerpt ?? "", /Huddle notes not read: reconnect Slack to grant file access\./);
});
