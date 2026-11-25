import { defineAction } from "@ai-outfitter/app-sdk/actions";
import { requireOrganization, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { wikiPassage } from "@ai-outfitter/app-sdk/graph-contracts";
import type { StorageRef } from "@ai-outfitter/app-sdk/storage";
import type { Context } from "./graphql";
import { documentDigest, getDocument } from "./store";
import { extractPassageFile, passageFormat, UnsupportedPassageFile, type Section } from "./passage-files";

const { sourceId, sourcePin: pin, passageLength, maxPassages } = wikiPassage;

type PageRow = {
  pageId: string; pageSlug: string; pageRevision: number; documentId: string | null;
  revision: number | null;
};
type Row = PageRow & {
  sourceId: string; sha256: string | null; fileName: string | null; contentType: string | null;
  fileKey: string | null; size: number | null;
};

const pageRows = `
  SELECT p.id AS pageId, p.slug AS pageSlug, p.revision AS pageRevision,
    p.documentId AS documentId, d.publishedRevision AS revision
  FROM wiki_pages p LEFT JOIN wiki_documents d ON d.id=p.documentId
  WHERE (p.documentId IS NULL OR (d.archived=0 AND d.publishedRevision IS NOT NULL))`;

async function pages(ctx: Context, condition: string, ...params: unknown[]) {
  return await ctx.database.query({ sql: `${pageRows} ${condition}`, params }) as PageRow[];
}

function pageSource(page: PageRow): Row {
  return { ...page, sourceId: `page:${page.pageId}`, sha256: null, fileName: null, contentType: null, fileKey: null, size: null };
}

function fileSource(file: StorageRef, page: PageRow | undefined): Row | null {
  if (!page) return null;
  const prefix = `${page.pageId}/${file.sha256}-`;
  if (!file.key.startsWith(prefix)) return null;
  const fileName = file.key.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(fileName) || !passageFormat(file.contentType, fileName)) return null;
  return { ...page, documentId: null, revision: null, sourceId: `file:${file.key}`,
    sha256: file.sha256, fileName, contentType: file.contentType, fileKey: file.key, size: file.size };
}

async function findSource(ctx: Context, id: string) {
  if (id.startsWith("page:")) {
    const [page] = await pages(ctx, "AND p.id=? AND p.documentId IS NOT NULL", id.slice(5));
    return page ? pageSource(page) : null;
  }
  if (!id.startsWith("file:")) return null;
  const key = id.slice(5);
  const slash = key.indexOf("/");
  if (slash < 1 || !/^[a-f0-9]{64}-[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(key.slice(slash + 1))) return null;
  const [page] = await pages(ctx, "AND p.id=?", key.slice(0, slash));
  const file = page ? await ctx.storage().head({ space: "assets", key }) : null;
  return file ? fileSource(file, page) : null;
}

const assetPageSize = 100;
const assetPagesPerCall = 4;

async function listSources(ctx: Context, after: string, limit: number) {
  const rows: Row[] = [];
  if (after < "file:" || after.startsWith("file:")) {
    let cursor = after.startsWith("file:") ? after.slice(5) : "";
    for (let scanned = 0; scanned < assetPagesPerCall; scanned++) {
      const files = await ctx.storage().list("assets", { after: cursor, limit: assetPageSize });
      if (!files.length) break;
      const pageIds = [...new Set(files.map(({ key }) => key.split("/", 1)[0]))];
      const owners = await pages(ctx, "AND p.id IN (SELECT value FROM json_each(?))", JSON.stringify(pageIds));
      const byId = new Map(owners.map(page => [page.pageId, page] as const));
      for (const file of files) {
        const source = fileSource(file, byId.get(file.key.split("/", 1)[0]));
        if (source) rows.push(source);
        if (rows.length > limit) return { rows: rows.slice(0, limit), next: rows[limit - 1].sourceId };
      }
      if (files.length < assetPageSize) break;
      cursor = files[files.length - 1].key;
      // A checkpoint may pass over unsupported or archived attachments even
      // when no extractable source was found on this inventory page.
      if (scanned + 1 === assetPagesPerCall) return { rows, next: `file:${cursor}` };
    }
  }
  if (after >= "page:" && !after.startsWith("page:")) return { rows, next: null };
  const documents = await pages(ctx, "AND p.documentId IS NOT NULL AND p.id>? ORDER BY p.id LIMIT ?", after.startsWith("page:") ? after.slice(5) : "", limit + 1 - rows.length);
  const found = [...rows, ...documents.map(pageSource)];
  return { rows: found.slice(0, limit), next: found.length > limit ? found[limit - 1].sourceId : null };
}

async function source(ctx: Context, row: Row) {
  const { sourceId, pageId, pageSlug, pageRevision, documentId, revision, sha256, fileName } = row;
  const { organizationId, installationId } = requireOrganization(ctx.identity);
  // Attachments are independently verified immutable bytes. Wiki document
  // edits and publication do not change the attachment's citation pin.
  const version = await sha256Hex(JSON.stringify(sha256
    ? [2, sourceId, pageSlug, pageRevision, sha256, row.contentType]
    : [2, sourceId, pageSlug, pageRevision, documentId, revision]));
  return { installationId, organizationId, sourceId, pageId, pageSlug, pageRevision, documentId, revision, sha256, fileName, version };
}

const maxExtractedChars = 500_000;
function passages(sections: Section[]) {
  if (sections.length > maxPassages || sections.reduce((total, item) => total + item.text.length, 0) > maxExtractedChars)
    throw new UnsupportedPassageFile("Source exceeds the extracted-text indexing limit");
  const extracted = sections.flatMap(({ text, locator }) => {
    const entries = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + passageLength, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf(" ", end);
        if (boundary > start + passageLength / 2) end = boundary;
        if (/[\ud800-\udbff]/.test(text[end - 1])) end--;
      }
      const excerpt = text.slice(start, end);
      if (excerpt.trim()) entries.push({ text: excerpt, locator: { ...locator, start, end } });
      start = end;
    }
    return entries;
  });
  if (extracted.length > maxPassages) throw new UnsupportedPassageFile("Source exceeds the passage indexing limit");
  return extracted;
}

