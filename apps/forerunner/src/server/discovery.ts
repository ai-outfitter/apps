import { graphMutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import type { EvidenceItem } from "@ai-outfitter/app-sdk/evidence";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-graphql";
import {
  type AppIdentity,
  requireEditor,
  sha256Hex,
} from "@ai-outfitter/app-sdk/server";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { wikiChangeDocuments } from "@ai-outfitter/app-sdk/graph-contracts";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { DISCOVERY_PREVIEW_VERSION } from "../discovery-version";
import { discoveryOntology } from "./discovery-ontology";
import type { Database } from "./items";
import { generateSuggestions, skipSuggestions } from "./suggestions";
import { discoveryRecords } from "./schema";
import { type RunInput, semanticProposal } from "./semantic-discovery";

const sourceRecord = z.strictObject({
  id: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  text: z.string().max(4000).default(""),
  date: z.string().max(100),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  participants: z.array(z.string().max(300)).max(30).default([]),
  /** The citation's record id when it differs from `id`'s source identity (docs/architecture/evidence.md). */
  recordId: z.string().min(1).max(500).optional(),
  /** The provider's version of a record that changes, such as an issue's last update. */
  version: z.string().min(1).max(200).optional(),
});
export const sourceSample = z.strictObject({
  format: z.literal("outfitter-forerunner-sample-v1"),
  provider: z.enum(["gmail", "google-calendar", "github", "slack"]),
  account: z.string().min(1).max(254),
  accountId: z.string().min(1).max(300).optional(),
  collectedAt: z.iso.datetime(),
  window: z.string().min(1).max(300),
  collectionMethod: z.literal("agent-import"),
  records: z.array(sourceRecord).max(25),
});
export const importInput = z.strictObject({
  samples: z.array(sourceSample).min(1).max(8),
});
export const timezone = z.string().min(1).max(64).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "Unknown time zone");
/** How far back a run reads each direct connection. `all` continues where the last `all` run stopped. */
export const discoveryRanges = ["since-last", "7d", "30d", "all"] as const;
export type DiscoveryRange = (typeof discoveryRanges)[number];
export const previewInput = z.strictObject({
  sources: z.array(z.string().min(1).max(200)).min(1).max(4),
  range: z.enum(discoveryRanges).optional(),
  timezone: timezone.optional(),
});
/** Records one run reads in all, split across its sources: the model reads at most this many. */
export const runRecordLimit = 40;
const day = 86_400_000;
/** The window a direct connection is read in, and where an `all` run continues next. */
type Window = { from?: string; to?: string };
type SourceRead = { connectionId: string; range: DiscoveryRange; from?: string; to?: string; more: boolean; next?: Window };
export const saveInput = z.strictObject({
  previewId: z.uuid(),
  confirmDestination: z.literal(true),
  /** The reviewer's time zone; the review window closes at their end of day. */
  timezone: timezone.optional(),
});
/** Proposals at or above this confidence commit without waiting for review. */
export const autoAcceptThreshold = 0.95;
export const discoveryPolicyVersion = "forerunner-discovery-2026-11";
type Sample = z.infer<typeof sourceSample>;
type Host = WorkflowHost<"interactive">;
export type Operation = {
  operation: "create";
  ref: string;
  type: "graph-type" | "graph-node" | "graph-edge";
  attributes: Record<string, z.infer<ReturnType<typeof z.json>>>;
};
export type Proposal = { ref: string; evidence: EvidenceItem[]; confidence: number; reason: string };
export type Preview = {
  version: typeof DISCOVERY_PREVIEW_VERSION;
  systemPrompt: string;
  warnings: string[];
  id: string;
  createdAt: string;
  wikiInstallationId: string;
  /** The Wiki's address segment, `/apps/<slug>/` for a personal Wiki. */
  wikiSlug: string;
  destination: "personal" | "organization";
  sources: ({
    label: string;
    count: number;
    method: string;
    window: string;
    error?: string;
  } & Partial<SourceRead>)[];
  entries: {
    id?: string;
    typeId?: string;
    /** Exact namespaced answer keys that resolve to this entry; absent on older previews. */
    modelKeys?: string[];
    matchedId?: string;
    matchedTitle?: string;
    title: string;
    kind: string;
    existing: boolean;
    excerpt: string;
    url?: string;
  }[];
  operations: Operation[];
  /** Evidence, confidence and reason for each operation, by ref. */
  proposals?: Proposal[];
  /** Every record the model read, under the ref its answer cites. Older previews have none. */
  inputs?: RunInput[];
  /** The Wiki change batch this preview was saved into. */
  batch?: { installationId: string; batchId: string; policy: "first-run" | "confidence" };
  receipt?: unknown;
  savedAt?: string;
  evaluations?: { id: string; at: string; rating: "useful" | "mixed" | "not-useful" | "corrected"; note: string; entryIndex?: number; fromId?: string; targetId?: string }[];
};
const scope = (who: AppIdentity) =>
  and(
    eq(discoveryRecords.installationId, who.installationId),
    eq(discoveryRecords.ownerId, who.userId),
  );
