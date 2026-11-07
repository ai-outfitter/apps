import {
  defineAction,
  type ActionContext,
} from "@ai-outfitter/app-sdk/actions";
import type {
  AgentDatabase,
  AgentStatement,
} from "@ai-outfitter/app-sdk/agent-store";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { obsidianLinks } from "./markdown";
import { documentHost, scopeOf } from "../documents/integration";
import {
  evaluatePolicy,
  getRevision,
  requireExportReadiness,
  type Host,
  type Scope,
} from "../documents/service";

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
const stmt = (sql: string, ...params: unknown[]): AgentStatement => ({
  sql,
  params,
});
const id = z.string().min(1).max(128),
  sha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine((v) => !v.includes(".."));
const path = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (v) =>
      v
        .split("/")
        .every(
          (p) =>
            p && p !== "." && p !== ".." && !p.toLowerCase().startsWith(".git"),
        ) &&
      !v.includes("\\") &&
      !v.toLowerCase().startsWith(".github/workflows/"),
  );
export const exportInput = z.strictObject({
  publicationId: id,
  documentId: id,
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  readConnectionId: id,
  writeConnectionId: id,
  resource: id,
  repository,
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  baseSha: sha,
  path,
  period: z
    .strictObject({
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    })
    .refine((p) => Date.parse(p.start) < Date.parse(p.end))
    .optional(),
  format: z.enum(["markdown", "obsidian"]).default("markdown"),
  frontmatter: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
      z.union([
        z.string().max(1000),
        z.number(),
        z.boolean(),
        z.array(z.string().max(200)).max(32),
      ]),
    )
    .refine((v) => Object.keys(v).length <= 32)
    .optional(),
  vaultLinks: z
    .array(
      z.strictObject({
        url: z.url().max(2000),
        path: z
          .string()
          .min(1)
          .max(400)
          .refine(
            (v) =>
              !/[\[\]|\r\n]/.test(v) &&
              v.split("/").every((p) => p && p !== "." && p !== ".."),
          ),
      }),
    )
    .max(100)
    .optional(),
});
type Input = z.input<typeof exportInput>;
type InteractiveHost = WorkflowHost<"interactive">;
const fail = (s: string): never => {
  throw new Response(s, { status: 409 });
};
const read = async (db: AgentDatabase, sql: string, ...params: unknown[]) =>
  (await db.query(stmt(sql, ...params)))[0];
const guard = (sql: string, ...params: unknown[]) =>
  stmt(
    `INSERT INTO document_guards(id,ok) VALUES (?, CASE WHEN (${sql}) THEN 1 ELSE 0 END)`,
    crypto.randomUUID(),
    ...params,
  );
const cleanup = stmt("DELETE FROM document_guards");

/** Render stable, traceable Obsidian-compatible Markdown; captured evidence stays explicit. */
export function renderDocument(
  input: Input,
  revision: Awaited<ReturnType<typeof getRevision>>,
) {
  const payload = revision.payload as {
    document?: { title?: unknown; markdown?: unknown };
    provenance?: { period?: unknown };
  } | null;
  const storedPeriod = payload?.provenance?.period ?? null;
  const meta = {
    ...(input.frontmatter ? { custom: input.frontmatter } : {}),
    document: input.documentId,
    revision: revision.revision,
    digest: revision.digest,
    period: storedPeriod,
    sources: revision.capture.sources.map(({ provider, provenance }) => ({
      provider,
      provenance,
    })),
  };
  const front = Object.entries(meta)
    .map(([key, value]) => `${key}: ${canonical(value)}`)
    .join("\n");
  const title =
    typeof payload?.document?.title === "string"
      ? payload.document.title
      : input.documentId;
  let markdown =
    typeof payload?.document?.markdown === "string"
      ? payload.document.markdown
      : `\`\`\`json\n${canonical(revision.payload)}\n\`\`\``;
  if (input.format === "obsidian" && input.vaultLinks?.length) {
    const mappings = new Map(
      input.vaultLinks.map((link) => [link.url, link.path]),
    );
    markdown = obsidianLinks(markdown, mappings);
  }
  const body = markdown.trimStart().startsWith("# ")
    ? markdown
    : `# ${title.replace(/[\r\n]/g, " ")}\n\n${markdown}`;
  // JSON is valid YAML for metadata values; both formats retain ordinary portable Markdown.
  return `---\n${front}\n---\n\n${body}\n`;
}

