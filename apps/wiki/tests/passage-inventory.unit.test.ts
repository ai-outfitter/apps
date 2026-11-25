import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "../src/documents/graphql";
import { passageActions } from "../src/documents/passages";

test("bounded inventory resumes through unsupported assets and reaches published pages", async () => {
  const page = { pageId: "page-id", pageSlug: "example", pageRevision: 1, documentId: "doc-id", revision: 1 };
  const files = Array.from({ length: 401 }, (_, index) => {
    const sha256 = index.toString(16).padStart(64, "0");
    const file = index === 400 ? "interview.vtt" : "photo.png";
    return { key: `${page.pageId}/${sha256}-${file}`, sha256, contentType: index === 400 ? "text/vtt" : "image/png", size: 20 };
  });
  let queries = 0;
  const identity = { userId: "reader", installationId: "wiki-id", organizationId: "org-id", role: "member", canEdit: false };
  const context = {
    identity, actor: { kind: "member", id: "reader" }, originActor: { kind: "member", id: "reader" },
    database: { query: async () => [page] },
    storage: () => ({
      async list(_scope: string, { after, limit }: { after: string; limit: number }) {
        queries++;
        return files.filter(file => file.key > after).slice(0, limit);
      },
    }),
  } as unknown as Context;
  const list = passageActions["passage.sources"];
  const first = await list.invoke(context, { limit: 1 }) as { sources: { sourceId: string }[]; next: string | null };
  assert.equal(queries, 4);
  assert.deepEqual(first.sources, []);
  assert.equal(first.next, `file:${files[399].key}`);

  const second = await list.invoke(context, { after: first.next!, limit: 1 }) as typeof first;
  assert.equal(queries, 5);
  assert.deepEqual(second.sources.map(item => item.sourceId), [`file:${files[400].key}`]);
  assert.equal(second.next, second.sources[0].sourceId);

  const last = await list.invoke(context, { after: second.next!, limit: 1 }) as typeof first;
  assert.deepEqual(last.sources.map(item => item.sourceId), ["page:page-id"]);
  assert.equal(last.next, null);
});