async function own(
  db: Database,
  who: AppIdentity,
  id: string,
  kind: "sample" | "preview" | "run",
) {
  const [record] = await db
    .select()
    .from(discoveryRecords)
    .where(
      and(
        scope(who),
        eq(discoveryRecords.id, id),
        eq(discoveryRecords.kind, kind),
      ),
    );
  if (!record)
    throw new Response("Discovery record not found", { status: 404 });
  return record;
}
export async function stableId(value: string) {
  const hash = await sha256Hex(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export async function importSamples(
  db: Database,
  who: AppIdentity,
  input: z.infer<typeof importInput>,
) {
  requireEditor(who);
  const ids = [];
  for (const sample of input.samples) {
    const id = await stableId(
      JSON.stringify([
        who.installationId,
        who.userId,
        sample.provider,
        sample.account,
        sample.collectedAt,
      ]),
    );
    await db
      .insert(discoveryRecords)
      .values({
        id,
        installationId: who.installationId,
        ownerId: who.userId,
        kind: "sample",
        data: JSON.stringify(sample),
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
    const saved = await own(db, who, id, "sample");
    if (saved.data !== JSON.stringify(sample))
      throw new Response(
        "This sample capture already exists with different content. Use a new collection time for a new capture.",
        { status: 409 },
      );
    ids.push(id);
  }
  return { imported: ids.length };
}
/** The direct connections discovery reads, by provider, and the operations each needs. */
export const discoveryProviders = {
  gmail: { name: "Gmail", operations: ["messages.list", "messages.get"] },
  "google-calendar": { name: "Google Calendar", operations: ["events.list"] },
  github: { name: "GitHub", operations: ["activity.read"] },
  slack: { name: "Slack", operations: ["channels.selected", "history.read", "thread.read"] },
} as const;
export type DiscoveryProvider = keyof typeof discoveryProviders;
const isProvider = (provider: string): provider is DiscoveryProvider => Object.hasOwn(discoveryProviders, provider);
export const providerName = (provider: string) => (isProvider(provider) ? discoveryProviders[provider].name : provider);
/** Whether discovery can read a direct connection: one of its providers with every operation it needs. */
export function readableConnection(c: { provider: string; resource?: string | null; operations: string[] }) {
  return Boolean(c.resource) && isProvider(c.provider) &&
    discoveryProviders[c.provider].operations.every((operation) => c.operations.includes(operation));
}
export async function discoverySources(
  db: Database,
  who: AppIdentity,
  host: Host,
) {
  requireEditor(who);
  const rows = await db
    .select()
    .from(discoveryRecords)
    .where(and(scope(who), eq(discoveryRecords.kind, "sample")))
    .orderBy(desc(discoveryRecords.createdAt))
    .limit(32);
  const samples = rows.map((row) => {
    const sample = sourceSample.parse(JSON.parse(row.data));
    return {
      id: `sample:${row.id}`,
      provider: sample.provider,
      label: `${providerName(sample.provider)} · ${sample.account}`,
      method: "Saved agent sample",
      detail: `${sample.records.length} records · ${sample.window} · collected ${sample.collectedAt}`,
    };
  });
  const snapshot = await host.call("snapshot", {});
  const direct = snapshot.connections
    .filter(readableConnection)
    .map((c) => ({
      id: `connection:${c.id}`,
      provider: c.provider,
      label: `${providerName(c.provider)} · ${c.label || c.resource}`,
      method: "Direct connection",
      detail: `Up to ${runRecordLimit} records a run, since the last run by default${c.provider === "google-calendar" ? "; the primary calendar also reads the next 14 days" : ""}`,
    }));
  const last = await lastRuns(db, who, direct.map((source) => source.id.slice(11)));
  return {
    sources: [...direct.map((source) => ({ ...source, lastRunAt: last[source.id.slice(11)] })), ...samples],
    destination: who.owner.kind === "user" ? "personal" : "organization",
  };
}
/** A direct connection as discovery reads it. */
export type SourceConnection = { id: string; provider: string; resource: string | null; label?: string | null };
async function readSource(
  db: Database,
  who: AppIdentity,
  host: Host,
  key: string,
  known?: SourceConnection,
  options?: { range: DiscoveryRange; window: Window; limit: number },
): Promise<
  Omit<Sample, "collectionMethod"> & {
    collectionMethod: "agent-import" | "direct-connector";
    read?: SourceRead;
  }
> {
  if (key.startsWith("sample:"))
    return sourceSample.parse(
      JSON.parse((await own(db, who, key.slice(7), "sample")).data),
    );
  if (!key.startsWith("connection:"))
    throw new Response("Choose an available source", { status: 400 });
  // A scheduled run names its one connection; the schedule phase has no snapshot.
  const connection = known && key === `connection:${known.id}`
    ? known
    : (await host.call("snapshot", {})).connections.find((c) => c.id === key.slice(11));
  if (!connection?.resource || !isProvider(connection.provider))
    throw new Response("Source is no longer available", { status: 409 });
  const resource = connection.resource;
  const execute = (operation: string, input: Record<string, string | number>) =>
    host.call("connector.execute", {
      connectionId: connection.id,
      resource,
      operation,
      input,
    });
  const plan = options ?? { range: "since-last" as const, window: { from: new Date(Date.now() - 14 * day).toISOString() }, limit: 10 };
  const readers = { gmail: readGmail, "google-calendar": readCalendar, github: readGithub, slack: readSlack };
  const read = await readers[connection.provider](execute, plan);
  return {
    format: "outfitter-forerunner-sample-v1",
    provider: connection.provider as Sample["provider"],
    account: connection.label || connection.resource,
    accountId: connection.resource,
    collectedAt: new Date().toISOString(),
    collectionMethod: "direct-connector",
    window: read.window,
    records: read.records,
    read: { connectionId: connection.id, range: plan.range, ...plan.window, more: read.more, ...(read.next ? { next: read.next } : {}) } satisfies SourceRead,
  };
}
type Execute = (operation: string, input: Record<string, string | number>) => Promise<unknown>;
type Plan = { range: DiscoveryRange; window: Window; limit: number };
type Read = { records: z.infer<typeof sourceRecord>[]; more: boolean; next?: Window; window: string };
/** Gmail, newest first: an `all` run continues before the oldest message it read. */
async function readGmail(execute: Execute, plan: Plan): Promise<Read> {
  const { from, to } = plan.window;
  const records: z.infer<typeof sourceRecord>[] = [];
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const query = ["-in:spam -in:trash -category:promotions", from && `after:${seconds(from)}`, to && `before:${seconds(to)}`].filter(Boolean).join(" ");
  const listed = z
    .object({ messages: z.array(z.object({ id: z.string() })), cursor: z.string().nullable().optional() })
    .parse(await execute("messages.list", { query, maxResults: plan.limit }));
  for (const item of listed.messages.slice(0, plan.limit)) {
    const message = z
      .object({
        id: z.string(),
        subject: z.string(),
        snippet: z.string(),
        from: z.string(),
        date: z.string(),
        text: z.string().nullable().optional(),
      })
      .parse(
        // The full message: its decoded plain-text body, not only the preview snippet.
        await execute("messages.get", { id: item.id, format: "full" }),
      );
    records.push({
      id: message.id,
      title: message.subject || "Untitled message",
      text: emailText(message.text, message.snippet),
      date: message.date,
      url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
      participants: [message.from].filter(Boolean),
    });
  }
  const more = Boolean(listed.cursor) || listed.messages.length > plan.limit;
  const oldest = Math.min(...records.map((r) => Date.parse(r.date)).filter(Number.isFinite));
  const next = more && Number.isFinite(oldest) ? { ...(from ? { from } : {}), to: new Date(oldest).toISOString() } : undefined;
  const window = `${from ? from.slice(0, 10) : "All mail"} to ${to ? to.slice(0, 10) : "now"}; at most ${plan.limit} messages`;
  return { records, more, next, window };
}
/**
 * What the agent reads of an email: its plain-text body without the quoted
 * thread under a reply, else the snippet (HTML-only mail has no text part).
 */
export function emailText(body: string | null | undefined, snippet: string) {
  const lines = (body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const quoted = (i: number) =>
    /^On .+wrote:\s*$/.test(lines[i]) ||
    /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(lines[i]) ||
    // Outlook-style "From: … Sent: … Subject:" header block.
    (/^From: /.test(lines[i]) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date|Subject): /.test(l))) ||
    lines.slice(i).every((l) => /^>/.test(l) || !l.trim());
  const cut = lines.findIndex((line, i) => i > 0 && line.trim() !== "" && quoted(i));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return (kept || snippet).slice(0, 4000);
}
/** Calendar, oldest first through the next 14 days: an `all` run continues after the last event it read. */
async function readCalendar(execute: Execute, plan: Plan): Promise<Read> {
  const { from, to } = plan.window;
  const records: z.infer<typeof sourceRecord>[] = [];
  // Everything, for a calendar, starts five years back.
  const timeMin = from ?? new Date(Date.now() - (plan.range === "all" ? 5 * 365 : 14) * day).toISOString(),
    timeMax = to ?? new Date(Date.now() + 14 * day).toISOString();
  let cursor: string | undefined;
  let more = false;
  do {
    const listed = calendarPage.parse(await execute("events.list", {
      calendarId: "primary", timeMin, timeMax,
      maxResults: Math.min(25, plan.limit - records.length + 1),
      ...(cursor ? { cursor } : {}),
    }));
    const room = plan.limit - records.length;
    records.push(...listed.items.slice(0, room).map(eventRecord));
    cursor = listed.nextPageToken;
    more = listed.items.length > room || (records.length === plan.limit && Boolean(cursor));
  } while (cursor && !more);
  const last = Date.parse(records.at(-1)?.date ?? "");
  const next = more && Number.isFinite(last) ? { from: new Date(last).toISOString(), ...(to ? { to } : {}) } : undefined;
  const window = `${timeMin.slice(0, 10)} to ${timeMax.slice(0, 10)}; primary calendar; at most ${plan.limit} events`;
  return { records, more, next, window };
}
const calendarEvent = z.object({
  id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  htmlLink: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  organizer: z.object({ email: z.string().optional() }).optional(),
});
const calendarPage = z.object({ items: z.array(calendarEvent), nextPageToken: z.string().optional() });
const eventRecord = (e: z.infer<typeof calendarEvent>) => ({
  id: e.id,
  title: e.summary || "Untitled event",
  text: (e.description ?? "").slice(0, 4000),
  date: e.start.dateTime ?? e.start.date ?? "",
  url: e.htmlLink,
  participants: e.organizer?.email ? [e.organizer.email] : [],
});
const githubActivity = z.object({
  login: z.string(),
  items: z.array(z.object({
    repository: z.string(),
    kind: z.enum(["issue", "pull-request"]),
    number: z.number(),
    title: z.string(),
    state: z.string(),
    url: z.string(),
    updatedAt: z.string(),
    author: z.string().nullable(),
    assignees: z.array(z.string()).default([]),
    body: z.string(),
    comments: z.array(z.object({ author: z.string().nullable(), createdAt: z.string(), body: z.string() })).default([]),
    commentCount: z.number().default(0),
  })),
  more: z.boolean(),
});
type GithubItem = z.infer<typeof githubActivity>["items"][number];
/** GitHub, newest update first: issues and pull requests the member is involved in. An `all` run continues before the oldest it read. */
async function readGithub(execute: Execute, plan: Plan): Promise<Read> {
  const { from, to } = plan.window;
  const perPage = Math.min(25, plan.limit);
  const items: GithubItem[] = [];
  let login = "";
  let more = true;
  for (let page = 1; more && items.length < plan.limit && page <= 4; page++) {
    const listed = githubActivity.parse(await execute("activity.read", {
      ...(from ? { since: from } : {}), ...(to ? { until: to } : {}), limit: perPage, page,
    }));
    items.push(...listed.items);
    login = listed.login;
    more = listed.more;
    if (listed.items.length < perPage) break;
  }
  const kept = items.slice(0, plan.limit);
  more ||= items.length > plan.limit;
  const oldest = Math.min(...kept.map((item) => Date.parse(item.updatedAt)).filter(Number.isFinite));
  const next = more && Number.isFinite(oldest) ? { ...(from ? { from } : {}), to: new Date(oldest).toISOString() } : undefined;
  const window = `${from ? from.slice(0, 10) : "All activity"} to ${to ? to.slice(0, 10) : "now"}; issues and pull requests you are involved in; at most ${plan.limit}`;
  return { records: kept.map((item) => githubRecord(item, login)), more, next, window };
}
/** Markdown as the agent reads it: without HTML comments, such as pull request template guidance. */
const markdown = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const recordText = 4000;
/** The description in full, then the newest comments, while they fit what one record carries. */
export function githubText(item: GithubItem) {
  const kind = item.kind === "pull-request" ? "Pull request" : "Issue";
  const head = `${kind} in ${item.repository}, ${item.state}${item.author ? `, opened by @${item.author}` : ""}${item.assignees.length ? `, assigned to ${item.assignees.map((a) => `@${a}`).join(", ")}` : ""}.`;
  const comments = [...item.comments].reverse().map((c) => `@${c.author ?? "ghost"} (${c.createdAt.slice(0, 10)}): ${markdown(c.body)}`).filter((c) => !c.endsWith(": "));
  const body = markdown(item.body);
  // With comments, the description leaves room for at least the newest.
  let text = `${head}\n\n${comments.length ? body.slice(0, 2400) : body}`.trim();
  if (comments.length) {
    text += `\n\nNewest comments (${comments.length} of ${item.commentCount}), newest first:`;
    for (const c of comments) {
      if (text.length + c.length + 2 > recordText) break;
      text += `\n\n${c}`;
    }
  }
  return text.slice(0, recordText);
}
/** How a participant reads to the agent; the member's own account says so. */
const participant = (handle: string, provider: string, own: string) => `@${handle} (${provider}${handle === own ? ", the operating user's own account" : ""})`;
function githubRecord(item: GithubItem, login: string): z.infer<typeof sourceRecord> {
  // The citation convention of docs/architecture/evidence.md: owner/repo/pull/N or owner/repo/issues/N.
  const id = `${item.repository}/${item.kind === "pull-request" ? "pull" : "issues"}/${item.number}`;
  const people = [item.author, ...item.assignees, ...item.comments.map((c) => c.author)].filter((p): p is string => Boolean(p));
  return {
    id, recordId: id, version: item.updatedAt,
    title: `${item.repository}#${item.number}: ${item.title}`.slice(0, 500),
    text: githubText(item),
    date: item.updatedAt,
    url: /^https:\/\/github\.com\//.test(item.url) ? item.url : undefined,
    participants: [...new Set(people)].slice(0, 30).map((handle) => participant(handle, "GitHub", login)),
  };
}

const slackMessage = z.object({
  id: z.string(),
  timestamp: z.string(),
  authorId: z.string().nullable(),
  text: z.string(),
  threadId: z.string().nullable(),
  reference: z.string(),
});
const huddleNotes = z.union([
  z.object({ fileId: z.string(), title: z.string(), text: z.string() }),
  z.object({ fileId: z.string(), unavailable: z.string() }),
]);
const slackPage = z.object({ items: z.array(slackMessage), coverage: z.object({ outcome: z.string() }).loose(), huddleNotes: huddleNotes.optional() });
type HuddleNotes = z.infer<typeof huddleNotes>;
const slackChannels = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })), userId: z.string().default("") });
type SlackMessage = z.infer<typeof slackMessage> & { channel: { id: string; name: string } };
/** Channel joins and leaves say nothing about anyone's life. */
const meaningful = (m: { text: string }) => m.text.trim() !== "" && !/^<@[A-Z0-9]+> has (joined|left) the channel$/.test(m.text.trim());
/** Slack markup as plain text: `<url|label>` reads as "label (url)", a mention as @U123. */
export const slackText = (text: string) =>
  text.replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, "@$1").replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const slackSeconds = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);