/** Recheck both current disclosure authorization and exact revision policy each time before a write. */
export async function prepareExport(
  db: AgentDatabase,
  scope: Scope,
  host: Host,
  raw: Input,
) {
  const input = exportInput.parse(raw),
    revision = await getRevision(db, scope, input.documentId, input.revision);
  const capturedPeriod =
    (revision.payload as { provenance?: { period?: unknown } } | null)
      ?.provenance?.period ?? null;
  if (input.period && canonical(input.period) !== canonical(capturedPeriod))
    fail("Export period differs from the captured document period");
  await requireExportReadiness(db, scope, input.documentId, input.revision);
  if (
    !revision.complete ||
    !revision.capture.complete ||
    revision.capture.errors.length ||
    revision.digest !== input.digest
  )
    fail("Revision or source capture incomplete or changed");
  if (!(await host.verifyCapture(revision.capture)))
    fail("Current source authorization or captured evidence unavailable");
  const policy = await evaluatePolicy(
    db,
    scope,
    input.documentId,
    input.revision,
    "publish",
    host,
  );
  if (policy.decision !== "allow")
    fail("Current publication policy did not allow this revision");
  const markdown = renderDocument(input, revision),
    contentDigest = await sha256Hex(markdown);
  return { markdown, contentDigest, revision, input };
}

/** Claim before dispatch. A crash or lost response is an unknown outcome, never an automatic repeat. */
async function transition(
  db: AgentDatabase,
  scope: Scope,
  prepared: Awaited<ReturnType<typeof prepareExport>>,
  from: string,
  to: string,
) {
  const { input, revision } = prepared,
    publicationId = input.publicationId;
  // Fence the local head and required seal in the same transaction as claiming
  // the external write; a new generation must not supersede the checked revision.
  await db.batch([
    guard(
      `EXISTS(SELECT 1 FROM document_publications WHERE owner=? AND id=? AND state=?) AND EXISTS(
    SELECT 1 FROM document_heads h JOIN document_revisions r ON r.owner=h.owner AND r.document_id=h.id AND r.revision=h.revision
    JOIN document_definitions d ON d.owner=r.owner AND d.id=r.definition_id AND d.version=r.definition_version
    WHERE h.owner=? AND h.id=? AND h.revision=? AND h.definition_id=r.definition_id AND h.definition_version=r.definition_version
    AND r.digest=? AND r.complete=1 AND r.definition_id=? AND r.definition_version=?
    AND (COALESCE(json_extract(d.definition,'$.contract.requirements.seal'),0)=0 OR EXISTS(
      SELECT 1 FROM document_seals s WHERE s.owner=r.owner AND s.document_id=r.document_id AND s.revision=r.revision AND s.digest=r.digest)))`,
      scope.owner,
      publicationId,
      from,
      scope.owner,
      input.documentId,
      input.revision,
      input.digest,
      revision.definitionId,
      revision.definitionVersion,
    ),
    stmt(
      "UPDATE document_publications SET state=? WHERE owner=? AND id=? AND state=?",
      to,
      scope.owner,
      publicationId,
      from,
    ),
    cleanup,
  ]);
}
export async function publishGithub(
  db: AgentDatabase,
  scope: Scope,
  host: InteractiveHost,
  documentAccess: Host,
  raw: Input,
) {
  const prepared = await prepareExport(db, scope, documentAccess, raw),
    { input, markdown, contentDigest } = prepared;
  const binding = canonical({ ...input, contentDigest }),
    key = (await sha256Hex(`${scope.owner}:${input.publicationId}`)).slice(
      0,
      32,
    );
  const branch = `outfitter/document-${key}`;
  const metadata = z
    .object({ id: z.number().int().positive(), full_name: z.string() })
    .parse(
      await host.call("repository.request", {
        connectionId: input.readConnectionId,
        method: "GET",
        path: `/repos/${input.repository}`,
      }),
    );
  if (
    String(metadata.id) !== input.resource ||
    metadata.full_name.toLowerCase() !== input.repository.toLowerCase()
  )
    fail("Repository resource does not match read repository");
  let record = await read(
    db,
    "SELECT * FROM document_publications WHERE owner=? AND id=?",
    scope.owner,
    input.publicationId,
  );
  if (record && record.binding !== binding)
    fail("Publication id conflicts with existing request");
  if (record?.state === "complete")
    return JSON.parse(String(record.pull_receipt));
  const current = await host.call("repository.request", {
    connectionId: input.readConnectionId,
    method: "GET",
    path: `/repos/${input.repository}/branches/${input.baseBranch}`,
  });
  const base = z.object({ commit: z.object({ sha }) }).parse(current);
  if (base.commit.sha !== input.baseSha) fail("Base branch changed");
  if (!record) {
    await db.batch([
      stmt(
        "INSERT INTO document_publications(owner,id,binding,state) VALUES(?,?,?,'planned')",
        scope.owner,
        input.publicationId,
        binding,
      ),
    ]);
    record = await read(
      db,
      "SELECT * FROM document_publications WHERE owner=? AND id=?",
      scope.owner,
      input.publicationId,
    );
  }
  if (!record || record.binding !== binding)
    fail("Publication id conflicts with existing request");
  if (record.state === "complete")
    return JSON.parse(String(record.pull_receipt));
  if (
    ["committing", "opening", "commit_unknown", "pull_unknown"].includes(
      String(record.state),
    )
  )
    fail("Publication outcome needs reconciliation before retry");
  if (record.state === "planned") {
    const current = await prepareExport(db, scope, documentAccess, input);
    await transition(db, scope, current, "planned", "committing");
    try {
      const result = await host.call("connector.execute", {
        connectionId: input.writeConnectionId,
        resource: input.resource,
        operation: "repositories.commit",
        input: {
          branch,
          baseSha: input.baseSha,
          expectedHeadSha: null,
          message: `Document ${input.documentId} revision ${input.revision}`,
          files: [{ path: input.path, content: markdown }],
        },
      });
      const receipt = z
        .object({
          branch: z.literal(branch),
          headSha: sha,
          treeSha: sha,
          url: z.string(),
        })
        .parse(result);
      await db.batch([
        guard(
          "EXISTS(SELECT 1 FROM document_publications WHERE owner=? AND id=? AND state='committing')",
          scope.owner,
          input.publicationId,
        ),
        stmt(
          "UPDATE document_publications SET state='committed',commit_receipt=? WHERE owner=? AND id=?",
          canonical(receipt),
          scope.owner,
          input.publicationId,
        ),
        cleanup,
      ]);
    } catch (error) {
      await db.batch([
        stmt(
          "UPDATE document_publications SET state='commit_unknown',error=? WHERE owner=? AND id=? AND state='committing'",
          String(error).slice(0, 500),
          scope.owner,
          input.publicationId,
        ),
      ]);
      throw error;
    }
  }
  record = await read(
    db,
    "SELECT * FROM document_publications WHERE owner=? AND id=?",
    scope.owner,
    input.publicationId,
  );
  if (record?.state !== "committed")
    fail("Publication is not ready for a pull request");
  // A policy or source access change during commit must stop the next write.
  const currentRevision = await prepareExport(db, scope, documentAccess, input);
  const commit = z
    .object({ branch: z.literal(branch), headSha: sha })
    .parse(JSON.parse(String(record.commit_receipt)));
  await transition(db, scope, currentRevision, "committed", "opening");
  try {
    const result = await host.call("connector.execute", {
      connectionId: input.writeConnectionId,
      resource: input.resource,
      operation: "pulls.create",
      input: {
        head: branch,
        base: input.baseBranch,
        expectedHeadOid: commit.headSha,
        title: `Document: ${input.documentId} (revision ${input.revision})`,
        body: `Review document revision ${input.digest}.\n\nPublication: ${input.publicationId}`,
        draft: true,
      },
    });
    const pull = z
      .object({
        number: z.number().int().positive(),
        html_url: z.string(),
        draft: z.literal(true),
        head: z.object({
          sha: z.literal(commit.headSha),
          ref: z.literal(branch),
        }),
        base: z.object({ ref: z.literal(input.baseBranch) }),
      })
      .parse(result);
    const receipt = {
      publicationId: input.publicationId,
      branch,
      headSha: commit.headSha,
      number: pull.number,
      url: pull.html_url,
      digest: input.digest,
      contentDigest,
    };
    await db.batch([
      guard(
        "EXISTS(SELECT 1 FROM document_publications WHERE owner=? AND id=? AND state='opening')",
        scope.owner,
        input.publicationId,
      ),
      stmt(
        "UPDATE document_publications SET state='complete',pull_receipt=? WHERE owner=? AND id=?",
        canonical(receipt),
        scope.owner,
        input.publicationId,
      ),
      cleanup,
    ]);
    return receipt;
  } catch (error) {
    await db.batch([
      stmt(
        "UPDATE document_publications SET state='pull_unknown',error=? WHERE owner=? AND id=? AND state='opening'",
        String(error).slice(0, 500),
        scope.owner,
        input.publicationId,
      ),
    ]);
    throw error;
  }
}

