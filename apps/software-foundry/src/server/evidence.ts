import { type ActionContext, canonicalActionValue, defineAction } from "@ai-outfitter/app-sdk/actions";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { storage, type StorageLocals } from "@ai-outfitter/app-sdk/storage";
import { z } from "zod";
import { imageDimensions } from "./workspace/image-dimensions";

/** Story-test evidence bundles live in this installation's `evidence` space
 * under `<bundle>/<path>`, beside the per-run screenshots in `runs`
 * (docs/release-artifacts.md, "Evidence bundles from story tests"). */
const bundleSpace = "evidence";
const bundleName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const bundlePath = z.string().regex(/^(?:images\/[a-z0-9][a-z0-9_-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|json)$/);
const contentTypes = { png: "image/png", json: "application/json" } as const;

export const evidencePublishInput = z.strictObject({
  bundle: bundleName,
  path: bundlePath,
  contentType: z.enum(Object.values(contentTypes)),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  base64: z.base64().min(1).max(4_000_000),
  // Public like Foundry's run screenshots, so Planning and Wiki pages on other
  // origins can show them; "organization" keeps a file to signed-in members.
  visibility: z.enum(["organization", "public"]).default("public"),
});
export const evidencePublishOutput = z.object({
  bundle: z.string(), path: z.string(), url: z.string(), sha256: z.string(), size: z.number(), expiresAt: z.number().nullable(),
});

type EvidenceContext = ActionContext & { storageLocals?: StorageLocals; origin: string };

/** Admits one file of a bundle: its extension and declared type must agree, and a PNG must carry a valid header. */
export function admitEvidenceFile(input: z.output<typeof evidencePublishInput>) {
  const extension = input.path.slice(input.path.lastIndexOf(".") + 1) as keyof typeof contentTypes;
  if (contentTypes[extension] !== input.contentType) throw new Response("The file extension and content type disagree", { status: 422 });
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length) throw new Response("Empty file", { status: 422 });
  // Full-page screenshots exceed the run-screenshot cap; the input already bounds the size.
  if (input.contentType === "image/png") imageDimensions(bytes, { maxBytes: Number.POSITIVE_INFINITY });
  else {
    try { JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Response("Not a JSON document", { status: 422 }); }
  }
  return bytes;
}

/** Pin a path before any object write, including legacy publication. Concurrent
 * uploads can agree on the same bytes, but cannot replace them with another asset. */
async function pinEvidencePath(context:EvidenceContext,input:z.output<typeof evidencePublishInput>,size:number){
  const host=context.storageLocals?.storage;
  const identity=host?.identity;
  if(!host || !identity)throw new Response("Evidence storage unavailable",{status:503});
  const db=host.database();
  const value={path:input.path,contentType:input.contentType,sha256:input.sha256,size,visibility:input.visibility};
  const now=Date.now();
  await db.query({sql:`INSERT INTO foundry_release_evidence_uploads (key,token,installationId,createdBy,actor,originActor,bundle,path,metadata,fingerprint,expiresAt,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,params:[crypto.randomUUID(),crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-",""),identity.installationId,identity.userId,JSON.stringify(context.actor ?? {kind:"member",id:identity.userId}),JSON.stringify(context.originActor ?? {kind:"member",id:identity.userId}),input.bundle,input.path,JSON.stringify(value),await sha256Hex(canonicalActionValue({bundle:input.bundle,...value})),now,now]});
  const [row]=await db.query({sql:"SELECT metadata FROM foundry_release_evidence_uploads WHERE bundle=? AND path=?",params:[input.bundle,input.path]});
  const expected=row && JSON.parse(String(row.metadata));
  if(!expected || Object.entries(value).some(([key,value])=>expected[key]!==value))throw new Response("This bundle path is reserved for different evidence; publish a new bundle",{status:409});
}

/** An action, not a document: a file's base64 bytes (up to 4 MB) exceed a mutation's 256 KiB
 * variables. scripts/evidence-bundle.mjs reaches it through the platform's evidence route. */
export const evidenceActions = {
  "evidence.publish": defineAction({
    description: "Store one file of a product revision evidence bundle (a screenshot, manifest or receipt captured by story tests) in this installation's evidence storage for one year, public by default, and return its URL. The caller supplies the bundle name, the file's path inside it, its content type, SHA-256 and base64 bytes; the digest is verified before storage. Re-sending identical bytes returns the stored file; different bytes under an already published path are refused (409). Publishing a file records what was captured; it is not an evaluation or approval.",
    access: "write",
    input: evidencePublishInput,
    output: evidencePublishOutput,
    async run(context: EvidenceContext, input) {
      if (!context.storageLocals) throw new Response("This app has no storage configured", { status: 503 });
      const files = storage(context.storageLocals, "main");
      const target = { space: bundleSpace, key: `${input.bundle}/${input.path}` };
      // Bundle files are pinned by digest in Wiki records: a re-publish of the same
      // bytes is a no-op, different bytes under a published path are refused.
      const existing = await files.head(target);
      if (existing && existing.sha256 !== input.sha256) throw new Response("This bundle path already holds different bytes; publish a new bundle", { status: 409 });
      if(existing && (existing.contentType!==input.contentType || existing.visibility!==input.visibility))throw new Response("Published evidence metadata differs; use a new bundle",{status:409});
      let ref = existing;
      if (!ref) {
        const bytes = admitEvidenceFile(input);
        if (await sha256Hex(bytes) !== input.sha256) throw new Response("The file's digest does not match sha256", { status: 422 });
        await pinEvidencePath(context,input,bytes.byteLength);
        ref = await files.put(target.space, target.key, bytes, { contentType: input.contentType, ttl: "1y", visibility: input.visibility });
      }
      return { bundle: input.bundle, path: input.path, url: new URL(files.url(ref), context.origin).href, sha256: ref.sha256, size: ref.size, expiresAt: ref.expiresAt };
    },
  }),
};