/**
 * Slack, newest first across the member's selected public channels, each
 * thread with its replies. An `all` run continues before the oldest message
 * it read, or before a busier channel's oldest when that one had more.
 */
async function readSlack(execute: Execute, plan: Plan): Promise<Read> {
  const { from, to } = plan.window;
  const selected = slackChannels.parse(await execute("channels.selected", {}));
  if (!selected.items.length)
    throw new Response("No Slack channels selected. Open Profile, choose Manage for Slack, select public channels, and click Save channel access before running discovery again.", { status: 409 });
  const channels = selected.items.slice(0, 10);
  const { messages, unfinished } = await slackHistory(execute, channels, plan.window);
  const kept = messages.slice(0, plan.limit);
  const records: z.infer<typeof sourceRecord>[] = [];
  for (const message of kept) {
    const { replies, notes } = await slackReplies(execute, message);
    records.push(slackRecord(message, replies, selected.userId, notes));
  }
  const more = messages.length > plan.limit || unfinished.length > 0;
  const cutoff = Math.max(...[Number(kept.at(-1)?.timestamp), ...unfinished].filter(Number.isFinite));
  const next = more && Number.isFinite(cutoff) ? { ...(from ? { from } : {}), to: new Date(cutoff * 1000).toISOString() } : undefined;
  const names = channels.map((c) => `#${c.name}`).join(", ") || "no channels selected";
  const window = `${from ? from.slice(0, 10) : "All messages"} to ${to ? to.slice(0, 10) : "now"}; ${names}; at most ${plan.limit} messages with their threads`;
  return { records, more, next, window };
}
/** Each channel's newest page in the window, merged newest first; `unfinished` holds the oldest read of each channel with more. */
async function slackHistory(execute: Execute, channels: { id: string; name: string }[], { from, to }: Window) {
  const messages: SlackMessage[] = [];
  const unfinished: number[] = [];
  for (const channel of channels) {
    const page = slackPage.parse(await execute("history.read", {
      channel: channel.id, ...(from ? { oldest: slackSeconds(from) } : {}), ...(to ? { latest: slackSeconds(to) } : {}), maxPages: 1,
    }));
    if (page.coverage.outcome !== "complete") unfinished.push(Math.min(...page.items.map((m) => Number(m.timestamp))));
    messages.push(...page.items.filter(meaningful).map((m) => ({ ...m, channel })));
  }
  messages.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return { messages, unfinished };
}
/** A thread parent's replies and a huddle's AI notes; none for a message without a thread. */
async function slackReplies(execute: Execute, message: SlackMessage) {
  if (message.threadId !== message.timestamp) return { replies: [] };
  const thread = slackPage.parse(await execute("thread.read", { channel: message.channel.id, thread: message.timestamp, maxPages: 1 }));
  return { replies: thread.items.filter((r) => r.timestamp !== message.timestamp && meaningful(r)), notes: thread.huddleNotes };
}
const emojiCode = /:[a-z][a-z0-9_+-]*:\s*/g;
/**
 * Slack's AI huddle notes as evidence text: mentions as @U123, without the
 * transcript timestamps, emoji codes, embedded files or Slack's AI disclaimer,
 * action items first so they survive the analysis excerpt.
 */
