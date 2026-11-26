import { z } from "zod";
import { forgejoApiBase, type ForgejoAuthority } from "./repository-authority";

const repository = z.object({ id: z.number().int().positive(), full_name: z.string() }).loose();
const issue = z.object({ number: z.number().int().positive(), html_url: z.string(), state: z.string(),
  body: z.string().nullable().optional(), user: z.object({ id: z.number() }).nullish(), pull_request: z.unknown().optional() }).loose();
const comment = z.object({ id: z.number().int().positive(), html_url: z.string(), body: z.string().nullable().optional() }).loose();
const marker = z.string().regex(/^[a-z0-9][a-z0-9:-]{7,119}$/i).transform((value) => value.toLowerCase());
const text = z.string().max(65_536);
const requestMarker = (value: string) => `<!-- outfitter-request:${value} -->`;
/** Forgejo's largest page. */
const page = 50;
const unavailable = () => new Response("Forgejo connection is unavailable", { status: 403 });

async function request(authority: ForgejoAuthority, path: string, body?: unknown, signal = AbortSignal.timeout(15_000)) {
  const response = await fetch(`${forgejoApiBase(authority)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    signal,
    headers: { Authorization: `token ${authority.token}`, Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Response("Forgejo request failed", { status: response.status === 404 ? 404 : 502 });
  }
  return response;
}

async function call(authority: ForgejoAuthority, path: string, body?: unknown) {
  return (await request(authority, path, body)).json();
}

class ForgejoReadLimit extends Error {}

const upstream = () => new Response("Forgejo returned incomplete or invalid data", { status: 502 });

/** Consume provider data within a byte limit, including responses without a Content-Length. */
function readForgejo(authority: ForgejoAuthority, prefix: string) {
  const signal = AbortSignal.timeout(20_000);
  return async <S extends z.ZodType>(suffix: string, schema: S, maxBytes = 256 * 1024) => {
    try {
      const response = await request(authority, prefix + suffix, undefined, signal);
      const bytes = new Uint8Array(maxBytes);
      let size = 0;
      if (!response.body) throw upstream();
      for await (const chunk of response.body) {
        if (size + chunk.length > maxBytes) throw new ForgejoReadLimit();
        bytes.set(chunk, size);
        size += chunk.length;
      }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      return { data: schema.parse(value), headers: response.headers };
    } catch (error) {
      if (error instanceof Response || error instanceof ForgejoReadLimit) throw error;
      throw upstream();
    }
  };
}

type RepositoryRead = ReturnType<typeof readForgejo>;
type CoveredRepository = { id: number; name: string };
const emptyInput = z.strictObject({});
const author = z.object({ id: z.number().int().positive() });
const listedIssue = issue.extend({ user: author.nullable(), body: z.string(), state: z.enum(["open", "closed"]) });
const reconciliationLimit = 300;

function operationInput<S extends z.ZodType>(schema: S, raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Response("Invalid Forgejo operation input", { status: 400 });
  return parsed.data;
}

async function repositoryMetadata<S extends z.ZodType>(read: RepositoryRead, repo: CoveredRepository, schema: S) {
  const { data } = await read("", z.intersection(repository, schema));
  if (data.id !== repo.id || data.full_name.toLowerCase() !== repo.name) throw unavailable();
  return data;
}

function providerTotal(headers: Headers) {
  const value = headers.get("x-total-count");
  const total = value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(total)) throw upstream();
  return total;
}

async function forgejoBot(read: RepositoryRead, authority: ForgejoAuthority) {
  const { data } = await read("/user", author.extend({ login: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,254}$/i) }));
  if (data.id !== authority.botUserId) throw unavailable();
  return data;
}

const tokenRecord = z.object({
  id: z.number().int().positive(),
  token_last_eight: z.string(),
  scopes: z.array(z.string()),
  repositories: z.array(z.object({ id: z.number().int().positive() })).nullish(),
});

async function requireIssueWriteScope(read: RepositoryRead, authority: ForgejoAuthority, repo: CoveredRepository) {
  const denied = () => new Response("Forgejo issue write grant unavailable", { status: 403 });
  // Forgejo PATs are 40 lowercase hex characters. Its authenticated token
  // listing returns the suffix, not the secret. Require all records and a
  // unique suffix match so a different token's scope can never grant access.
  if (!/^[a-f0-9]{40}$/.test(authority.token)) throw denied();
  const bot = await forgejoBot(read, authority);
  const { data, headers } = await read(`/users/${encodeURIComponent(bot.login)}/tokens?limit=${page}&page=1`, z.array(tokenRecord).max(page));
  if (providerTotal(headers) !== data.length || new Set(data.map((token) => token.id)).size !== data.length) throw upstream();
  const matches = data.filter((token) => token.token_last_eight === authority.token.slice(-8));
  const [token] = matches;
  if (matches.length !== 1 || !token.scopes.includes("write:issue")) throw denied();
  if (token.repositories === undefined) {
    // Forgejo 11 predates per-repository PAT restrictions. A provider that
    // may support them must report its actual repository grant.
    const { data } = await read("/version", z.object({ version: z.string() }));
    if (!/^11\.\d+\.\d+(?:\+[^ ]+)?$/.test(data.version)) throw denied();
  }
  if (token.repositories && !token.repositories.some(({ id }) => id === repo.id)) throw denied();
  return bot.id;
}

async function preflightIssueCreate(authority: ForgejoAuthority, read: RepositoryRead, repo: CoveredRepository) {
  const data = await repositoryMetadata(read, repo, z.object({ has_issues: z.boolean(), archived: z.boolean(),
    external_tracker: z.object({ external_tracker_url: z.string() }).nullish() }));
  if (!data.has_issues || data.archived || data.external_tracker?.external_tracker_url) throw unavailable();
  const botUserId = await requireIssueWriteScope(readForgejo(authority, ""), authority, repo);
  // The Forgejo create route also requires issue read access on this repository.
  await read("/issues?state=all&type=issues&limit=1", z.array(z.unknown()));
  return { allowed: true, botUserId } as const;
}

async function readBotIssuePage(read: RepositoryRead, query: URLSearchParams, botUserId: number) {
  const { data, headers } = await read(`/issues?${query}`, z.array(listedIssue).max(page), 2 * 1024 * 1024);
  const total = providerTotal(headers);
  if (total > reconciliationLimit) throw upstream();
  if (data.some((item) => item.pull_request || item.user?.id !== botUserId)) throw upstream();
  return { items: data, total };
}

async function findIssueByMarker(authority: ForgejoAuthority, read: RepositoryRead, name: string, value: string) {
  // Enumerate without a keyword, which can use an asynchronous text index.
  const bot = await forgejoBot(readForgejo(authority, ""), authority);
  const filter = new URLSearchParams({ state: "all", type: "issues", created_by: bot.login, limit: String(page) });
  const seen = new Set<number>();
  const matches: z.infer<typeof listedIssue>[] = [];
  const tag = requestMarker(value);
  let expected: number | undefined;
  for (let index = 1; index <= reconciliationLimit / page && seen.size !== expected; index++) {
    filter.set("page", String(index));
    const { items, total } = await readBotIssuePage(read, filter, authority.botUserId);
    if (expected !== undefined && expected !== total) throw upstream();
    expected = total;
    const previous = seen.size;
    for (const item of items) seen.add(item.number);
    if (seen.size !== previous + items.length || seen.size > total) throw upstream();
    matches.push(...items.filter((item) => item.body.includes(tag)));
  }
  if (seen.size !== expected) throw upstream();
  if (matches.length > 1) throw new Response("More than one Forgejo issue has this marker", { status: 409 });
  const [match] = matches;
  return match ? { number: match.number, url: `${authority.origin}/${name}/issues/${match.number}`, state: match.state, created: false } : null;
}

const gitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject unusable URL path segments in provider data
const gitSegment = z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+$/)
  .refine((value) => value !== "." && value !== "..");
const entryKinds = {
  "100644": "file", "100755": "file", "040000": "directory", "120000": "symlink", "160000": "submodule",
} as const;
const treeEntry = z.object({ path: gitSegment, sha: gitObject, mode: z.enum(Object.keys(entryKinds) as (keyof typeof entryKinds)[]) });
const treePage = z.object({ sha: gitObject, truncated: z.boolean(), tree: z.array(treeEntry).nullish() });
const blob = z.object({ sha: gitObject, encoding: z.literal("base64"), content: z.string() });
const readme = /^readme(?:\.(?:md|markdown|txt|rst|adoc))?$/i;
const issueTemplate = /\.(?:md|markdown|ya?ml)$/i;
const fileLimit = 8;
const fileBytes = 8 * 1024;

async function repositoryEvidence(authority: ForgejoAuthority, read: RepositoryRead, repo: CoveredRepository) {
  const { default_branch: defaultBranch } = await repositoryMetadata(read, repo, z.object({ default_branch: z.string().min(1).max(255) }));
  const segments = z.array(gitSegment).safeParse(defaultBranch.split("/"));
  if (!segments.success) throw upstream();
  const branch = segments.data.map(encodeURIComponent).join("/");
  const { data: head } = await read(`/branches/${branch}`, z.object({ name: z.literal(defaultBranch), commit: z.object({ id: gitObject }) }));
  const commitSha = head.commit.id;
  const { data: commit } = await read(`/git/commits/${commitSha}?stat=false&verification=false&files=false`,
    z.object({ sha: z.literal(commitSha), commit: z.object({ tree: z.object({ sha: gitObject }) }) }));

  const url = `${authority.origin}/${repo.name}`;
  const sourceUrl = `${url}/src/commit/${commitSha}`;
  let truncated = false;
  let remainingFiles = fileLimit;
  const tree: { path: string; kind: (typeof entryKinds)[keyof typeof entryKinds]; url: string }[] = [];
  const files: { path: string; kind: "readme" | "issue-template"; url: string; text: string }[] = [];
  const directory = async (sha: string, prefix = "") => {
    const { data } = await read(`/git/trees/${sha}?page=1&per_page=64`, treePage);
    if (data.sha !== sha || (data.tree?.length ?? 0) > 64) throw upstream();
    truncated ||= data.truncated;
    const entries = (data.tree ?? []).map((item) => ({
      ...item, kind: entryKinds[item.mode], path: prefix + item.path,
      url: `${sourceUrl}/${prefix}${encodeURIComponent(item.path)}`,
    }));
    tree.push(...entries.map(({ path, kind, url }) => ({ path, kind, url })));
    return entries;
  };

  const addFile = async (entry: z.infer<typeof treeEntry> & { url: string }, kind: "readme" | "issue-template") => {
    if (remainingFiles === 0) {
      truncated = true;
      return;
    }
    remainingFiles--;
    const result = await read(`/git/blobs/${entry.sha}`, blob, 24 * 1024).catch((error: unknown) => {
      if (!(error instanceof ForgejoReadLimit)) throw error;
      return undefined;
    });
    if (!result) {
      truncated = true;
      return;
    }
    const { data } = result;
    if (data.sha !== entry.sha) throw upstream();
    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(atob(data.content), (character) => character.charCodeAt(0));
    } catch {
      throw upstream();
    }
    if (decoded.length > fileBytes || decoded.includes(0)) {
      truncated = true;
      return;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      truncated = true;
      return;
    }
    files.push({ path: entry.path, kind, url: entry.url, text });
  };

  const root = await directory(commit.commit.tree.sha);
  const overview = root.find((entry) => entry.kind === "file" && readme.test(entry.path));
  if (overview) await addFile(overview, "readme");

  const addSingleTemplate = async (entries: Awaited<ReturnType<typeof directory>>) => {
    const single = entries.find((entry) => entry.kind === "file" && /(?:^|\/)issue_template\.(?:md|markdown)$/i.test(entry.path));
    if (single) await addFile(single, "issue-template");
  };
  await addSingleTemplate(root);
  for (const folder of [".github", ".forgejo", ".gitea"]) {
    const settings = root.find((entry) => entry.path === folder && entry.kind === "directory");
    if (!settings) continue;
    const entries = await directory(settings.sha, `${folder}/`);
    await addSingleTemplate(entries);
    const templates = entries.find((entry) => entry.path === `${folder}/ISSUE_TEMPLATE` && entry.kind === "directory");
    if (!templates) continue;
    for (const entry of await directory(templates.sha, `${templates.path}/`)) {
      if (entry.kind === "file" && issueTemplate.test(entry.path) && !/\/config\.ya?ml$/i.test(entry.path))
        await addFile(entry, "issue-template");
    }
  }
  return { repository: { ...repo, url }, defaultBranch, commitSha, commitUrl: `${url}/commit/${commitSha}`, tree, files, truncated };
}

export async function forgejoRepositoryIdentity(authority: ForgejoAuthority, name: string) {
  return repository.parse(await call(authority, `/repos/${name}`));
}

const issueInput = {
  "issues.create": z.object({ title: z.string().trim().min(1).max(256), body: text, marker }).strict(),
  "issues.comment": z.object({ number: z.number().int().positive(), body: text, marker: marker.optional() }).strict(),
};

async function createIssue(authority: ForgejoAuthority, path: string, raw: unknown) {
  const input = issueInput["issues.create"].parse(raw);
  const tag = requestMarker(input.marker);
  const recent = z.array(issue).parse(await call(authority, `${path}/issues?state=all&type=issues&limit=${page}`));
  const found = recent.find((item) => !item.pull_request && item.user?.id === authority.botUserId && item.body?.includes(tag));
  if (found) return { number: found.number, url: found.html_url, state: found.state, created: false };
  const created = issue.parse(await call(authority, `${path}/issues`, { title: input.title, body: `${input.body}\n\n${tag}` }));
  return { number: created.number, url: created.html_url, state: created.state, created: true };
}

/** A marked comment among the issue's first pages, as the github connector looks. */
async function markedComment(authority: ForgejoAuthority, path: string, number: number, tag: string) {
  for (let index = 1; index <= 6; index++) {
    const comments = z.array(comment).parse(await call(authority, `${path}/issues/${number}/comments?limit=${page}&page=${index}`));
    const found = comments.find((item) => item.body?.includes(tag));
    if (found || comments.length < page) return found;
  }
  return undefined;
}

async function commentIssue(authority: ForgejoAuthority, path: string, raw: unknown) {
  const input = issueInput["issues.comment"].parse(raw);
  const target = issue.parse(await call(authority, `${path}/issues/${input.number}`));
  if (target.pull_request) throw new Response("Issue comment cannot target a pull request", { status: 409 });
  if (!input.marker) return comment.parse(await call(authority, `${path}/issues/${input.number}/comments`, { body: input.body }));
  const tag = requestMarker(input.marker);
  const found = await markedComment(authority, path, input.number, tag);
  if (found) return { ...found, created: false };
  return { ...comment.parse(await call(authority, `${path}/issues/${input.number}/comments`, { body: `${input.body}\n\n${tag}` })), created: true };
}

type Operation = {
  permission: "read" | "write";
  requires?: readonly string[];
  execute(authority: ForgejoAuthority, repo: CoveredRepository, input: unknown): Promise<unknown>;
};

const repositoryPath = (repo: CoveredRepository) => `/repos/${repo.name}`;

const operations = new Map<string, Operation>([
  ["repositories.evidence.read", {
    permission: "read",
    execute(authority, repo, input) {
      operationInput(emptyInput, input);
      return repositoryEvidence(authority, readForgejo(authority, repositoryPath(repo)), repo);
    },
  }],
  ["issues.preflight-create", {
    permission: "write",
    requires: ["issues.create"],
    execute(authority, repo, input) {
      operationInput(emptyInput, input);
      return preflightIssueCreate(authority, readForgejo(authority, repositoryPath(repo)), repo);
    },
  }],
  ["issues.find-by-marker", {
    permission: "read",
    execute(authority, repo, input) {
      const { marker: value } = operationInput(z.strictObject({ marker }), input);
      return findIssueByMarker(authority, readForgejo(authority, repositoryPath(repo)), repo.name, value);
    },
  }],
  ["issues.create", {
    permission: "write",
    execute: (authority, repo, input) => createIssue(authority, repositoryPath(repo), input),
  }],
  ["issues.comment", {
    permission: "write",
    execute: (authority, repo, input) => commentIssue(authority, repositoryPath(repo), input),
  }],
]);

export function forgejoOperation(name: string): Readonly<Operation> {
  const operation = operations.get(name);
  if (!operation) throw new Response("Operation is not available on Forgejo", { status: 403 });
  return operation;
}

export async function executeForgejoOperation(authority: ForgejoAuthority, repo: CoveredRepository, name: string, input: unknown) {
  try {
    return await forgejoOperation(name).execute(authority, repo, input);
  } catch (error) {
    if (error instanceof ForgejoReadLimit) throw upstream();
    throw error;
  }
}