const admin = ({ identity }: ActionContext) =>
  identity.role
    .split(",")
    .some((role) => ["owner", "admin"].includes(role.trim()));
const directAdmin = (context: ActionContext) =>
  admin(context) &&
  context.actor.kind === "member" &&
  context.actor.id === context.identity.userId &&
  context.originActor.kind === "member" &&
  context.originActor.id === context.identity.userId;
/** Caller must mount these actions on the trusted interactive route. */
export function createExportActions(context: {
  db: () => AgentDatabase;
  host: () => InteractiveHost;
}) {
  return {
    "document.export-preview": defineAction({
      description: "Preview an authorized document revision for Git/Obsidian.",
      access: "read",
      canInvoke: admin,
      input: exportInput,
      output: z.json(),
      run: async ({ identity }, input) => {
        const p = await prepareExport(
          context.db(),
          scopeOf(identity),
          documentHost(context.host()),
          input,
        );
        return { markdown: p.markdown, contentDigest: p.contentDigest };
      },
    }),
    "document.export-publish": defineAction({
      description:
        "Create a draft pull request for the exact authorized document revision.",
      access: "write",
      canInvoke: directAdmin,
      input: exportInput,
      output: z.json(),
      run: ({ identity }, input) =>
        publishGithub(
          context.db(),
          scopeOf(identity),
          context.host(),
          documentHost(context.host()),
          input,
        ),
    }),
  };
}