export function huddleNotesText(notes: string) {
  const text = slackText(notes)
    .replace(/\[\d{1,2}:\d{2}(:\d{2})?\]/g, "")
    .replace(emojiCode, "")
    .replace(/!\[[^\]]*\]\([^)]*\)|\[\]\([^)]*\)/g, "")
    .replace(/^\*?This tool uses AI to generate notes[^\n]*$/gim, "")
    .replace(/^\s*---\s*$/gm, "")
    .replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  const sections = text.split(/\n(?=## )/);
  const actions = sections.findIndex((section) => /^## Action items/i.test(section));
  if (actions > 0) sections.splice(1, 0, ...sections.splice(actions, 1));
  return sections.map((section) => section.trim()).join("\n\n");
}
/** A huddle thread as its AI notes; a huddle whose notes could not be read says why. */
function huddleRecord(message: SlackMessage, notes: HuddleNotes): { text?: string; title?: string; attendees?: string[]; note?: string } {
  if (!("text" in notes)) {
    const why = notes.unavailable === "missing_scope" ? "reconnect Slack to grant file access" : "Slack did not return them";
    return { note: `\n\nHuddle notes not read: ${why}.` };
  }
  const text = huddleNotesText(notes.text);
  return {
    text: `In #${message.channel.name}: Slack AI huddle notes.\n\n${text}`,
    title: slackText(notes.title).replace(emojiCode, "").replace(/\s+in\s+#?\S*$/, "").trim(),
    attendees: [...text.matchAll(/@(U[A-Z0-9]+)/g)].map((m) => m[1]),
  };
}
function slackRecord(message: SlackMessage, replies: z.infer<typeof slackMessage>[], self: string, notes?: HuddleNotes): z.infer<typeof sourceRecord> {
  // The citation convention of docs/architecture/evidence.md: TEAM/CHANNEL/TS.
  const [, team, channel, ts] = message.id.split(":");
  const line = (m: { authorId: string | null; text: string }) => `@${m.authorId ?? "unknown"}: ${slackText(m.text)}`;
  // A huddle's thread is Slackbot's; its notes are what the huddle said.
  const huddle: ReturnType<typeof huddleRecord> = notes ? huddleRecord(message, notes) : {};
  const shown = huddle.text ? [] : replies;
  let text = huddle.text ?? `In #${message.channel.name}.\n\n${line(message)}${huddle.note ?? ""}`;
  if (shown.length) {
    text += `\n\nReplies (${shown.length}):`;
    for (const reply of shown) {
      const next = line(reply);
      if (text.length + next.length + 2 > recordText) break;
      text += `\n\n${next}`;
    }
  }
  const first = huddle.title ?? slackText(message.text).split("\n")[0].slice(0, 120);
  const people = [...(huddle.attendees ?? [message.authorId]), ...shown.map((r) => r.authorId)];
  return {
    id: `${team}/${channel}/${ts}`, recordId: `${team}/${channel}/${ts}`,
    title: `#${message.channel.name}: ${first || "Message"}`.slice(0, 500),
    text: text.slice(0, recordText),
    date: new Date(Number(message.timestamp) * 1000).toISOString(),
    url: /^https:\/\/slack\.com\//.test(message.reference) ? message.reference : undefined,
    participants: [...new Set(people.filter((p): p is string => Boolean(p)))].slice(0, 30).map((id) => participant(id, "Slack", self)),
  };
}
async function sourceFailure(
  key: string,
  error: unknown,
): Promise<Preview["sources"][number]> {
  const imported = key.startsWith("sample:");
  return {
    label: imported ? "Saved source sample" : "Selected connection",
    count: 0,
    method: imported ? "agent-import" : "direct-connector",
    window: "Not read",
    error:
      error instanceof Response
        ? await error.text()
        : "Source read failed; retry the preview.",
  };
}
async function prepareDiscovery(
  db: Database,
  who: AppIdentity,
  host: Host,
  input: z.input<typeof previewInput>,
  diagnostic: (event: Record<string, unknown>) => Promise<void>,
  options: RunOptions = {},
) {
  requireEditor(who);
  await diagnostic({ status: "preparing" });
  const user = await host.call("identity.current", {});
  const graph = await readWikiGraph(host);
  const ontology = discoveryOntology(graph);
  await diagnostic({ status: "reading", identity: user, wikiInstallationId: graph.wiki.installationId, ontology });
  if (!graph.wiki.writable)
    throw new Response("Your Wiki must be writable to preview discovery", {
      status: 403,
    });
  const sources: Preview["sources"] = [];
  const samples: Awaited<ReturnType<typeof readSource>>[] = [];
  const keys = [...new Set(input.sources)];
  const range = input.range ?? "since-last";
  const limit = Math.max(1, Math.floor(runRecordLimit / keys.length));
  for (const key of keys) {
    let sample: Awaited<ReturnType<typeof readSource>>;
    try {
      const window = key.startsWith("connection:") ? await readWindow(db, who, key.slice(11), range) : {};
      sample = await readSource(db, who, host, key, options.connection, { range, window, limit });
    } catch (error) {
      sources.push(await sourceFailure(key, error));
      continue;
    }
    sources.push({
      label: `${sample.provider} · ${sample.account}`,
      count: sample.records.length,
      method: sample.collectionMethod,
      window: sample.window,
      ...sample.read,
    });
    samples.push(sample);
  }
  await diagnostic({ status: "reading", sourceReads: sources });
  if (!samples.some((s) => s.records.length)) {
    const failures = sources.flatMap((source) => source.error ? [source.error] : []);
    throw new Response(failures.join(" ") || "No source records found in the selected range. Try a wider range or check the selected connections.", { status: 409 });
  }
  const { operations, entries, proposals, inputs, systemPrompt, warnings } = await semanticProposal(host, graph, samples, ontology, user, diagnostic, { runId: options.runId, taskId: options.taskId, selection:{request:input,sourceReads:sources} });
  const preview: Preview = {
    version: DISCOVERY_PREVIEW_VERSION,
    systemPrompt,
    warnings,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    wikiInstallationId: graph.wiki.installationId,
    wikiSlug: graph.wiki.slug,
    destination: who.owner.kind === "user" ? "personal" : "organization",
    sources,
    entries,
    operations,
    proposals,
    inputs,
  };
  await db.insert(discoveryRecords).values({
    id: preview.id,
    installationId: who.installationId,
    ownerId: who.userId,
    kind: "preview",
    data: JSON.stringify(preview),
    createdAt: Date.now(),
  });
  await diagnostic({ status: "complete", previewId: preview.id, operations, warnings, systemPrompt });
  return preview;
}
/** Recent runs' reads of one connection, newest first. */
async function connectionReads(db: Database, who: AppIdentity, connectionId: string) {
  const rows = await db.select({ data: discoveryRecords.data, createdAt: discoveryRecords.createdAt }).from(discoveryRecords)
    .where(and(scope(who), eq(discoveryRecords.kind, "preview"))).orderBy(desc(discoveryRecords.createdAt)).limit(60);
  return rows.flatMap((row) => {
    const preview = JSON.parse(row.data) as Preview;
    const read = preview.sources.find((s) => s.connectionId === connectionId && !s.error);
    return read ? [{ at: preview.createdAt, read }] : [];
  });
}
/** Where a run of `range` reads this connection from: since the last run (else 14 days), a fixed
 * number of days, or everything, continuing where the last unfinished `all` run stopped. */
async function readWindow(db: Database, who: AppIdentity, connectionId: string, range: DiscoveryRange): Promise<Window> {
  const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
  if (range === "7d") return { from: ago(7) };
  if (range === "30d") return { from: ago(30) };
  const reads = await connectionReads(db, who, connectionId);
  if (range === "since-last") return { from: reads[0]?.at ?? ago(14) };
  const last = reads.find((r) => r.read.range === "all")?.read;
  return last?.more && last.next ? last.next : {};
}
/** When each direct connection was last read by a run. */
export async function lastRuns(db: Database, who: AppIdentity, connectionIds: string[]) {
  return Object.fromEntries(await Promise.all(connectionIds.map(async (id) => [id, (await connectionReads(db, who, id))[0]?.at ?? null] as const)));
}
export async function getPreview(
  db: Database,
  who: AppIdentity,
  id?: string,
): Promise<Preview | null> {
  if (id) return JSON.parse((await own(db, who, id, "preview")).data);
  const [row] = await db
    .select()
    .from(discoveryRecords)
    .where(and(scope(who), eq(discoveryRecords.kind, "preview")))
    .orderBy(desc(discoveryRecords.createdAt))
    .limit(1);
  return row ? JSON.parse(row.data) : null;
}
export async function saveDiscovery(
  db: Database,
  who: AppIdentity,
  host: Host,
  input: z.infer<typeof saveInput>,
) {
  requireEditor(who);
  const preview = await getPreview(db, who, input.previewId);
  if (!preview) throw new Response("Preview not found", { status: 404 });
  if (preview.version !== DISCOVERY_PREVIEW_VERSION)
    throw new Response("Run a new semantic preview before saving this older preview", { status: 409 });
  if (preview.receipt) return preview;
  preview.receipt = preview.operations.length ? await saveBatch(db, who, host, preview, input.timezone ?? "UTC") : {};
  preview.savedAt = new Date().toISOString();
  await db
    .update(discoveryRecords)
    .set({ data: JSON.stringify(preview) })
    .where(and(scope(who), eq(discoveryRecords.id, preview.id)));
  return preview;
}

type Batch = {
  batch: { id: string; state: string; reviewBy: number | null };
  counts: Record<string, number>;
  operations?: { ref: string; state: string; operation: { attributes?: Record<string, unknown> } }[];
};
/** The saved batch; `waiting` lists the record ids still awaiting review. */
type Saved = { batchId: string; state: string; reviewBy: number | null; counts: Record<string, number>; waiting: string[] };

/**
 * Saves a preview as one Wiki change batch. The first discovery run creates
 * everything; later runs commit confident proposals and leave the rest for
 * review until the reviewer's end of day (docs/plans/wiki-change-batches.md).
 */
async function saveBatch(db: Database, who: AppIdentity, host: Host, preview: Preview, timezone: string): Promise<Saved> {
  const call: BatchCall = async (action, input) =>
    (await host.call("actions.call", { installationId: preview.wikiInstallationId, action, input: input as never })) as unknown as Batch;
  let current = preview.batch ? await call("batch.get", { batchId: preview.batch.batchId }) : null;
  // A batch left open past its expiry was discarded with nothing written: start again.
  if (!current || current.batch.state === "discarded") {
    const opened = await openBatch(db, who, call, preview, timezone);
    preview.batch = { installationId: preview.wikiInstallationId, batchId: opened.batch.id, policy: opened.policy };
    await updatePreview(db, who, preview);
    current = opened;
  }
  const batchId = current.batch.id;
  if (current.batch.state === "open") {
    const meta = new Map((preview.proposals ?? []).map((p) => [p.ref, p]));
    const proposal = (operation: Operation) => {
      const p = meta.get(operation.ref);
      return { operation, evidence: p?.evidence ?? [], ...(p ? { confidence: p.confidence, reason: p.reason.slice(0, 1000) } : {}) };
    };
    const byRef = new Map(preview.operations.map((operation) => [operation.ref, operation]));
    // The same mutation documents chat agents run, so both stage alike.
    for (let i = 0; i < preview.operations.length; i += 100)
      await mutate(host, preview.wikiInstallationId, "StageChanges", { batchId, proposals: preview.operations.slice(i, i + 100).map(proposal) });
    const { submitBatch } = await mutate(host, preview.wikiInstallationId, "SubmitBatch", { batchId, summary: batchSummary(preview) });
    current = { batch: { id: batchId, state: submitBatch.state, reviewBy: submitBatch.reviewBy === null ? null : Date.parse(submitBatch.reviewBy) },
      counts: submitBatch.counts, operations: (submitBatch.operations ?? []).map((op) => ({ ...op, operation: byRef.get(op.ref) ?? {} })) };
  }
  const waiting = (current.operations ?? []).filter((op) => op.state === "awaiting_review").map((op) => String(op.operation.attributes?.id ?? op.ref));
  return { batchId, state: current.batch.state, reviewBy: current.batch.reviewBy, counts: current.counts, waiting };
}
type BatchCall = (action: string, input: Record<string, unknown>) => Promise<Batch>;

/** Run one of the Wiki's change-batch documents over its graph.mutate action; a refusal throws with its status. */
async function mutate(host: Host, installationId: string, name: "StageChanges" | "SubmitBatch", input: Record<string, unknown>) {
  const result = graphGraphqlResult.parse(await host.call("actions.call", {
    installationId, action: graphMutateAction,
    input: { query: wikiChangeDocuments[name].document, operationName: name, variables: { input } } as never,
  }));
  const error = result.errors?.[0];
  if (error || result.data === null) throw new Response(error?.message ?? `${name} returned no data`, { status: Number(error?.extensions?.status ?? 422) });
  return result.data as Record<string, BatchView>;
}
type BatchView = { id: string; state: string; reviewBy: string | null; counts: Record<string, number>; operations?: { ref: string; state: string }[] };

/** The member's first saved run creates everything; later runs wait for review by end of day. */
async function openBatch(db: Database, who: AppIdentity, call: BatchCall, preview: Preview, timezone: string) {
  const source = { kind: "discovery-run", ref: preview.id, label: "Forerunner discovery" };
  const title = `Discovery ${preview.createdAt.slice(0, 10)}`;
  if (!(await savedBefore(db, who, preview.id))) {
    try {
      const opened = await call("batch.open", { title: `First ${title.toLowerCase()}`, purpose: "What Forerunner found on its first run.", source, policy: { kind: "first-run", version: discoveryPolicyVersion } });
      return { ...opened, policy: "first-run" as const };
    } catch (error) {
      // The Wiki already has a discovery run, perhaps another member's.
      if (!(error instanceof Response && error.status === 409)) throw error;
    }
  }
  const policy = { kind: "confidence", threshold: autoAcceptThreshold, version: discoveryPolicyVersion, reviewWindow: { until: "end-of-day", timezone } };
  const opened = await call("batch.open", { title, purpose: "What Forerunner found today.", source, policy });
  return { ...opened, policy: "confidence" as const };
}
async function savedBefore(db: Database, who: AppIdentity, id: string) {
  const [row] = await db.select({ id: discoveryRecords.id }).from(discoveryRecords)
    .where(and(scope(who), eq(discoveryRecords.kind, "preview"), ne(discoveryRecords.id, id), sql`json_extract(${discoveryRecords.data}, '$.receipt') IS NOT NULL`))
    .limit(1);
  return !!row;
}
function batchSummary(preview: Preview) {
  const added = preview.entries.filter((e) => !e.existing);
  const records = added.filter((e) => e.kind !== "Proposed relationship").length;
  return `Forerunner found ${records} new ${records === 1 ? "record" : "records"} and ${added.length - records} ${added.length - records === 1 ? "relationship" : "relationships"} in ${preview.sources.map((s) => s.label).join(", ")}.`.slice(0, 2000);
}

/**
 * Settles a run's `suggestions` step: a saved daily run makes suggestions, any other run
 * skips it. A registered task owns its run and completion, so it is left alone.
 */
function suggestionsStep(db: Database, who: AppIdentity, host: Host, runId: string, options: RunOptions) {
  return async (saved: Preview | null = null, status: "skipped" | "failed" = "skipped") => {
    if (options.taskId) return;
    if (saved && options.trigger === "schedule") await generateSuggestions(db, who, host, runId, saved);
    else await skipSuggestions(host, runId, status);
  };
}

/** Every attempt is retained privately, including failures before a preview exists. */
/** A scheduled run: the reserved workflow run id and the schedule's one connection. */
export type RunOptions = { runId?: string; connection?: SourceConnection; trigger?: "manual" | "schedule"; taskId?: string; progress?: (event: Record<string, unknown>) => Promise<void> };
export async function previewDiscovery(db: Database, who: AppIdentity, host: Host, input: z.input<typeof previewInput>, save = false, options: RunOptions = {}) {
  requireEditor(who);
  const id = crypto.randomUUID(), startedAt = new Date().toISOString();
  const run: Record<string, unknown> = { id, startedAt, status: "preparing", owner: who.owner, sources: input.sources, trigger: options.trigger ?? "manual", ...(options.taskId ? {taskId:options.taskId} : {}), stages: [] };
  await db.insert(discoveryRecords).values({ id, installationId: who.installationId, ownerId: who.userId, kind: "run", data: JSON.stringify(run), createdAt: Date.now() });
  const where = and(scope(who), eq(discoveryRecords.id, id));
  // Workflows can cancel a run: it is marked failed there, and the run stops at its next step.
  const canceled = async () => {
    const [stored] = await db.select({ data: discoveryRecords.data }).from(discoveryRecords).where(where);
    return Boolean(stored && JSON.parse(stored.data).canceledAt);
  };
  const diagnostic = async (event: Record<string, unknown>) => {
    if (await canceled()) throw new Response("Canceled.", { status: 409 });
    Object.assign(run, event, { updatedAt: new Date().toISOString() });
    (run.stages as unknown[]).push({ at: run.updatedAt, status: event.status });
    await db.update(discoveryRecords).set({ data: JSON.stringify(run) }).where(where);
    await options.progress?.(event);
  };
  // The workflow run behind the model answers: analyze, then suggestions after a saved daily run.
  // A registered task owns its run and completion, so it never settles the suggestions step.
  const runId = options.runId ?? crypto.randomUUID();
  const settleSuggestions = suggestionsStep(db, who, host, runId, options);
  try {
    const preview = await prepareDiscovery(db, who, host, input, diagnostic, { ...options, runId });
    if (!save) {
      await settleSuggestions();
      return preview;
    }
    await diagnostic({ status: "saving" });
    const saved = await saveDiscovery(db, who, host, { previewId: preview.id, confirmDestination: true, timezone: input.timezone });
    await diagnostic({ status: "complete", savedAt: saved.savedAt });
    if (run.workflowRunId) await host.call("session.append",{runId:String(run.workflowRunId),entry:{id:"discovery.saved",parentId:"analysis.result",kind:"result",step:"save",at:new Date().toISOString(),data:JSON.parse(JSON.stringify({status:"complete",receipt:saved.receipt,savedAt:saved.savedAt,trigger:options.trigger ?? "manual"}))}});
    await settleSuggestions(preview);
    return saved;
  }
  catch (error) {
    await settleSuggestions(null, "failed");
    if (await canceled()) throw error;
    const failedWhile = run.status;
    const message = error instanceof Response ? await error.clone().text() : `An unexpected error${error instanceof Error ? ` (${error.name})` : ""}. Run discovery again.`;
    await diagnostic({ status: "failed", failedWhile, error: message || "No reason was given. Run discovery again." });
    throw error;
  }
}
export async function discoveryRuns(db: Database, who: AppIdentity, id?: string) {
  requireEditor(who);
  const rows = await db.select().from(discoveryRecords).where(and(scope(who), id ? eq(discoveryRecords.id, id) : undefined)).orderBy(desc(discoveryRecords.createdAt)).limit(id ? 1 : 60);
  const runs = rows.filter(r => r.kind === "run").map(r => JSON.parse(r.data));
  const previews = rows.filter(r => r.kind === "preview").map(r => JSON.parse(r.data));
  const referenced = new Set(runs.map(r => r.previewId));
  const legacy = previews.filter(p => !referenced.has(p.id)).map(p => ({ ...p, status: "complete", startedAt: p.createdAt, legacy: true, note: "Earlier preview: retained prompt and proposal only. Original model inputs, output and failed attempts were not recorded." }));
  const all = [...runs, ...legacy].sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  if (id) {
    if (!all[0]) throw new Response("Run not found", { status:404 });
    const run = all[0];
    if (run.previewId) {
      const preview = JSON.parse((await own(db, who, String(run.previewId), "preview")).data);
      return { ...run, saveReceipt: preview.receipt ?? null };
    }
    return run;
  }
  return all.slice(0,20).map(r => ({ id:r.id, startedAt:r.startedAt, status:r.status, legacy:!!r.legacy, stages:r.stages ?? [] }));
}

/** User-facing history uses the same private owner scope as discovery, not developer standing. */
export async function discoveryActivity(db: Database, who: AppIdentity, id?: string) {
  requireEditor(who);
  if (id) return activityDetail(db, who, id);
  const rows = await db.select().from(discoveryRecords).where(scope(who))
    .orderBy(desc(discoveryRecords.createdAt)).limit(201);
  const retained = rows.slice(0, 200);
  return { events: activityEvents(retained), truncated: rows.length > 200 };
}

async function activityDetail(db: Database, who: AppIdentity, id: string) {
    const candidate = await discoveryRuns(db, who, id) as Record<string, unknown>;
    const records = candidate.legacy ? await db.select().from(discoveryRecords).where(and(scope(who), eq(discoveryRecords.kind, "run"))).orderBy(desc(discoveryRecords.createdAt)).limit(200) : [];
    const linked = records.map(r => JSON.parse(r.data)).find(r => r.previewId === id);
    const run = linked ?? candidate;
    const preview = run.previewId || run.legacy ? await getPreview(db, who, String(run.previewId ?? run.id)) : null;
    return { run: {
      id: run.id, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt,
      trigger: run.trigger, systemPrompt: run.systemPrompt, input: run.input, output: run.output,
      error: run.error, failedWhile: run.failedWhile, stages: run.stages, warnings: run.warnings,
      workflowRunId: run.workflowRunId, note: run.note,
      analysisBatchCount:run.analysisBatchCount,analysisBatchesCompleted:run.analysisBatchesCompleted,
    }, preview };
}

function activityEvents(retained: { id: string; kind: string; data: string; createdAt: number }[]) {
  const previews = new Map(retained.filter(r => r.kind === "preview").map(r => [r.id, JSON.parse(r.data)]));
  const runs = retained.filter(r => r.kind === "run").map(r => JSON.parse(r.data));
  const referenced = new Set(runs.map(r => r.previewId));
  const events: { id: string; at: string; kind: string; title: string; detail: string; runId?: string; status?: string }[] = [];
  events.push(...runs.map(run => activityRunEvent(run, previews.get(run.previewId))));
  for (const [id, preview] of previews) {
    const runId = runs.find(r => r.previewId === id)?.id ?? id;
    if (!referenced.has(id)) events.push({ id, at: preview.createdAt, kind: "run", title: "Discovery", detail: "Earlier discovery proposal", runId, status: preview.receipt ? "Saved" : "Ready to review" });
    if (preview.savedAt) events.push({ id: `saved:${id}`, at: preview.savedAt, kind: "saved", title: "Suggestions saved", detail: `${preview.operations.length} graph changes accepted`, runId });
  }
  for (const row of retained.filter(r => r.kind === "sample")) {
    const sample = JSON.parse(row.data);
    events.push({ id: row.id, at: new Date(row.createdAt).toISOString(), kind: "import", title: "Source sample imported", detail: `${sample.provider} · ${sample.account} · ${sample.records.length} records` });
  }
  return events.sort((a,b) => b.at.localeCompare(a.at));
}

/** One run in History: its state, what it read and what it changed. `stage` is the step a running run is on. */
function activityRunEvent(run: Record<string, string>, preview?: Preview) {
  const running = !["complete", "failed"].includes(run.status);
  return { id: run.id, at: run.startedAt, kind: "run", title: run.trigger === "schedule" ? "Daily discovery" : "Discovery", runId: run.id,
    status: preview?.receipt ? "Saved" : run.status === "complete" ? "Ready to review" : run.status === "failed" ? "Failed" : "Running",
    ...(running ? { stage: run.status } : {}),
    detail: preview ? runDetail(preview) : run.status === "failed" ? `Failed${run.failedWhile ? ` while ${run.failedWhile}` : ""}. Open to see why.` : "Open to follow this run" };
}
function runDetail(preview: Preview) {
  const read = preview.sources.reduce((n, s) => n + (s.count ?? 0), 0);
  const proposed = preview.entries.filter(e => !e.existing).length;
  const receipt = preview.receipt as { waiting?: string[] } | undefined;
  const waiting = receipt?.waiting?.length ?? 0;
  const where = [...new Set(preview.sources.map(s => { const key = s.label.split(" · ")[0]; return key === "google-calendar" ? "Calendar" : providerName(key); }))].join(", ");
  const changes = `${proposed} ${proposed === 1 ? "change" : "changes"}${waiting ? `, ${waiting} waiting for review` : ""}`;
  return `${read} ${read === 1 ? "item" : "items"} read · ${changes} · ${where}`;
}

export async function updatePreview(db: Database, who: AppIdentity, preview: Preview) {
  requireEditor(who);
  await own(db, who, preview.id, "preview");
  await db.update(discoveryRecords).set({ data: JSON.stringify(preview) }).where(and(scope(who), eq(discoveryRecords.id, preview.id)));
  return preview;
}

/** One thing a saved run added to or matched in the Wiki, for the Knowledge graph index. */
export type DiscoveredEntity = {
  id: string;
  title: string;
  kind: string;
  /** The providers of the run that found it: "Gmail", "Google Calendar", "GitHub", "Slack" or "Saved sample". */
  foundIn: string[];
  /** Relationships the same run proposed on it. */
  links: number;
  addedAt: string;
  /** Pending: its batch operation still waits on the Wiki's Changes page. */
  status: "pending" | "accepted";
  runId: string;
  wikiSlug: string;
  /** The Wiki batch it waits in, for a pending row: its review page is where it can be seen. */
  batchId?: string;
};

/** "gmail · me@example.test" → "Gmail"; a label without a provider stays as it is. */
const labelProvider = (label: string) => {
  const key = label.split(" · ")[0];
  return isProvider(key) ? discoveryProviders[key].name : label.includes(" · ") ? "Saved sample" : label;
};

/**
 * Everything discovery has saved, newest first, one row per Wiki record.
 * A record is attributed to the newest run that created it, or failing that
 * the newest run that matched it. Pending comes from the batch as it stands
 * now, read from the Wiki, so an approval on its Changes page shows here;
 * when the Wiki cannot be read the receipt saved with the run stands in.
 */
export async function discoveredEntities(db: Database, who: AppIdentity, host: Host) {
  requireEditor(who);
  const rows = await db.select().from(discoveryRecords).where(and(scope(who), eq(discoveryRecords.kind, "preview")))
    .orderBy(desc(discoveryRecords.createdAt)).limit(120);
  const saved = rows.map((row) => JSON.parse(row.data) as Preview)
    .filter((preview) => preview.version === DISCOVERY_PREVIEW_VERSION && preview.savedAt && Array.isArray(preview.entries));
  const waiting = await waitingNow(host, saved);
  const byId = new Map<string, DiscoveredEntity>();
  const created = new Set<string>();
  for (const preview of saved) {
    for (const entity of entitiesOf(preview, waiting)) {
      // Previews are newest first: a creating run wins over any mention, and
      // between mentions or between creating runs the newest wins.
      if (byId.has(entity.id) && (created.has(entity.id) || entity.existing)) continue;
      byId.set(entity.id, entity.row);
      if (!entity.existing) created.add(entity.id);
    }
  }
  // A mention seen first keeps a Map slot, so order by when each was added.
  return { entities: [...byId.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt)) };
}

/** The rows one saved run contributes, skipping relationship entries. */
function entitiesOf(preview: Preview, waiting: Set<string>) {
  const foundIn = [...new Set((preview.sources ?? []).map((source) => labelProvider(source.label)))];
  const edges = (preview.operations ?? []).filter((op) => op.type === "graph-edge");
  return preview.entries.flatMap((entry) => {
    const id = entry.id;
    if (!id || entry.kind === "Proposed relationship") return [];
    const row: DiscoveredEntity = {
      id, title: entry.title, kind: entry.kind, foundIn,
      links: edges.filter((op) => op.attributes.fromId === id || op.attributes.toId === id).length,
      addedAt: preview.savedAt as string, status: waiting.has(id) ? "pending" : "accepted",
      runId: preview.id, wikiSlug: preview.wikiSlug,
      ...(waiting.has(id) && preview.batch ? { batchId: preview.batch.batchId } : {}),
    };
    return [{ id, existing: entry.existing, row }];
  });
}

/**
 * The record ids still awaiting review across the saved runs' batches, read
 * from the Wiki now. A batch that cannot be read keeps the ids its run saved.
 */
async function waitingNow(host: Host, saved: Preview[]) {
  const waiting = new Set<string>();
  const seen = new Set<string>();
  for (const preview of saved) {
    const receipt = preview.receipt as { waiting?: string[] } | undefined;
    if (!preview.batch || !receipt?.waiting?.length || seen.has(preview.batch.batchId)) continue;
    seen.add(preview.batch.batchId);
    let ids = receipt.waiting;
    if (seen.size <= 8) {
      try {
        const current = (await host.call("actions.call", { installationId: preview.batch.installationId, action: "batch.get", input: { batchId: preview.batch.batchId } as never })) as unknown as Batch;
        ids = (current.operations ?? []).filter((op) => op.state === "awaiting_review").map((op) => String(op.operation.attributes?.id ?? op.ref));
      } catch {
        // The saved receipt stands in until the Wiki answers again.
      }
    }
    for (const id of ids) waiting.add(id);
  }
  return waiting;
}