async function read(ctx: Context, input: z.infer<typeof pin>) {
  requireOrganization(ctx.identity);
  const row = await findSource(ctx, input.sourceId);
  if (!row) return { state: "changed" as const };
  const current = await source(ctx, row);
  if (current.version !== input.version) return { state: "changed" as const };
  let contentHash = row.sha256;
  try {
    let sections: Section[];
    if (row.fileKey && row.fileName && row.contentType) {
      const format = passageFormat(row.contentType, row.fileName);
      if (!format) throw new UnsupportedPassageFile("Unsupported attachment format");
      const object = await ctx.storage().get({ space: "assets", key: row.fileKey });
      if (!object) throw new Response("Wiki attachment bytes unavailable", { status: 503 });
      const bytes = await new Response(object.body).arrayBuffer();
      if (bytes.byteLength !== row.size || object.contentType !== row.contentType || await sha256Hex(bytes) !== row.sha256)
        throw new Response("Wiki attachment bytes do not match the indexed revision", { status: 503 });
      sections = await extractPassageFile(bytes, format);
    } else {
      const doc = await getDocument(ctx.database, row.documentId!, row.revision!);
      contentHash = await documentDigest(doc);
      sections = (["title", "summary", "body", "generatedBody"] as const).map(section => ({
        text: doc[section], locator: { kind: "wiki-page", section },
      }));
    }
    if (!contentHash) throw new Response("Wiki source digest unavailable", { status: 503 });
    const extracted = passages(sections);
    return { state: "active" as const, source: { ...current, contentHash }, passages: extracted, issue: extracted.length ? null : "No extractable text" };
  } catch (error) {
    if (!(error instanceof UnsupportedPassageFile) || !contentHash) throw error;
    return { state: "active" as const, source: { ...current, contentHash }, passages: [], issue: error.message };
  }
}

export const passageActions = {
  "passage.sources": defineAction({
    description: "List published Wiki page revisions and supported attachments in installation key order.",
    access: "read",
    input: z.strictObject({ after: sourceId.optional(), limit: z.number().int().min(1).max(100).default(25) }),
    output: wikiPassage.sourceInventory,
    run: async (ctx: Context, { after, limit }) => {
      requireOrganization(ctx.identity);
      const { rows, next } = await listSources(ctx, after ?? "", limit);
      const sources = await Promise.all(rows.map(row => source(ctx, row)));
      return { organizationId: ctx.identity.organizationId!, installationId: ctx.identity.installationId,
        sources, next };
    },
  }),
  "passage.read": defineAction({
    description: "Extract passages with exact locators from one pinned Wiki source revision.",
    access: "read", input: pin, output: wikiPassage.sourceRead, run: read,
  }),
  "passage.verify": defineAction({
    description: "Verify current Wiki source revisions under the calling member's access.",
    access: "read", input: z.strictObject({ sources: z.array(pin).max(100) }), output: wikiPassage.verification,
    run: async (ctx: Context, { sources }) => {
      const { organizationId, installationId } = requireOrganization(ctx.identity);
      if (!sources.length) return { organizationId, installationId, active: [] };
      const ids = [...new Set(sources.map(pin => pin.sourceId))];
      const found = await Promise.all(ids.map(id => findSource(ctx, id)));
      const current = new Map(await Promise.all(found.flatMap(row => row ? [source(ctx, row).then(item => [item.sourceId, item.version] as const)] : [])));
      return { organizationId, installationId, active: sources.filter(pin => current.get(pin.sourceId) === pin.version).map(pin => pin.sourceId) };
    },
  }),
};
